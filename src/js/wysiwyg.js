/*
 * Zebra Printer Console -- a web console served from a Zebra printer.
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
 * wysiwyg.js -- the drag-and-drop label canvas.
 *
 * This is an editing proxy, not a renderer: it draws each element roughly
 * where and how the printer will, so positions can be dragged, while the
 * preview pane next to it shows what the printer actually produces. That
 * split is deliberate -- only the printer knows how its fonts and
 * symbologies rasterize, and it will tell us for free.
 */

import { el } from './ui.js';
import { guideSnap } from './arrange.js';
import { loadStoredImage } from './printer.js';
import { SYMBOLOGIES, expandClock, isStoredFont } from './zpl.js';
import { printer, fromDots } from './state.js';

/** Rough advance width of the bitmap fonts, as a fraction of their height. */
const FONT_ASPECT = 0.58;

/*
 * ZPL font 0 (CG Triumvirate Bold Condensed) is drawn in Inter Bold,
 * fetched from jsdelivr the first time a canvas is shown -- like Ace, it
 * is not worth its weight in a page served by the printer -- and Helvetica
 * or Arial until then, or for good on a network with no internet.
 *
 * Fitted to the printer's own render of ^A0N,100,100: capitals 75 dots
 * tall starting at the field origin, "The quick brown" 663 dots wide.
 * Inter's capitals are 0.73 em, so it is set at 1.027 times the field
 * height, squeezed to 0.79 of its width, and raised 0.122 em so the
 * capitals start where the printer's do.
 */
const INTER_URL =
  'https://cdn.jsdelivr.net/npm/@fontsource/inter@5/files/inter-latin-700-normal.woff2';
const FONT0_FAMILY = "'ZPL Font 0', Helvetica, Arial, sans-serif";
const FONT0 = { size: 1.027, squeeze: 0.79, rise: 0.122 };

/** Canvases to redraw once Inter arrives, since text changes width. */
const font0Waiters = new Set();
let font0Requested = false;

function loadFont0() {
  if (font0Requested || typeof FontFace === 'undefined') return;
  font0Requested = true;
  new FontFace('ZPL Font 0', `url(${INTER_URL})`, { weight: '700' })
    .load()
    .then((face) => {
      document.fonts.add(face);
      for (const redraw of font0Waiters) redraw();
    })
    .catch(() => {
      // Offline, or the CDN blocked: the fallback stays, which is fine.
    });
}

let measureContext = null;

/** How wide a line of font 0 prints, in dots, at a height and char width. */
function font0Width(text, height, width) {
  if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
  measureContext.font = `700 100px ${FONT0_FAMILY}`;
  const em = measureContext.measureText(text).width / 100;
  return em * height * FONT0.size * FONT0.squeeze * ((width || height) / height);
}

/*
 * A TrueType font stored on the printer is drawn in the nearest thing the
 * browser has: most of them (Swiss 721 among them) are Helvetica-alikes.
 */
const STORED_FAMILY = 'Helvetica, Arial, sans-serif';

/** How wide a line of a stored font prints, in dots. */
function storedFontWidth(text, height, width) {
  if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
  measureContext.font = `100px ${STORED_FAMILY}`;
  const em = measureContext.measureText(text).width / 100;
  return em * (width || height);
}

/** How wide a line of text prints, in dots. */
function textWidth(item, text) {
  if (typeof document !== 'undefined') {
    if (item.font === '0') return font0Width(text, item.height, item.width);
    if (isStoredFont(item.font)) return storedFontWidth(text, item.height, item.width);
  }
  return text.length * (item.width || item.height) * FONT_ASPECT;
}

/**
 * The text as it lies on the label: ^FP V stacks the characters one to a
 * line, ^FP R runs them right to left.
 */
function laidOutText(item, text) {
  if (item.direction === 'V') return [...String(text).replace(/\n/g, '')].join('\n');
  if (item.direction === 'R') {
    return String(text)
      .split('\n')
      .map((line) => [...line].reverse().join(''))
      .join('\n');
  }
  return String(text);
}

/** Estimate an element's footprint in dots, for hit-testing and handles. */
export function elementBounds(item) {
  if (item.type === 'box' || item.type === 'ellipse') return { w: item.w, h: item.h };
  if (item.type === 'line') {
    if (item.diagonal) return { w: item.w, h: item.h };
    return item.vertical
      ? { w: item.thickness, h: item.length }
      : { w: item.length, h: item.thickness };
  }
  if (item.type === 'image') {
    // ^XG magnifies a stored GRF; ^IM always places it 1:1.
    const grf = /\.GRF$/i.test(item.source || '');
    const sx = grf ? Math.max(1, Math.round(item.scaleX || 1)) : 1;
    const sy = grf ? Math.max(1, Math.round(item.scaleY || sx)) : 1;
    return { w: (item.naturalWidth || 200) * sx, h: (item.naturalHeight || 200) * sy };
  }
  if (item.type === 'field') {
    const charWidth = (item.width || item.height) * FONT_ASPECT;
    const caption = item.name || `FN${item.number}`;
    return { w: Math.max(60, (caption.length + 2) * charWidth), h: item.height };
  }
  if (item.type === 'date') {
    return elementBounds({ ...item, type: 'text', text: dateSample(item) });
  }
  if (item.type === 'text') {
    const lines = laidOutText(item, item.text).split('\n');
    const longest = lines.reduce((n, l) => Math.max(n, textWidth(item, l)), 0);
    const w = item.blockWidth > 0 ? item.blockWidth : Math.max(8, longest);
    return { w, h: item.height * lines.length };
  }
  if (item.type === 'barcode') {
    const spec = SYMBOLOGIES[item.symbology];
    if (item.symbology === 'maxicode') {
      // A fixed size, about 1.11 x 1.05 in, whatever the data.
      return { w: Math.round(printer.dpi * 1.11), h: Math.round(printer.dpi * 1.054) };
    }
    if (item.symbology === 'databar') {
      // Omnidirectional is 96 modules by 33.
      const mag = item.magnification || 2;
      return { w: 96 * mag, h: 33 * mag };
    }
    if (['postnet', 'planet', 'imb'].includes(item.symbology)) {
      // Five bars a digit, or 65 for IMb, at a pitch of a 48th of an
      // inch -- measured off the printer's own render.
      const bars = item.symbology === 'imb' ? 65 : String(item.data).length * 5 + 2;
      return {
        w: Math.round((bars * printer.dpi) / 48),
        h: item.height + (item.showText ? Math.round(item.height * 0.5) + 10 : 0),
      };
    }
    if (item.symbology === 'pdf417' || item.symbology === 'micropdf') {
      const chars = Math.max(1, String(item.data).length);
      return {
        w: (item.symbology === 'pdf417' ? 7 : 4) * 17 * (item.moduleWidth || 2),
        h: Math.max(3, Math.ceil(chars / 4)) * (item.height || 10),
      };
    }
    if (spec && spec.kind === '2d') {
      const modules = item.symbology === 'qr' ? 29 : 24;
      const size = modules * (item.magnification || item.moduleWidth || 4);
      return { w: size, h: size };
    }
    // The retail codes have a fixed width in modules.
    const fixed = { ean13: 95, upca: 95, ean8: 67, upce: 51 }[item.symbology];
    if (fixed) {
      return {
        w: fixed * (item.moduleWidth || 2),
        h: item.height + (item.showText ? Math.round(item.height * 0.25) + 10 : 0),
      };
    }
    // 1D: roughly 11 modules per character plus quiet zones.
    const chars = Math.max(1, String(item.data).length);
    return {
      w: (chars + 4) * 11 * (item.moduleWidth || 2),
      h: item.height + (item.showText ? Math.round(item.height * 0.25) + 10 : 0),
    };
  }
  return { w: 50, h: 50 };
}

const ROTATION_DEG = { N: 0, R: 90, I: 180, B: 270 };

/** How long a finger is held still for a long press, and how still. */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 8;
/** The zoom a pinch can reach. */
const PINCH_MIN = 0.1;
const PINCH_MAX = 3;

/** A position or size on the grid: the nearest multiple of `pitch` dots. */
export function snap(value, pitch) {
  return pitch > 0 ? Math.round(value / pitch) * pitch : value;
}

/**
 * How far left of its origin an element starts, in dots. Only reversed
 * text does: the printer puts the first character at the origin and runs
 * the rest leftwards from it.
 */
function originShift(item, bounds) {
  if ((item.type !== 'text' && item.type !== 'date') || item.direction !== 'R') return 0;
  const first = [...String(item.type === 'date' ? dateSample(item) : item.text)][0] || '';
  return Math.max(0, bounds.w - textWidth(item, first));
}

/* ------------------------------------------------------------------ *
 * Element rendering
 * ------------------------------------------------------------------ */

/** How much narrower (or wider) a text element is drawn than laid out. */
function textSqueeze(item) {
  const stretch = (item.width || item.height) / item.height;
  return item.font === '0' ? FONT0.squeeze * stretch : stretch;
}

function renderText(item, scale) {
  const text = laidOutText(item, item.text);
  const stretch = (item.width || item.height) / item.height;
  // ^FB wraps at its width, which the squeeze would otherwise shrink.
  const wrap =
    item.blockWidth > 0
      ? `width:${(item.blockWidth * scale) / textSqueeze(item)}px;white-space:pre-wrap;overflow-wrap:anywhere;`
      : 'width:max-content;';
  const style =
    item.font === '0'
      ? `font-family:${FONT0_FAMILY};font-weight:700;` +
        `font-size:${item.height * scale * FONT0.size}px;` +
        `line-height:${item.height * scale}px;margin-top:-${FONT0.rise}em;` +
        `transform-origin:left top;transform:scaleX(${FONT0.squeeze * stretch});`
      : isStoredFont(item.font)
        ? `font-family:${STORED_FAMILY};font-size:${item.height * scale}px;` +
          `line-height:${item.height * scale}px;` +
          (stretch !== 1 ? `transform-origin:left top;transform:scaleX(${stretch});` : '')
        : `font-family:ui-monospace, monospace;font-size:${item.height * scale}px;` +
          'line-height:1;' +
          (stretch !== 1 ? `transform-origin:left top;transform:scaleX(${stretch});` : '');
  return el(
    'div',
    {
      class: 'whitespace-pre text-black',
      // ^FR is drawn white and blended by difference (on the element's node,
      // in render()): white over white is black, white over black is white.
      style: style + wrap + (item.reverse ? 'color:#fff;' : ''),
    },
    [text],
  );
}

/**
 * A serial number drawn as its starting value, outlined in green so it
 * reads as one that changes from label to label.
 */
function markSerial(node) {
  node.classList.add('outline', 'outline-1', 'outline-dashed', 'outline-emerald-500');
  return node;
}

/** A clock field as it would print right now, by this computer's clock. */
function dateSample(item) {
  return expandClock(item.format, item.clock);
}

/**
 * A clock field drawn as today's date, outlined so it reads as live
 * rather than typed. The printer fills it from its own clock, which the
 * preview shows.
 */
function renderDate(item, scale) {
  const node = renderText({ ...item, text: dateSample(item) }, scale);
  node.classList.add('outline', 'outline-1', 'outline-dotted', 'outline-amber-500');
  return node;
}

/** A ^FN placeholder has no content yet, so show what will land there. */
function renderField(item, scale) {
  return el(
    'div',
    {
      class:
        'flex h-full w-full items-center overflow-hidden border border-dashed border-violet-500 bg-violet-50/70 px-1',
      style: `font-size:${Math.max(7, item.height * scale * 0.7)}px;`,
    },
    [
      el('span', { class: 'truncate font-mono text-violet-700' }, [
        item.name || `FN${item.number}`,
      ]),
    ],
  );
}

function renderBarcode(item, scale) {
  const spec = SYMBOLOGIES[item.symbology] || SYMBOLOGIES.code128;
  const bounds = elementBounds(item);

  if (spec.kind === '2d') {
    return el('div', {
      class: 'h-full w-full',
      style:
        'background-image:' +
        'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%),' +
        'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%);' +
        `background-size:${Math.max(3, (item.magnification || 4) * scale * 2)}px ${Math.max(3, (item.magnification || 4) * scale * 2)}px;` +
        `background-position:0 0,${Math.max(1.5, (item.magnification || 4) * scale)}px ${Math.max(1.5, (item.magnification || 4) * scale)}px;`,
    });
  }

  // DataBar's height is set by its magnification, not a bar height.
  const barsHeight = (item.symbology === 'databar' ? bounds.h : item.height) * scale;
  const bars = el('div', {
    style:
      `height:${barsHeight}px;` +
      'background-image:repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 3px,#000 3px,#000 6px,transparent 6px,transparent 8px);',
  });
  const children = [bars];
  if (item.showText) {
    children.push(
      el(
        'div',
        {
          class: 'text-center font-mono leading-none text-black',
          style: `font-size:${Math.max(6, item.height * 0.25 * scale)}px;`,
        },
        [item.data],
      ),
    );
  }
  return el('div', { class: 'h-full w-full', style: `width:${bounds.w * scale}px;` }, children);
}

/**
 * Draw a stored graphic. The bytes come through loadStoredImage rather
 * than a plain src, because /png returns stored PNGs with their first
 * four bytes missing and no browser will render that.
 */
function renderImage(item, scale, onMeasured) {
  const match = /^([A-Z]):(.+)\.([A-Z]+)$/i.exec(item.source || '');
  if (!match) {
    return el(
      'div',
      {
        class:
          'flex h-full w-full items-center justify-center border border-dashed border-ink-400 text-[10px] text-ink-500',
      },
      ['no image selected'],
    );
  }
  const [, dev, oname, otype] = match;

  const img = el('img', {
    alt: item.source,
    class: 'block h-full w-full',
    style: 'image-rendering:pixelated;',
    draggable: 'false',
  });
  img.addEventListener('load', () => {
    if (item.naturalWidth !== img.naturalWidth || item.naturalHeight !== img.naturalHeight) {
      item.naturalWidth = img.naturalWidth;
      item.naturalHeight = img.naturalHeight;
      onMeasured();
    }
  });

  const holder = el('div', { class: 'h-full w-full' }, [img]);
  loadStoredImage({ dev, oname, otype })
    .then((url) => {
      img.src = url;
    })
    .catch(() => {
      holder.replaceChildren(
        el(
          'div',
          {
            class:
              'flex h-full w-full items-center justify-center border border-dashed border-red-400 text-[10px] text-red-600',
            title: `Could not read ${item.source} from the printer`,
          },
          [item.source],
        ),
      );
    });
  return holder;
}

function renderBox(item, scale) {
  return el('div', {
    class: 'h-full w-full',
    style: item.invert
      ? `border:${Math.max(1, item.thickness * scale)}px solid #fff;background:#fff;`
      : `border:${Math.max(1, item.thickness * scale)}px solid #000;` +
        (item.rounding ? `border-radius:${item.rounding * 2 * scale}px;` : ''),
  });
}

function renderEllipse(item, scale) {
  const color = item.invert ? '#fff' : '#000';
  return el('div', {
    class: 'h-full w-full rounded-[50%]',
    style: `border:${Math.max(1, item.thickness * scale)}px solid ${color};`,
  });
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * ^GD's stroke is `thickness` dots measured across, so it is drawn as the
 * parallelogram the printer fills rather than as a stroked line.
 */
function renderLine(item) {
  if (!item.diagonal) return el('div', { class: 'h-full w-full bg-black' });
  const { w, h } = item;
  const t = Math.min(item.thickness, w);
  const points =
    item.lean === 'L' ? `0,0 ${t},0 ${w},${h} ${w - t},${h}` : `0,${h} ${t},${h} ${w},0 ${w - t},0`;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'block h-full w-full overflow-visible');
  const shape = document.createElementNS(SVG, 'polygon');
  shape.setAttribute('points', points);
  shape.setAttribute('fill', '#000');
  svg.append(shape);
  return svg;
}

/* ------------------------------------------------------------------ *
 * Rulers
 * ------------------------------------------------------------------ */

const RULER = 20;

/** A mark every this many dots, whatever unit the label is shown in. */
const RULER_STEP = 100;

/**
 * Where a ruler's marks go for a length in dots: one every 100 dots,
 * numbered at the smallest multiple of that at least `gap` pixels apart
 * so the numbers never run into each other when zoomed out.
 */
export function rulerTicks(lengthDots, scale, gap = 32) {
  const every = [1, 2, 5, 10, 20, 50].find((n) => n * RULER_STEP * scale >= gap) || 100;
  const ticks = [];
  for (let i = 0; i * RULER_STEP <= lengthDots; i++) {
    const labelled = i % every === 0;
    ticks.push({ at: i * RULER_STEP, major: labelled, label: labelled ? i * RULER_STEP : null });
  }
  return ticks;
}

const RULER_FONT = '9px ui-sans-serif, system-ui, sans-serif';
let rulerMeasure = null;

/**
 * How wide the side ruler is for a label this tall: room for as many
 * digits as its last mark has. It depends on the length alone, not on the
 * zoom, so the fit can reserve it before the scale is known.
 */
function sideRulerWidth(lengthDots) {
  if (!rulerMeasure) rulerMeasure = document.createElement('canvas').getContext('2d');
  rulerMeasure.font = RULER_FONT;
  const last = Math.floor(lengthDots / RULER_STEP) * RULER_STEP;
  return Math.ceil(12 + rulerMeasure.measureText('0'.repeat(String(last).length)).width);
}

/** One ruler, drawn crisp at the device's pixel ratio. */
function drawRuler(canvas, { lengthDots, scale, vertical }) {
  const length = Math.max(1, Math.round(lengthDots * scale));
  const ratio = window.devicePixelRatio || 1;
  const ticks = rulerTicks(lengthDots, scale);
  const ctx = canvas.getContext('2d');
  const font = RULER_FONT;

  const [w, h] = vertical ? [sideRulerWidth(lengthDots), length] : [length, RULER];
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#64748b';
  ctx.strokeStyle = '#94a3b8';
  ctx.font = font;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const tick of ticks) {
    const at = Math.round(tick.at * scale) + 0.5;
    const size = tick.major ? 8 : 4;
    if (vertical) {
      // Against the label's left edge, numbers outside the ticks.
      ctx.moveTo(w, at);
      ctx.lineTo(w - size, at);
      if (tick.label !== null && tick.at > 0) {
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillText(String(tick.label), w - 10, Math.min(h - 5, Math.max(5, at)));
      }
    } else {
      // Along the label's top edge, numbers above the ticks.
      ctx.moveTo(at, h);
      ctx.lineTo(at, h - size);
      if (tick.label !== null && tick.at > 0) {
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        ctx.fillText(String(tick.label), Math.min(w - 10, at), 1);
      }
    }
  }
  ctx.stroke();
}

/* ------------------------------------------------------------------ *
 * Canvas
 * ------------------------------------------------------------------ */

/**
 * Mount the editing canvas.
 *
 * `onChange(reason)` fires after any edit the user made by direct
 * manipulation; `onSelect()` after the selection changes.
 *
 * Several elements can be selected at once -- shift- (or Ctrl-) click
 * adds or removes one, and a drag across the grey or the empty label
 * selects every element it touches -- and then move, nudge and delete
 * together. The resize handle is only offered on a single element.
 */
export function createCanvas(
  container,
  { getDoc, onChange, onSelect, onZoom = () => {}, getGrid = () => 0, getRulers = () => false },
) {
  /** The selected element ids, in the order they were picked. */
  const selection = new Set();
  let scale = 1;
  let zoom = 'fit';
  /** Element id -> its node on the surface, so edits can skip a rebuild. */
  const nodes = new Map();
  /**
   * Element id -> the size its text actually took, in dots, where that
   * came out bigger than elementBounds() predicted. Text is laid out by
   * the browser, which rounds glyph advances differently by platform,
   * zoom and pixel density, and a glyph's ink can reach past its advance;
   * the outline is fitted to what was drawn, so it always encloses it.
   */
  const fitted = new Map();

  /** Grow a text element's box to the text as drawn, and remember it. */
  function fitText(node, item) {
    const body = node.firstElementChild;
    if (!body || !body.offsetWidth) return;
    const style = getComputedStyle(body);
    if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
    measureContext.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    // Ink as well as advance: a glyph can reach past its advance to the
    // right, and a descender below the line box.
    let right = 0;
    let inkDescent = 0;
    for (const line of String(body.textContent).split('\n')) {
      const m = measureContext.measureText(line);
      right = Math.max(right, m.width, m.actualBoundingBoxRight);
      inkDescent = Math.max(inkDescent, m.actualBoundingBoxDescent);
    }
    // Where the last line's baseline sits: the line box centres the
    // font's own ascent and descent in the line height.
    const font = measureContext.measureText('');
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize);
    const lines = Math.max(1, Math.round(body.offsetHeight / lineHeight));
    const baseline =
      (lines - 1) * lineHeight +
      (lineHeight - font.fontBoundingBoxAscent - font.fontBoundingBoxDescent) / 2 +
      font.fontBoundingBoxAscent;
    const inkBottom = baseline + inkDescent;
    const top = parseFloat(style.marginTop) || 0;

    const width = ((Math.max(body.offsetWidth, right) + 1) * textSqueeze(item)) / scale;
    const height = (Math.max(body.offsetHeight, inkBottom) + top + 1) / scale;
    const bounds = elementBounds(item);
    if (width <= bounds.w && height <= bounds.h) return;
    const size = { w: Math.max(width, bounds.w), h: Math.max(height, bounds.h) };
    fitted.set(item.id, size);
    node.style.width = `${size.w * scale}px`;
    node.style.height = `${size.h * scale}px`;
  }

  /** The box an element occupies on the canvas: predicted, or as drawn. */
  function boxOf(item) {
    const bounds = elementBounds(item);
    const drawn = fitted.get(item.id);
    return drawn ? { w: Math.max(bounds.w, drawn.w), h: Math.max(bounds.h, drawn.h) } : bounds;
  }

  const surface = el('div', {
    class: 'preview-surface relative shrink-0 border border-ink-300 shadow-sm',
  });
  // Rulers along the top and down the left, in dots, when asked for.
  const topRuler = el('canvas', { class: 'block' });
  const sideRuler = el('canvas', { class: 'block' });
  const corner = el('span');
  const frame = el('div', { class: 'grid w-fit', style: 'grid-template-columns:auto auto;' }, [
    corner,
    topRuler,
    sideRuler,
    surface,
  ]);
  // The scroller hugs the label, 16px of grey round it (outside the
  // rulers, when they are on), and sits centred in a host as grey as it
  // is -- so a label narrower than the column has grey either side, not
  // white to its right -- and it only starts scrolling once a label or a
  // zoom is bigger than the budget computeScale() fits to.
  const scroller = el(
    'div',
    {
      class:
        'min-h-0 min-w-0 w-fit max-w-full max-h-[70vh] self-center overflow-auto bg-ink-100 p-4',
      // One finger scrolls; two are a pinch, which zooms the label, not
      // the page.
      style: 'touch-action:pan-x pan-y;',
    },
    [frame],
  );
  container.classList.add('bg-ink-100');
  container.append(scroller);

  /*
   * A press on the grey, or on the label where nothing is, lets go of the
   * selection; dragging from there draws a band, and selects every
   * element it touches (added to the selection, with Shift held).
   */
  const band = el('div', {
    class: 'pointer-events-none fixed z-40 border border-sky-500 bg-sky-400/15',
    hidden: true,
  });
  document.body.append(band);
  const onBackgroundDown = (event) => {
    if (![container, scroller, surface, frame].includes(event.target)) return;
    if (event.button !== 0) return;
    // A finger on empty space scrolls, as anywhere else on a phone; only
    // a tap there (no movement) lets go of the selection.
    if (event.pointerType === 'touch') {
      const x0 = event.clientX;
      const y0 = event.clientY;
      const up = (e) => {
        container.removeEventListener('pointerup', up);
        if (touches.size < 2 && Math.hypot(e.clientX - x0, e.clientY - y0) < 10) setSelection([]);
      };
      container.addEventListener('pointerup', up);
      return;
    }
    // A press on the scroller's own scrollbars scrolls, and nothing else.
    if (
      event.target === scroller &&
      (event.offsetX >= scroller.clientWidth || event.offsetY >= scroller.clientHeight)
    ) {
      return;
    }
    const adding = event.shiftKey || event.ctrlKey || event.metaKey;
    const startX = event.clientX;
    const startY = event.clientY;
    const before = [...selection];
    let dragged = false;
    try {
      container.setPointerCapture(event.pointerId);
    } catch (err) {
      /* no capture support */
    }
    const bandRect = (e) => ({
      left: Math.min(startX, e.clientX),
      top: Math.min(startY, e.clientY),
      right: Math.max(startX, e.clientX),
      bottom: Math.max(startY, e.clientY),
    });
    const move = (e) => {
      if (!dragged && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
      dragged = true;
      const r = bandRect(e);
      Object.assign(band.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.right - r.left}px`,
        height: `${r.bottom - r.top}px`,
      });
      band.hidden = false;
      const touched = [];
      const locked = new Set(
        getDoc()
          .elements.filter((e) => e.locked)
          .map((e) => e.id),
      );
      for (const [id, node] of nodes) {
        if (locked.has(id)) continue;
        const b = node.getBoundingClientRect();
        if (b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) {
          touched.push(id);
        }
      }
      setSelection(adding ? [...before, ...touched] : touched, { quiet: true });
    };
    const end = () => {
      band.hidden = true;
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', end);
      container.removeEventListener('pointercancel', end);
      if (!dragged && !adding) setSelection([]);
      else onSelect();
    };
    container.addEventListener('pointermove', move);
    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);
  };
  container.addEventListener('pointerdown', onBackgroundDown);

  /*
   * Two fingers pinch the zoom, wherever they land -- on the grey, the
   * label or an element (whose drag the second finger cancels). Watched
   * in the capture phase, before an element's own handlers.
   */
  const touches = new Map();
  let pinch = null;
  let activeDrag = null;
  let pinchFrame = 0;
  const spread = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };
  const onTouchDown = (event) => {
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2) {
      if (activeDrag) activeDrag.cancel();
      pinch = { distance: spread(), scale };
    }
  };
  const onTouchMove = (event) => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!pinch || touches.size < 2) return;
    event.preventDefault();
    const next = Math.min(
      PINCH_MAX,
      Math.max(PINCH_MIN, (pinch.scale * spread()) / pinch.distance),
    );
    if (pinchFrame) return;
    pinchFrame = requestAnimationFrame(() => {
      pinchFrame = 0;
      const rounded = Math.round(next * 100) / 100;
      if (rounded === scale) return;
      setZoom(rounded);
      onZoom(rounded);
    });
  };
  const onTouchUp = (event) => {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinch = null;
  };
  container.addEventListener('pointerdown', onTouchDown, true);
  container.addEventListener('pointermove', onTouchMove, true);
  container.addEventListener('pointerup', onTouchUp, true);
  container.addEventListener('pointercancel', onTouchUp, true);

  // Where a drag has got to, beside the pointer.
  const readout = el('div', {
    class:
      'pointer-events-none fixed z-50 rounded bg-ink-900/90 px-1.5 py-0.5 font-mono text-[11px] text-white shadow',
    hidden: true,
  });
  document.body.append(readout);

  // The smart guides of a drag in progress; above the elements.
  const guideLayer = el('div', { class: 'pointer-events-none absolute inset-0 z-10' });

  /**
   * "fit" shows the whole label at once, which is what you want while
   * placing things; an explicit zoom takes over when you need detail.
   */
  function computeScale() {
    if (zoom !== 'fit') {
      scale = zoom;
      return;
    }
    const doc = getDoc();
    const rulers = getRulers();
    // Both come from outside the scroller, which takes its size from the
    // label: measuring the box we are about to resize would feed its own
    // last answer back in. The 32 is the 16px of grey either side.
    const availableW = Math.max(
      160,
      container.clientWidth - 32 - (rulers ? sideRulerWidth(doc.height) : 0),
    );
    const availableH = Math.max(
      160,
      Math.floor(window.innerHeight * 0.7) - 32 - (rulers ? RULER : 0),
    );
    scale = Math.min(1, availableW / Math.max(1, doc.width), availableH / Math.max(1, doc.height));
  }

  /** Set the zoom: a number for a fixed scale, or "fit". */
  function setZoom(next) {
    zoom = next === 'fit' ? 'fit' : Number(next);
    render();
  }

  /**
   * Change the selection without rebuilding the surface. A rebuild here
   * would detach the very node a pointerdown is about to start dragging,
   * which silently kills the drag before it begins.
   */
  function paintSelection() {
    const byId = new Map(getDoc().elements.map((e) => [e.id, e]));
    for (const [id, node] of nodes) decorate(node, byId.get(id));
  }

  /**
   * Select exactly `ids` (those still on the label). `quiet` leaves
   * onSelect() for later, while a band is still being drawn.
   */
  function setSelection(ids, { quiet = false } = {}) {
    const present = new Set(getDoc().elements.map((e) => e.id));
    const next = [...new Set(ids)].filter((id) => present.has(id));
    if (next.length === selection.size && next.every((id) => selection.has(id))) return;
    selection.clear();
    for (const id of next) selection.add(id);
    paintSelection();
    if (!quiet) onSelect();
  }

  /** Select one element, or none. */
  function setSelected(id) {
    setSelection(id ? [id] : [], { quiet: true });
  }

  /** The single selected element's id; null for none, or for several. */
  const single = () => (selection.size === 1 ? [...selection][0] : null);

  /**
   * Where each element sits on the label as drawn, in dots -- rotation
   * and fitted text included -- for lining several up.
   */
  function getBoxes(ids) {
    const origin = surface.getBoundingClientRect();
    return ids
      .filter((id) => nodes.has(id))
      .map((id) => {
        const b = nodes.get(id).getBoundingClientRect();
        return {
          id,
          x: Math.round((b.left - origin.left) / scale),
          y: Math.round((b.top - origin.top) / scale),
          w: Math.round(b.width / scale),
          h: Math.round(b.height / scale),
        };
      });
  }

  /** Apply selection styling and the resize handle to one element node. */
  function decorate(node, item) {
    if (!item) return;
    const selected = selection.has(item.id);
    node.className =
      'absolute touch-none' +
      (selected
        ? ' outline outline-2 outline-offset-1 outline-sky-500'
        : ' hover:outline hover:outline-1 hover:outline-sky-300');

    const existing = node.querySelector('[data-handle]');
    if (selected && selection.size === 1 && item.type !== 'image' && !item.locked) {
      if (!existing) {
        node.append(
          el('div', {
            class:
              'absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-se-resize rounded-sm border border-white bg-sky-500',
            style: 'touch-action:none;',
            dataset: { handle: '1' },
            onpointerdown: (event) => beginDrag(event, item, 'resize'),
          }),
        );
      }
    } else if (existing) {
      existing.remove();
    }
  }

  /** Move/resize the live node without rebuilding the whole surface. */
  function reposition(item) {
    const node = nodes.get(item.id);
    if (!node) return;
    const bounds = boxOf(item);
    node.style.left = `${(item.x - originShift(item, bounds)) * scale}px`;
    node.style.top = `${item.y * scale}px`;
    node.style.width = `${Math.max(2, bounds.w * scale)}px`;
    node.style.height = `${Math.max(2, bounds.h * scale)}px`;
  }

  /* -- dragging ---------------------------------------------------- */

  function beginDrag(event, item, mode, before = null) {
    event.preventDefault();
    event.stopPropagation();
    // A resize changes what the text looks like; it is refitted after.
    if (mode === 'resize') fitted.delete(item.id);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { ...item };
    // Moving one of several selected moves them all, keeping their offsets.
    const group =
      mode === 'move' && selection.has(item.id)
        ? getDoc().elements.filter((e) => selection.has(e.id) && e !== item && !e.locked)
        : [];
    const origins = new Map(group.map((e) => [e.id, { x: e.x, y: e.y }]));
    const leftmost = Math.min(origin.x, ...group.map((e) => e.x));
    const topmost = Math.min(origin.y, ...group.map((e) => e.y));
    // Smart guides: the moving elements' outline as drawn, and every
    // other element's and the label's, to line it up with.
    let moving = null;
    let others = [];
    if (mode === 'move') {
      const ids = [item.id, ...group.map((e) => e.id)];
      const boxes = getBoxes(ids);
      if (boxes.length) {
        const left = Math.min(...boxes.map((b) => b.x));
        const top = Math.min(...boxes.map((b) => b.y));
        moving = {
          x: left,
          y: top,
          w: Math.max(...boxes.map((b) => b.x + b.w)) - left,
          h: Math.max(...boxes.map((b) => b.y + b.h)) - top,
        };
        const doc = getDoc();
        others = [
          { x: 0, y: 0, w: doc.width, h: doc.height },
          ...getBoxes([...nodes.keys()].filter((id) => !ids.includes(id))),
        ];
      }
    }
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch (err) {
      /* mouse without capture support */
    }

    let cancelled = false;
    // Put everything back and stop: a pinch began, or a long press.
    const cancel = () => {
      cancelled = true;
      clearTimeout(longPress);
      Object.assign(item, { x: origin.x, y: origin.y });
      for (const other of group) Object.assign(other, origins.get(other.id));
      if (mode === 'resize') applyResize(item, origin, 0, 0);
      readout.hidden = true;
      drawGuides([]);
      detach();
      activeDrag = null;
      render();
    };
    activeDrag = { cancel };

    // A finger held still on an element adds it to the selection, or
    // takes it out: touch's Shift-click.
    let longPress = null;
    if (mode === 'move' && event.pointerType === 'touch' && before) {
      longPress = setTimeout(() => {
        cancel();
        const had = before.includes(item.id);
        setSelection(had ? before.filter((id) => id !== item.id) : [...before, item.id]);
        if (navigator.vibrate) navigator.vibrate(15);
      }, LONG_PRESS_MS);
    }

    const move = (moveEvent) => {
      if (cancelled) return;
      if (
        longPress &&
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > LONG_PRESS_SLOP
      ) {
        clearTimeout(longPress);
        longPress = null;
      }
      const dx = Math.round((moveEvent.clientX - startX) / scale);
      const dy = Math.round((moveEvent.clientY - startY) / scale);
      // With the grid showing, a drag lands on it; Alt lets go of it.
      const pitch = moveEvent.altKey ? 0 : getGrid();
      if (mode === 'move') {
        // The one dragged lands on the grid, when it is showing, or else
        // on a smart guide nearer than 6 pixels; none goes off the label.
        // Alt turns both off.
        let mx = snap(origin.x + dx, pitch) - origin.x;
        let my = snap(origin.y + dy, pitch) - origin.y;
        const guides =
          moving && !moveEvent.altKey && !pitch
            ? guideSnap({ ...moving, x: moving.x + dx, y: moving.y + dy }, others, 6 / scale)
            : null;
        if (guides && guides.dx !== null) mx = dx + guides.dx;
        if (guides && guides.dy !== null) my = dy + guides.dy;
        mx = Math.max(-leftmost, mx);
        my = Math.max(-topmost, my);
        drawGuides(guides ? guides.lines : []);
        item.x = origin.x + mx;
        item.y = origin.y + my;
        for (const other of group) {
          other.x = origins.get(other.id).x + mx;
          other.y = origins.get(other.id).y + my;
          reposition(other);
        }
      } else {
        applyResize(item, origin, dx, dy, pitch);
      }
      reposition(item);
      showReadout(moveEvent, item, mode);
    };
    const detach = () => {
      try {
        target.releasePointerCapture(event.pointerId);
      } catch (err) {
        /* already released */
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    const end = () => {
      if (cancelled) return;
      clearTimeout(longPress);
      activeDrag = null;
      readout.hidden = true;
      drawGuides([]);
      detach();
      // A resize can change how the element is drawn, not just its box.
      render();
      onChange('drag');
    };

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  /** Draw the guide lines a drag is sitting on, over the label. */
  function drawGuides(lines) {
    guideLayer.replaceChildren(
      ...lines.map(({ axis, at }) =>
        el('div', {
          class: 'absolute bg-sky-500',
          dataset: { guide: axis },
          style:
            axis === 'x'
              ? `left:${at * scale}px;top:-8px;bottom:-8px;width:1px;`
              : `top:${at * scale}px;left:-8px;right:-8px;height:1px;`,
        }),
      ),
    );
    if (lines.length && guideLayer.parentNode !== surface) surface.append(guideLayer);
  }

  /** Where the element is (or how big, while resizing), by the pointer. */
  function showReadout(event, item, mode) {
    const unit = getDoc().unit;
    const show = (dots) => String(fromDots(dots, unit));
    const suffix = unit === 'dots' ? '' : ` ${unit}`;
    let text;
    if (mode === 'move') {
      text = `x ${show(item.x)}  y ${show(item.y)}${suffix}`;
    } else {
      const bounds = boxOf(item);
      text = `${show(bounds.w)} \u00d7 ${show(bounds.h)}${suffix}`;
    }
    readout.textContent = text;
    readout.style.left = `${event.clientX + 14}px`;
    readout.style.top = `${event.clientY + 14}px`;
    readout.hidden = false;
  }

  /**
   * What the corner handle means differs per element type. Sizes snap to
   * the grid too; a barcode's do not, since they move in whole modules.
   */
  function applyResize(item, origin, dx, dy, pitch = 0) {
    if (item.type === 'box' || item.type === 'ellipse' || (item.type === 'line' && item.diagonal)) {
      item.w = Math.max(item.thickness, snap(origin.w + dx, pitch));
      item.h = Math.max(item.thickness, snap(origin.h + dy, pitch));
    } else if (item.type === 'line') {
      item.length = Math.max(4, snap(origin.length + (item.vertical ? dy : dx), pitch));
    } else if (item.type === 'text' || item.type === 'field' || item.type === 'date') {
      item.height = Math.max(6, snap(origin.height + dy, pitch));
      if (origin.width) item.width = Math.max(4, snap(origin.width + dx, pitch));
    } else if (item.type === 'barcode') {
      const spec = SYMBOLOGIES[item.symbology];
      if (spec && spec.kind === '2d') {
        item.magnification = Math.min(20, Math.max(1, origin.magnification + Math.round(dx / 20)));
      } else {
        item.height = Math.max(10, origin.height + dy);
        item.moduleWidth = Math.min(10, Math.max(1, origin.moduleWidth + Math.round(dx / 40)));
      }
    }
  }

  /* -- rendering --------------------------------------------------- */

  function render() {
    const doc = getDoc();
    computeScale();

    surface.style.width = `${doc.width * scale}px`;
    surface.style.height = `${doc.height * scale}px`;
    surface.replaceChildren();
    nodes.clear();
    fitted.clear();

    for (const item of doc.elements) {
      // Hidden in the Layers panel: not drawn here, though it prints.
      if (item.hidden) continue;
      const bounds = elementBounds(item);

      let body;
      if (item.type === 'field') body = renderField(item, scale);
      else if (item.type === 'text') body = renderText(item, scale);
      else if (item.type === 'date') body = renderDate(item, scale);
      else if (item.type === 'barcode') body = renderBarcode(item, scale);
      else if (item.type === 'image') body = renderImage(item, scale, () => render());
      else if (item.type === 'box') body = renderBox(item, scale);
      else if (item.type === 'ellipse') body = renderEllipse(item, scale);
      else body = renderLine(item);
      if (item.serial) markSerial(body);

      const node = el(
        'div',
        {
          style:
            `left:${(item.x - originShift(item, bounds)) * scale}px;top:${item.y * scale}px;` +
            `width:${Math.max(2, bounds.w * scale)}px;height:${Math.max(2, bounds.h * scale)}px;` +
            `transform:rotate(${ROTATION_DEG[item.rotation] || 0}deg);transform-origin:left top;` +
            // ^FR inverts whatever is beneath the field, as the printer
            // does: black on a blank label, white across a filled box.
            (item.reverse ? 'mix-blend-mode:difference;' : '') +
            (item.locked ? 'cursor:default;' : 'cursor:move;'),
          dataset: { id: item.id },
          onpointerdown: (event) => {
            // A second finger is a pinch, not a press on this element.
            if (event.pointerType === 'touch' && touches.size > 1) return;
            const before = [...selection];
            if (event.shiftKey || event.ctrlKey || event.metaKey) {
              const ids = [...selection];
              const without = ids.filter((id) => id !== item.id);
              setSelection(without.length < ids.length ? without : [...ids, item.id]);
              if (!selection.has(item.id)) {
                event.preventDefault();
                return;
              }
            } else if (!selection.has(item.id)) {
              setSelection([item.id]);
            }
            // Locked in the Layers panel: it can be picked, not moved.
            if (item.locked) {
              event.preventDefault();
              return;
            }
            beginDrag(event, item, 'move', before);
          },
        },
        [body],
      );

      nodes.set(item.id, node);
      surface.append(node);
      if (item.type === 'text' || item.type === 'date') fitText(node, item);
      decorate(node, item);
    }

    // A grid over everything, which the pointer passes straight through.
    const gridDots = getGrid();
    if (gridDots > 0 && gridDots * scale >= 3) {
      const size = gridDots * scale;
      surface.append(
        el('div', {
          class: 'pointer-events-none absolute inset-0',
          style:
            'background-image:' +
            'linear-gradient(to right, rgba(14,165,233,.35) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgba(14,165,233,.35) 1px, transparent 1px);' +
            `background-size:${size}px ${size}px;`,
        }),
      );
    }

    const rulers = getRulers();
    // By style, not `hidden`: the canvases' `block` class would win over it.
    for (const node of [corner, topRuler, sideRuler]) node.style.display = rulers ? '' : 'none';
    if (rulers) {
      drawRuler(topRuler, { lengthDots: doc.width, scale, vertical: false });
      drawRuler(sideRuler, { lengthDots: doc.height, scale, vertical: true });
    }
  }

  /* -- keyboard ---------------------------------------------------- */

  const onKey = (event) => {
    if (!selection.size) return;
    // Ignore keys typed into the property inspector.
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const doc = getDoc();
    // Locked elements stay where they are, and are not deleted by a key.
    const items = doc.elements.filter((e) => selection.has(e.id) && !e.locked);
    if (!items.length) return;

    const step = event.shiftKey ? 10 : 1;
    const nudge = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (nudge) {
      event.preventDefault();
      // Together, so a nudge into the edge does not bunch them up.
      const dx = Math.max(nudge[0], -Math.min(...items.map((e) => e.x)));
      const dy = Math.max(nudge[1], -Math.min(...items.map((e) => e.y)));
      for (const item of items) {
        item.x += dx;
        item.y += dy;
      }
      render();
      onChange('nudge');
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      const gone = new Set(items.map((e) => e.id));
      doc.elements = doc.elements.filter((e) => !gone.has(e.id));
      for (const id of gone) selection.delete(id);
      onChange('delete');
    }
  };
  document.addEventListener('keydown', onKey);

  const onResize = () => render();
  window.addEventListener('resize', onResize);

  // Font 0's stand-in changes every text width when it arrives.
  font0Waiters.add(render);
  loadFont0();

  render();

  return {
    render,
    setSelected,
    setSelection,
    setZoom,
    getBoxes,
    getScale: () => scale,
    getSelected: single,
    getSelection: () => [...selection],
    destroy() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      font0Waiters.delete(render);
      readout.remove();
      band.remove();
      scroller.remove();
      container.removeEventListener('pointerdown', onBackgroundDown);
      container.removeEventListener('pointerdown', onTouchDown, true);
      container.removeEventListener('pointermove', onTouchMove, true);
      container.removeEventListener('pointerup', onTouchUp, true);
      container.removeEventListener('pointercancel', onTouchUp, true);
      container.classList.remove('bg-ink-100');
    },
  };
}
