/*
 * Monochrome Unicorn -- a web app for Zebra thermal printers.
 * Copyright (C) 2026 Tyler Whittaker
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * lcd.js -- Mode 4: watch the printer's front panel.
 *
 * The real framebuffer lives in the undocumented `display.image` SGD,
 * which returns a 240x110 1-bit BMP. It cannot be reached from a page the
 * printer serves: getvar.cgi truncates every value at its first NUL byte,
 * and a BMP has one at offset four, so the CGI hands back exactly
 * "BM\xfd\x0d" and stops. The raw port that does return it whole is not
 * something a browser can speak to. tools/lcd-shot.mjs grabs the bitmap
 * from a machine that can.
 *
 * What does come through intact is `display.text`: the same screen as a
 * 20x6 character grid, padding and all, which this mode redraws as the
 * panel would -- the menu file on screen supplying what the text leaves
 * out, and lcdfont.js the panel's own letters for its own menus --
 * unless lcd_display_helper.sh is running on a machine that can reach
 * port 9100. That copies the real bitmap into the printer's RAM each
 * second, as R:LCD.GRF, and /png hands it back; then this mode draws the
 * actual pixels instead.
 */

import { el, replaceChildren } from './ui.js';
import { readLcd, readPanelFrame, pressPanelButton, fetchStoredFile } from './printer.js';
import { n20Glyph } from './lcdfont.js';

/*
 * The panel is 240x110 pixels, and display.text is that screen as a grid
 * of characters -- but not a fixed one. It is as many columns as the
 * font in use fits across 240 pixels, and as many rows as the text
 * needs: 40 columns in A.FNT, the default, 15 in F.FNT. A WML menu picks
 * the font with <font name="X.FNT">, which applies to the whole file;
 * the printer's own menus name it as $(display.wml_font).
 *
 * Measured on a ZD500R (V74.20.23Z) by loading a menu in each font and
 * reading display.text and the panel's bitmap back; docs/printer-notes.md
 * has the lot. Each font is so many columns of a cell `floor(240 /
 * columns)` pixels wide, and `rows` lines that fit. Where the panel was
 * measured, rows are `pitch` pixels apart and their capitals `cap` tall,
 * starting `top` below the row's edge; a screen with a <nav_bar> has a
 * rule across at `rule`, clips the body above it, and puts the soft
 * keys' capitals at `nav`; `glyph` draws its characters as the panel
 * does (lcdfont.js). A font without those is laid out evenly down
 * the panel. A font the panel cannot draw -- C.FNT and E.FNT do not
 * exist, P to V are stubs -- falls back to A, and so does one missing
 * from this list.
 */
const LCD_WIDTH = 240;
const LCD_HEIGHT = 110;
const DEFAULT_FONT = 'A.FNT';
// The printer's own menu fonts, drawn from the panel's own glyphs.
const N20 = {
  columns: 20,
  rows: 6,
  pitch: 20,
  top: 3,
  cap: 14,
  rule: 85,
  nav: 90,
  glyph: n20Glyph,
};
const LCD_FONTS = {
  'A.FNT': { columns: 40, rows: 13, pitch: 9, top: 0, cap: 7, rule: 96, nav: 99 },
  'B.FNT': { columns: 26, rows: 11, pitch: 11, top: 0, cap: 11, rule: 96, nav: 99 },
  'D.FNT': { columns: 20, rows: 7, pitch: 18, top: 0, cap: 14, rule: 87, nav: 90 },
  'E6.FNT': { columns: 18, rows: 6, pitch: 21, top: 2, cap: 14, rule: 81, nav: 86 },
  'E8.FNT': { columns: 12, rows: 4 },
  'E12.FNT': { columns: 9, rows: 3 },
  'E24.FNT': { columns: 4, rows: 2 },
  'F.FNT': { columns: 15, rows: 5, pitch: 26, top: 0, cap: 21, rule: 75, nav: 78 },
  'G.FNT': { columns: 5, rows: 2 },
  'GS.FNT': { columns: 9, rows: 5 },
  'H6.FNT': { columns: 16, rows: 7, pitch: 17, top: 0, cap: 17, rule: 82, nav: 85 },
  'H8.FNT': { columns: 12, rows: 6 },
  'H12.FNT': { columns: 8, rows: 4 },
  'H24.FNT': { columns: 4, rows: 2 },
  'MONOBD15.FNT': { columns: 26, rows: 8, pitch: 15, top: 1, cap: 11, rule: 87, nav: 91 },
  'NJ20WGL4.FNT': N20,
  'NK20WGL4.FNT': N20,
  'NS20WGL4.FNT': N20,
  'NT20WGL4.FNT': N20,
  'EPL1.FNT': { columns: 24, rows: 10, pitch: 12, top: 0, cap: 10, rule: 93, nav: 95 },
  'EPL2.FNT': { columns: 20, rows: 7, pitch: 16, top: 0, cap: 14, rule: 77, nav: 79 },
  'EPL3.FNT': { columns: 17, rows: 6, pitch: 20, top: 0, cap: 16, rule: 77, nav: 79 },
  'EPL4.FNT': { columns: 15, rows: 5, pitch: 24, top: 0, cap: 20, rule: 69, nav: 71 },
  'EPL5.FNT': { columns: 6, rows: 3 },
  'EPL6.FNT': { columns: 17, rows: 6 },
  'EPL7.FNT': { columns: 11, rows: 5 },
  'EPL300-1.FNT': { columns: 20, rows: 6 },
  'EPL300-2.FNT': { columns: 15, rows: 4 },
  'EPL300-3.FNT': { columns: 12, rows: 4 },
  'EPL300-4.FNT': { columns: 10, rows: 3 },
  'EPL300-5.FNT': { columns: 2, rows: 1 },
};

/** B.FNT has no lower case: the panel draws it in capitals. */
const CAPITALS_ONLY = new Set(['B.FNT']);

/** A font's layout, or A's for one the panel does not draw. */
export function lcdFont(font) {
  return LCD_FONTS[String(font || '').toUpperCase()] || LCD_FONTS[DEFAULT_FONT];
}

/** How many columns display.text has in a font. */
export function lcdColumns(font) {
  return lcdFont(font).columns;
}

/** How many rows of a font the panel shows. */
export function lcdRows(font) {
  return lcdFont(font).rows;
}

/**
 * Where a font puts its rows, in panel pixels: the measured layout, or
 * for a font that was not measured, its rows spread evenly down the
 * panel with no rule.
 */
export function lcdGeometry(font) {
  const f = lcdFont(font);
  const cell = Math.floor(LCD_WIDTH / f.columns);
  if (f.pitch) return { ...f, cell };
  const pitch = Math.floor(LCD_HEIGHT / f.rows);
  return { ...f, cell, pitch, top: 0, cap: Math.round(pitch * 0.7), rule: null, nav: null };
}

/** The font a WML file asks for, e.g. "F.FNT", or null for the default. */
export function wmlFont(source) {
  const tag = /<font\b[^>]*\bname\s*=\s*["']([^"']+)["']/i.exec(String(source ?? ''));
  return tag ? tag[1].trim().toUpperCase() : null;
}

/**
 * Fill in the settings a WML value names, $(display.wml_font) and the
 * like, from what the LCD helper file read. null if one is not there.
 */
export function resolveWmlValue(value, values) {
  if (value == null) return null;
  let missing = false;
  const out = String(value).replace(/\$\(([^)]+)\)/g, (_, name) => {
    const v = values && values[name.trim().toLowerCase()];
    if (v == null || v === '') missing = true;
    return v ?? '';
  });
  return missing ? null : out.trim().toUpperCase();
}

/** A WML paragraph's text as a pattern, a $(setting) matching anything. */
function textPattern(text, anchored) {
  const body = text
    .split(/\$\([^)]*\)/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(anchored ? `^${body}$` : body, 'i');
}

/** The text of a run of WML, tags and runs of space taken out. */
function plainText(markup) {
  return markup
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One card's layout: whether it has a soft-key bar (and so a rule above
 * it), which paragraphs are centred or right-aligned, the icon its soft
 * keys use most, the soft-key labels drawn highlighted, every paragraph (to tell which card is on screen), and
 * its flow -- paragraphs, images and line breaks in order, for placing
 * the images. What an <if> or a <button_map> holds is left out: the
 * panel shows it only sometimes, or never.
 */
function cardLayout(src) {
  const aligned = [];
  const texts = [];
  for (const m of src.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const text = plainText(m[2]);
    if (!text) continue;
    const align = /\balign\s*=\s*["']?(center|right)/i.exec(m[1]);
    if (align) aligned.push({ align: align[1].toLowerCase(), pattern: textPattern(text, true) });
    if (/[^\s.]/.test(text.replace(/\$\([^)]*\)/g, ''))) texts.push(textPattern(text, false));
  }
  // An address being edited is drawn like a paragraph: its four numbers,
  // aligned as the tag says.
  for (const m of src.matchAll(/<ip_address\b([^>]*)>/gi)) {
    const align = /\balign\s*=\s*["']?(center|right)/i.exec(m[1]);
    if (align) aligned.push({ align: align[1].toLowerCase(), pattern: /^[\d.]+$/ });
  }

  const counts = new Map();
  for (const m of src.matchAll(/<p[12]\b[^>]*>([^<]*)<\/p[12]>/gi)) {
    const label = m[1].trim();
    if (label.length === 1 && label.charCodeAt(0) >= 0xa0) {
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  const navIcon = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const highlighted = [...src.matchAll(/<p[12]\b([^>]*)>([^<]*)<\/p[12]>/gi)]
    .filter((m) => /\bhighlight\s*=\s*["']?on/i.test(m[1]))
    .map((m) => plainText(m[2]))
    .filter((label) => label && !(label.length === 1 && label.charCodeAt(0) >= 0xa0));

  const shown = src
    .replace(/<if\b[\s\S]*?<\/if>/gi, '')
    .replace(/<button_map\b[\s\S]*?<\/button_map>/gi, '')
    .replace(/<nav_bar\b[\s\S]*?<\/nav_bar>/gi, '');
  const flow = [];
  let m3 = null;
  for (const t of shown.matchAll(/<(\/?)(p|img|br|a|ip_address)\b([^>]*)>/gi)) {
    const [, close, tag, attrs] = t;
    const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs)?.[1];
    const name = tag.toLowerCase();
    if (name === 'a') m3 = close ? null : (attr('m3') ?? null);
    else if (name === 'br') flow.push({ type: 'br' });
    else if ((name === 'p' || name === 'ip_address') && !close) flow.push({ type: 'text' });
    else if (name === 'img' && attr('src')) {
      flow.push({ type: 'img', src: attr('src'), align: (attr('align') || '').toLowerCase(), m3 });
    }
  }

  return { nav: /<nav_bar\b/i.test(src), aligned, navIcon, highlighted, texts, flow };
}

/**
 * What the panel's layout takes from a WML file besides the font, card
 * by card; and the same for the file as a whole, for when no one card
 * can be told apart. display.text says none of this: it pads a centred
 * line to the nearest column, keeps only the first byte of a soft key's
 * icon, and has nothing at all for a picture.
 */
export function wmlLayout(source) {
  const src = String(source ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const cards = [...src.matchAll(/<card\b[\s\S]*?<\/card>/gi)].map((m) => cardLayout(m[0]));
  return { ...cardLayout(src), flow: [], cards };
}

/**
 * The card on screen: the one whose paragraphs are found in the text
 * the panel shows, the most of it -- or, among cards with pictures,
 * the one whose link label the soft-key row shows. The whole file when
 * none stands out.
 */
export function pickCard(layout, rows) {
  if (!layout?.cards?.length) return layout || {};
  if (layout.cards.length === 1) return layout.cards[0];
  const screen = rows.join('\n');
  const navRow = rows[rows.length - 1] || '';
  let best = null;
  let bestScore = 0;
  for (const card of layout.cards) {
    // By how much of the screen's text a card accounts for, so that a
    // card saying WIRED IP ADDRESS beats one saying IP ADDRESS.
    let score = card.texts
      .filter((p) => p.test(screen))
      .reduce((sum, p) => sum + p.source.replace(/\.\*/g, '').length, 0);
    if (card.flow.some((f) => f.m3 && navRow.includes(f.m3))) score += 1;
    if (score > bestScore) {
      best = card;
      bestScore = score;
    }
  }
  return best || layout;
}

/**
 * Where a card's pictures go. The panel lays a card out a line at a
 * time: pictures inline from the left edge, a pixel apart, or pinned to
 * an edge by align; each at the top of its line. A line is a text row
 * tall, or as tall as its tallest picture. `sizeOf(src)` is a
 * picture's {width, height}, or null while it is not known.
 */
export function placeImages(flow, geometry, sizeOf) {
  const placed = [];
  let y = 0;
  let x = 0;
  let text = false;
  let tallest = 0;
  for (const item of flow) {
    if (item.type === 'text') text = true;
    else if (item.type === 'img') {
      const size = sizeOf(item.src);
      if (!size) continue;
      let left = x;
      if (item.align === 'left') left = 0;
      else if (item.align === 'right') left = LCD_WIDTH - size.width;
      else x += size.width + 1;
      placed.push({ src: item.src, m3: item.m3, x: left, y, ...size });
      tallest = Math.max(tallest, size.height);
    } else {
      y += Math.max(text || !tallest ? geometry.pitch : 0, tallest);
      x = 0;
      text = false;
      tallest = 0;
    }
  }
  return placed;
}

/** A 1-bit BMP as {width, height, bits}, a bit set for each dark pixel. */
export function decodeBmp(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d || view.getUint16(28, true) !== 1) return null;
  const offset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const height = Math.abs(rawHeight);
  const stride = Math.ceil(width / 32) * 4;
  // Palette entry 1's brightness says which bit is ink.
  const pal = 14 + view.getUint32(14, true);
  const darkOne = bytes[pal + 4] + bytes[pal + 5] + bytes[pal + 6] < 384;
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = offset + (rawHeight < 0 ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const bit = (bytes[row + (x >> 3)] >> (7 - (x & 7))) & 1;
      bits[y * width + x] = bit === (darkOne ? 1 : 0) ? 1 : 0;
    }
  }
  return { width, height, bits };
}

/**
 * The file on screen, from display.load_card (which follows the menus
 * as they are navigated) or else display.root_wml, as the object name
 * the web server publishes it under: "E:MENU.WML#card2" -> "MENU.WML".
 */
export function currentWmlFile(values) {
  const raw = (values && (values['display.load_card'] || values['display.root_wml'])) || '';
  const file = raw
    .split('#')[0]
    .trim()
    .replace(/^[A-Z]:/i, '');
  return (file || 'INDEX.WML').toUpperCase();
}

/*
 * Icons, as the panel draws them in its menu font (N?20WGL4): the rows
 * of the glyph, and where it sits against its cell's left edge and the
 * row's capitals. In a body line display.text has the whole character
 * (UTF-8: U+00AA is the home icon); in the soft-key row it keeps only
 * the first byte, so which icon that was comes from the WML file.
 */
const ICON_BITMAPS = {
  '\u00aa': {
    dx: 0,
    dy: -1,
    rows: [
      '.......#####.......',
      '......#######......',
      '.....#########.....',
      '....###########....',
      '...#############...',
      '..###############..',
      '.#################.',
      '###################',
      '...#############...',
      '...#############...',
      '...#############...',
      '...#####...#####...',
      '...#####...#####...',
      '...#####...#####...',
      '...#####...#####...',
      '...#####...#####...',
      '...#####...#####...',
    ],
  },
  '\u00ba': {
    dx: 1,
    dy: 1,
    rows: [
      '......###########',
      '......###########',
      '...............##',
      '....#..........##',
      '...##..........##',
      '..###..........##',
      '.############..##',
      '#############..##',
      '.############..##',
      '..###..........##',
      '...##..........##',
      '....#..........##',
      '...............##',
      '......###########',
      '......###########',
    ],
  },
};

/** What a screen reader is told an icon is. */
const ICON_NAMES = { '\u00aa': '\u2302', '\u00ba': '\u21b5' };

/*
 * The helper's frames. With none on the printer, look again now and
 * then rather than on every poll; a frame whose counter has stood still
 * this long means the helper has stopped without cleaning up.
 */
const HELPER_RECHECK_MS = 10000;
const FRAME_STALE_MS = 5000;

/** The panel's colours, lit and unlit, as in .lcd-screen. */
const LCD_COLOURS = {
  lit: { glass: [0xb3, 0xe2, 0x63], ink: [0x1a, 0x24, 0x11] },
  unlit: { glass: [0xc6, 0xcd, 0xba], ink: [0x46, 0x4f, 0x3c] },
};

const state = {
  intervalMs: 500,
  running: true,
  lastOk: 0,
  lastError: null,
  inFlight: false,
  visible: false,
  /** 'image' while drawing the helper's frames, 'text' otherwise. */
  mode: 'text',
  /** What became of the last look for a frame: absent, stale or live. */
  helper: 'absent',
  helperCheckedAt: 0,
  frameSeq: null,
  frameChangedAt: 0,
  /** The WML file on screen, the font it asks for (null: default), and its layout. */
  wmlFile: null,
  font: null,
  layout: null,
  /** The pictures cards show, by name: decoded, or null while being read. */
  images: new Map(),
  fontError: null,
  lastValues: null,
};

let screenNode = null;
let textNode = null;
let ageNode = null;
let metaNode = null;
let helpNode = null;
let pauseBtn = null;
let pollTimer = null;
let tickTimer = null;

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

/**
 * Split the flat grid string into rows of `columns`. The last row -- the
 * soft-key labels -- comes back unpadded, so it is padded here.
 */
export function gridRows(text, columns = lcdColumns(DEFAULT_FONT)) {
  const flat = String(text ?? '');
  const count = Math.max(1, Math.ceil(flat.length / columns));
  const padded = flat.padEnd(count * columns, ' ');
  const rows = [];
  for (let r = 0; r < count; r++) {
    rows.push(padded.slice(r * columns, (r + 1) * columns));
  }
  return rows;
}

/** windows-1252 back to its bytes: readLcd decodes it that way. */
let cp1252Bytes = null;
function byteOf(ch) {
  const code = ch.charCodeAt(0);
  if (code < 0x80 || (code >= 0xa0 && code < 0x100)) return code;
  if (!cp1252Bytes) {
    cp1252Bytes = new Map();
    const decoder = new TextDecoder('windows-1252');
    for (let b = 0x80; b < 0xa0; b++) cp1252Bytes.set(decoder.decode(Uint8Array.of(b)), b);
  }
  return cp1252Bytes.get(ch) ?? 0x3f;
}

/**
 * display.text as rows of characters, one per cell. The grid is laid out
 * in bytes, and the bytes are UTF-8: an icon or an accented letter is
 * two bytes but one cell, so each row is split off first and decoded
 * after. A soft key's icon keeps only its first byte, which decodes as
 * U+FFFD. Every row comes back `columns` long.
 */
export function screenRows(text, columns) {
  const decoder = new TextDecoder('utf-8');
  return gridRows(text, columns).map((row) =>
    [...decoder.decode(Uint8Array.from(row, byteOf))].join('').padEnd(columns, ' '),
  );
}

/**
 * Where each row's text starts, in pixels. display.text pads a line to
 * whole columns, but the panel centres and right-aligns by the pixel, so
 * a line the WML aligns is placed by its own width; anything else sits
 * on the grid.
 */
export function rowStart(row, geometry, aligned = []) {
  const text = row.trim();
  const width = [...text].length * geometry.cell;
  const rule = text && aligned.find((a) => a.pattern.test(text));
  if (rule?.align === 'center') return Math.round((LCD_WIDTH - width) / 2);
  if (rule?.align === 'right') return LCD_WIDTH - width;
  return (row.length - row.trimStart().length) * geometry.cell;
}

/** The size of font whose capitals are `cap` pixels tall, measured once. */
const capRatio = {};
function capFont(ctx, cap) {
  const family = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
  if (!capRatio.value) {
    ctx.font = `bold 100px ${family}`;
    const m = ctx.measureText('H');
    capRatio.value = (m.actualBoundingBoxAscent || 72) / 100;
    capRatio.advance = m.width / 100 || 0.6;
  }
  const size = cap / capRatio.value;
  ctx.font = `bold ${size}px ${family}`;
  return size * capRatio.advance;
}

/** Paint a picture's dark pixels at (x, y). */
function drawBitmap(ctx, image, x, y) {
  for (let py = 0; py < image.height; py++) {
    for (let px = 0; px < image.width; px++) {
      if (image.bits[py * image.width + px]) ctx.fillRect(x + px, y + py, 1, 1);
    }
  }
}

/** One line of cells, its capitals' top at y. */
function drawLine(ctx, chars, x0, y, geometry, icons) {
  const advance = capFont(ctx, geometry.cap);
  const squeeze = Math.min(1, (geometry.cell - 1) / advance);
  chars.forEach((ch, i) => {
    const x = x0 + i * geometry.cell;
    const icon = ICON_BITMAPS[ch === '\ufffd' ? icons : ch];
    const glyph = !icon && geometry.glyph?.(ch);
    if (glyph) {
      drawBitmap(ctx, { width: 12, height: 20, bits: glyph }, x, y - geometry.top);
    } else if (icon) {
      icon.rows.forEach((bits, dy) => {
        for (let dx = 0; dx < bits.length; dx++) {
          if (bits[dx] === '#') ctx.fillRect(x + icon.dx + dx, y + icon.dy + dy, 1, 1);
        }
      });
    } else if (ch !== ' ' && ch !== '\ufffd') {
      ctx.setTransform(squeeze, 0, 0, 1, x + geometry.cell / 2, y + geometry.cap);
      ctx.fillText(ch, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  });
}

/** Turn a box over: dark where it was light, and light where it was dark. */
function invertBox(ctx, x, y, width, height) {
  ctx.save();
  ctx.globalCompositeOperation = 'xor';
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}

/**
 * The screen as the panel would draw it, as a frame like the helper's:
 * the body rows down from the top, clipped above the rule; with a
 * soft-key bar, the rule and the last row under it. Text is drawn at the
 * font's measured size and cut to one bit, so it has the panel's hard
 * edges; the shapes of the letters are this browser's, not the panel's.
 * The card's pictures (`images`: src -> decoded BMP) go where the panel
 * puts them, and the link whose label the soft-key row shows is drawn
 * selected, as the panel does: picture and label turned over.
 */
export function layoutFrame(rows, font, layout = {}, backlight = true, images = new Map()) {
  const geometry = lcdGeometry(font);
  const canvas = document.createElement('canvas');
  canvas.width = LCD_WIDTH;
  canvas.height = LCD_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const lines = CAPITALS_ONLY.has(font) ? rows.map((r) => r.toUpperCase()) : rows;
  const nav = layout.nav !== false && geometry.rule != null && lines.length > 1;
  const body = nav ? lines.slice(0, -1) : lines;
  const bottom = nav ? geometry.rule : LCD_HEIGHT;

  const navRow = nav ? lines[lines.length - 1] : '';
  const links = (layout.flow || []).filter((f) => f.m3).map((f) => f.m3);
  const selected = links.find((m3) => navRow.includes(m3)) ?? null;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, LCD_WIDTH, bottom);
  ctx.clip();
  body.forEach((row, r) => {
    const y = geometry.top + r * geometry.pitch;
    if (y >= bottom) return;
    const x0 = rowStart(row, geometry, layout.aligned);
    drawLine(ctx, [...row.trim()], x0, y, geometry, layout.navIcon);
  });
  for (const img of placeImages(layout.flow || [], geometry, (src) => images.get(src))) {
    drawBitmap(ctx, images.get(img.src), img.x, img.y);
    if (selected && img.m3 === selected) invertBox(ctx, img.x, img.y, img.width, img.height);
  }
  ctx.restore();

  if (nav) {
    ctx.fillRect(0, geometry.rule, LCD_WIDTH, 1);
    // The selected link's label is centred on the panel, not on the
    // grid display.text puts it in.
    let keys = navRow;
    const turned = [];
    if (selected) {
      const at = keys.indexOf(selected);
      keys = keys.slice(0, at) + ' '.repeat(selected.length) + keys.slice(at + selected.length);
      const x = Math.round((LCD_WIDTH - selected.length * geometry.cell) / 2);
      drawLine(ctx, [...selected], x, geometry.nav, geometry, layout.navIcon);
      turned.push({ x, width: selected.length * geometry.cell });
    }
    drawLine(ctx, [...keys], 0, geometry.nav, geometry, layout.navIcon);
    for (const label of new Set(layout.highlighted || [])) {
      const at = keys.indexOf(label);
      if (at >= 0) turned.push({ x: at * geometry.cell, width: label.length * geometry.cell });
    }
    // Both, and a soft key drawn highlighted, are turned over in a box
    // their own width.
    for (const box of turned) {
      invertBox(ctx, box.x, geometry.nav - geometry.top, box.width, geometry.pitch);
    }
  }

  const { data } = ctx.getImageData(0, 0, LCD_WIDTH, LCD_HEIGHT);
  const pixels = new Uint8Array(LCD_WIDTH * LCD_HEIGHT);
  for (let i = 0; i < pixels.length; i++) pixels[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  return { width: LCD_WIDTH, height: LCD_HEIGHT, pixels, backlight };
}

/**
 * The screen has moved to another WML file: find out what font it uses
 * and how it lays out. Read in the background, and the screen redrawn
 * when it is known; until then the last font stands.
 */
function noteWmlFile(file) {
  if (file === state.wmlFile) return;
  state.wmlFile = file;
  const dot = file.lastIndexOf('.');
  fetchStoredFile({ oname: file.slice(0, dot), otype: file.slice(dot + 1) })
    .then((bytes) => {
      if (state.wmlFile !== file) return;
      const source = new TextDecoder('windows-1252').decode(bytes);
      state.font = wmlFont(source);
      state.layout = wmlLayout(source);
      state.fontError = null;
    })
    .catch((err) => {
      if (state.wmlFile !== file) return;
      state.font = null;
      state.layout = null;
      state.fontError = `could not read ${file}: ${err.message}`;
    })
    .finally(() => {
      if (state.wmlFile === file && state.mode === 'text') render(state.lastValues);
    });
}

/**
 * A picture a card shows, decoded, or undefined until it is. The first
 * ask reads it from the printer in the background and redraws when it
 * lands; one that cannot be read is left out.
 */
function cardImage(src) {
  const name = src.replace(/^[A-Z]:/i, '').toUpperCase();
  if (!state.images.has(name)) {
    state.images.set(name, null);
    const dot = name.lastIndexOf('.');
    fetchStoredFile({ oname: name.slice(0, dot), otype: name.slice(dot + 1) })
      .then((bytes) => {
        state.images.set(name, decodeBmp(bytes));
        if (state.mode === 'text') render(state.lastValues);
      })
      .catch(() => {});
  }
  return state.images.get(name) || undefined;
}

/** The font in use: the WML's, its $(setting) filled in. */
function currentFont(values) {
  return resolveWmlValue(state.font, values);
}

function render(values) {
  state.lastValues = values;
  const text = values ? values['display.text'] : null;
  const backlight = values ? values['display.backlight'] : null;
  if (values) noteWmlFile(currentWmlFile(values));

  const font = currentFont(values);
  const rows = screenRows(text, lcdColumns(font));
  const card = pickCard(state.layout, rows);
  const images = new Map();
  for (const item of card.flow || []) {
    if (item.type === 'img') images.set(item.src, cardImage(item.src));
  }
  drawFrame(layoutFrame(rows, font, card, backlight !== 'off', images));

  // The same grid as text, for screen readers and for finding on the page.
  const icon = (ch) =>
    ICON_NAMES[ch === '\ufffd' ? state.layout?.navIcon : ch] ?? (ch === '\ufffd' ? '?' : ch);
  textNode.style.textTransform = CAPITALS_ONLY.has(font) ? 'uppercase' : '';
  replaceChildren(
    textNode,
    rows.map((row) => el('div', { class: 'whitespace-pre' }, [[...row].map(icon).join('')])),
  );
  screenNode.dataset.font = font || DEFAULT_FONT;
  screenNode.dataset.cap = String(lcdGeometry(font).cap);
}

/**
 * Read one of the helper's frames from the pixels of the PNG /png made
 * of it. The last row is not screen but a stamp the helper adds: "LCD",
 * a version byte, a 32-bit frame counter and the backlight. Returns null
 * for a picture without one.
 */
export function decodeFrame(rgba, width, height) {
  const dark = (x, y) => rgba[(y * width + x) * 4] < 128;
  const stampRow = height - 1;
  const byte = (k) => {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) | (dark(k * 8 + bit, stampRow) ? 1 : 0);
    return value;
  };
  if (height < 2 || byte(0) !== 0x4c || byte(1) !== 0x43 || byte(2) !== 0x44) return null;

  const pixels = new Uint8Array(width * stampRow);
  for (let y = 0; y < stampRow; y++) {
    for (let x = 0; x < width; x++) pixels[y * width + x] = dark(x, y) ? 1 : 0;
  }
  return {
    width,
    height: stampRow,
    pixels,
    seq: byte(4) * 0x1000000 + (byte(5) << 16) + (byte(6) << 8) + byte(7),
    backlight: byte(8) === 1,
  };
}

/** The PNG's pixels, by way of a canvas. */
async function frameFromBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return decodeFrame(data, bitmap.width, bitmap.height);
}

/** The real screen, pixel for pixel, in the panel's own green. */
function drawFrame(frame) {
  let canvas = screenNode.querySelector('canvas');
  if (!canvas || canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas = el('canvas', {
      width: String(frame.width),
      height: String(frame.height),
      class: 'block',
      style: `width:${frame.width * 2}px;max-width:100%;image-rendering:pixelated;`,
      role: 'img',
      'aria-label': 'The printer\u2019s front panel',
    });
    replaceChildren(screenNode, [canvas, textNode]);
  }

  const { glass, ink } = frame.backlight ? LCD_COLOURS.lit : LCD_COLOURS.unlit;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(frame.width, frame.height);
  for (let i = 0; i < frame.pixels.length; i++) {
    const [r, g, b] = frame.pixels[i] ? ink : glass;
    image.data.set([r, g, b, 255], i * 4);
  }
  ctx.putImageData(image, 0, 0);
  screenNode.classList.toggle('lcd-lit', frame.backlight);
  renderMeta();
}

/**
 * Draw the helper's latest frame, if it is running. False means there
 * is none to draw -- no helper, or one that has stopped -- and the
 * caller falls back to display.text.
 */
async function pollFrame() {
  const now = Date.now();
  if (state.helper !== 'live' && now - state.helperCheckedAt < HELPER_RECHECK_MS) return false;
  state.helperCheckedAt = now;

  const blob = await readPanelFrame();
  const frame = blob ? await frameFromBlob(blob) : null;
  if (!frame) {
    state.helper = 'absent';
    state.mode = 'text';
    return false;
  }

  if (frame.seq !== state.frameSeq) {
    state.frameSeq = frame.seq;
    state.frameChangedAt = now;
  }
  if (now - state.frameChangedAt > FRAME_STALE_MS + state.intervalMs) {
    state.helper = 'stale';
    state.mode = 'text';
    return false;
  }

  state.helper = 'live';
  state.mode = 'image';
  replaceChildren(textNode, []);
  drawFrame(frame);
  return true;
}

/** The line under the panel saying what it shows, and the way to more. */
function renderMeta() {
  const text =
    state.mode === 'image'
      ? 'the printer\u2019s own screen, via lcd_display_helper.sh'
      : (state.helper === 'stale'
          ? 'lcd_display_helper.sh has stopped updating \u2014 showing display.text'
          : 'generated via display.text \u2014 not an exact screenshot') + fontNote();
  if (metaNode.textContent !== text) metaNode.textContent = text;
  helpNode.hidden = state.mode === 'image';
}

/** Which font the grid is laid out for, and why, after the caption. */
function fontNote() {
  if (state.fontError) return ` (${state.fontError}; assuming A.FNT)`;
  if (!state.wmlFile) return '';
  const font = (state.font && currentFont(state.lastValues)) || state.font || DEFAULT_FONT;
  const known = font in LCD_FONTS;
  return (
    ` \u00b7 ${state.wmlFile} in ${font}` +
    (known ? '' : ', not a font this panel is known to draw; laid out as A.FNT') +
    (/^EPL/.test(font) ? ' (the panel draws EPL fonts with other characters)' : '')
  );
}

/** How to get the real screen: the helper, with this printer's address in. */
function buildHelperHelp() {
  const command = `./lcd_display_helper.sh ${location.hostname}`;
  return el('details', { class: 'mt-3 w-0 min-w-full text-[12px] text-ink-600' }, [
    el('summary', { class: 'cursor-pointer text-ink-700' }, ['Show the real screen']),
    el('div', { class: 'mt-2 space-y-2' }, [
      el('p', {}, [
        'The printer\u2019s web server cannot pass on the screen\u2019s bitmap, but a ' +
          'computer that can reach its port 9100 can. From a copy of this project, run:',
      ]),
      el(
        'pre',
        { class: 'overflow-auto rounded bg-ink-50 px-2 py-1.5 font-mono text-[11px] text-ink-800' },
        [command],
      ),
      el('p', {}, [
        'It copies the screen into the printer\u2019s RAM every second, where this page ' +
          'picks it up \u2014 there is nothing to set here, and it switches over on its own. ' +
          'It also saves each frame as lcd.bmp. Ctrl-C stops it and takes the copy away. ' +
          'Needs only bash, dd, od and awk.',
      ]),
    ]),
  ]);
}

/** Small grey line under the panel, so a stalled poll is obvious. */
function tick() {
  if (state.lastError) {
    ageNode.textContent = state.lastError;
    ageNode.className = 'text-[11px] text-red-600';
    return;
  }
  if (!state.lastOk) {
    ageNode.textContent = 'waiting for the first read…';
    ageNode.className = 'text-[11px] text-ink-400';
    return;
  }

  const age = (Date.now() - state.lastOk) / 1000;
  ageNode.textContent = state.running
    ? `updated ${age.toFixed(1)}s ago`
    : `paused — updated ${age.toFixed(1)}s ago`;

  // Overdue by more than one whole interval means something is wrong.
  const overdue = state.running && age > (state.intervalMs / 1000) * 2 + 1;
  ageNode.className = overdue ? 'text-[11px] text-amber-600' : 'text-[11px] text-ink-400';
}

/* ------------------------------------------------------------------ *
 * Polling
 * ------------------------------------------------------------------ */

async function poll() {
  // One request at a time: the printer's web server serves one anyway,
  // and piling up would starve whatever else the page is doing.
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    if (!(await pollFrame())) render(await readLcd());
    state.lastOk = Date.now();
    state.lastError = null;
  } catch (err) {
    state.lastError = `last read failed: ${err.message}`;
  } finally {
    state.inFlight = false;
    tick();
  }
}

function schedule() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!state.running || !state.visible) return;
  pollTimer = setInterval(poll, state.intervalMs);
}

/** Poll only while this tab is on screen and the browser tab is visible. */
function updateActivity() {
  const active = state.visible && !document.hidden;
  if (active && !pollTimer && state.running) {
    poll();
    schedule();
  } else if (!active) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

/*
 * The buttons
 * ------------------------------------------------------------------
 * diag.simulate_event presses the printer's own front-panel keys, so
 * the mirror becomes a remote control: the menus, the values, the lot.
 * Laid out as the panel is -- the arrows around Select, with the two
 * soft keys under the corners of the screen they belong to.
 *
 * Up and Down change the setting on screen, not just the highlight, so
 * this is a real front panel and not a viewer with decoration.
 */
const LCD_BUTTONS = [
  { key: 'ButtonP1', label: 'P1', title: 'Left soft key, under the screen' },
  { key: 'ButtonUp', label: '\u25b2', title: 'Up' },
  { key: 'ButtonP2', label: 'P2', title: 'Right soft key, under the screen' },
  { key: 'ButtonLeft', label: '\u25c0', title: 'Left' },
  { key: 'ButtonSelect', label: 'OK', title: 'Select' },
  { key: 'ButtonRight', label: '\u25b6', title: 'Right' },
  null,
  { key: 'ButtonDown', label: '\u25bc', title: 'Down' },
  null,
];

/**
 * Press a key, then look at the screen.
 *
 * The read is immediate rather than left to the next poll: a front
 * panel that answers a keypress two seconds later does not feel like
 * one. The panel needs a moment to repaint first.
 */
async function pressButton(button, node) {
  node.disabled = true;
  try {
    await pressPanelButton(button);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await poll();
    // The helper takes a frame a second, so look again once it has.
    if (state.mode === 'image') {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await poll();
    }
  } catch (err) {
    state.lastError = `button press failed: ${err.message}`;
    tick();
  } finally {
    node.disabled = false;
  }
}

/** The keypad, in the shape of the printer's own. */
function buildKeypad() {
  const cells = LCD_BUTTONS.map((spec) => {
    if (!spec) return el('span');
    const node = el(
      'button',
      {
        class: 'btn-secondary h-9 w-full font-mono text-[13px] leading-none',
        title: spec.title,
        'aria-label': spec.title,
      },
      [spec.label],
    );
    node.addEventListener('click', () => pressButton(spec.key, node));
    return node;
  });

  return el('div', { class: 'mt-3 w-0 min-w-full' }, [
    el('div', { class: 'grid grid-cols-3 gap-1.5' }, cells),
    el('p', { class: 'mt-1.5 text-[11px] text-ink-400' }, [
      'These press the printer\u2019s own buttons. Up and Down change the value on screen.',
    ]),
  ]);
}

export function mountLcd(panel) {
  const intervalInput = el('input', {
    class: 'field field-mono w-20',
    type: 'number',
    min: '0.5',
    max: '60',
    step: '0.5',
    value: '0.5',
  });
  intervalInput.addEventListener('change', () => {
    const seconds = Math.min(60, Math.max(0.5, Number(intervalInput.value) || 0.5));
    intervalInput.value = String(seconds);
    state.intervalMs = seconds * 1000;
    schedule();
  });

  pauseBtn = el('button', { class: 'btn-secondary btn-sm' }, ['Pause']);
  pauseBtn.addEventListener('click', () => {
    state.running = !state.running;
    pauseBtn.textContent = state.running ? 'Pause' : 'Resume';
    if (state.running) poll();
    schedule();
    tick();
  });

  // w-fit, or the block would stretch to the card and leave the grid
  // sitting in a wide empty panel.
  // The screen's width is the one measure everything inside scales from
  // (cqw), so the text grid and the helper's bitmap come out the same size.
  screenNode = el('div', {
    class: 'lcd-screen lcd-lit',
    style: 'width:504px;max-width:100%;container-type:inline-size;',
  });
  textNode = el('div', { class: 'sr-only' });

  ageNode = el('p', { class: 'text-[11px] text-ink-400' });
  metaNode = el('span', { class: 'text-[11px] text-ink-400' });
  helpNode = buildHelperHelp();

  panel.append(
    el('div', { class: 'card w-fit max-w-full overflow-hidden' }, [
      el('div', { class: 'toolbar' }, [
        el('span', { class: 'text-[12px] font-medium text-ink-700' }, ['Front panel']),
        el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, [
          'Every',
          intervalInput,
          's',
        ]),
        el('div', { class: 'ml-auto' }, [pauseBtn]),
      ]),
      el('div', { class: 'w-fit p-3' }, [
        // A bezel, so the grid reads as a device rather than a code block.
        el('div', { class: 'w-fit rounded-lg bg-ink-800 p-2 shadow-inner' }, [screenNode]),
        // w-0 min-w-full keeps the caption out of the intrinsic width of
        // the column -- otherwise this line, which is wider than the
        // screen, would set the width and stretch the bezel to match --
        // and then lets it fill and wrap inside whatever the screen needs.
        el(
          'div',
          {
            class:
              'mt-1.5 flex w-0 min-w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1',
          },
          [ageNode, metaNode],
        ),
        buildKeypad(),
        helpNode,
      ]),
    ]),
  );

  render(null);
  tick();

  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 200);
  document.addEventListener('visibilitychange', updateActivity);

  state.visible = true;
  updateActivity();
}

/** The tab came into view: resume polling. */
export function onLcdShown() {
  state.visible = true;
  updateActivity();
}

/** The tab went away: stop asking the printer for screens nobody is watching. */
export function onLcdHidden() {
  state.visible = false;
  updateActivity();
}
