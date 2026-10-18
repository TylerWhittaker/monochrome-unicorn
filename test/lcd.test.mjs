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

/* Reading the LCD Viewer's inputs. Run: node test/lcd.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

/* The decoding is pure; the rest of the module wants a document. */
// lcd.js with the menu font it imports, in one scope as the build has them.
const src = (
  readFileSync(new URL('../src/js/lcdfont.js', import.meta.url), 'utf8') +
  readFileSync(new URL('../src/js/lcd.js', import.meta.url), 'utf8')
).replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm, '');
const lcd = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/**
 * The RGBA a browser gets from /png's rendering of R:LCD.GRF: black for
 * a dark pixel, white otherwise, and the helper's stamp as the last row.
 */
function frame(width, rows, stamp) {
  const height = rows.length + 1;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x, y) => rgba.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  rows.forEach((row, y) => [...row].forEach((c, x) => c === '#' && paint(x, y)));
  stamp.forEach((byte, k) => {
    for (let bit = 0; bit < 8; bit++) if (byte & (0x80 >> bit)) paint(k * 8 + bit, rows.length);
  });
  return { rgba, width, height };
}

check('a stamped frame gives its pixels, counter and backlight', () => {
  const { rgba, width, height } = frame(
    80,
    ['#.......', '.#......', '..##....'],
    [0x4c, 0x43, 0x44, 1, 0x00, 0x00, 0x01, 0x02, 1],
  );
  const f = lcd.decodeFrame(rgba, width, height);
  assert.equal(f.width, 80);
  assert.equal(f.height, 3, 'the stamp row is not part of the screen');
  assert.equal(f.seq, 258);
  assert.equal(f.backlight, true);
  assert.deepEqual([...f.pixels.slice(0, 4)], [1, 0, 0, 0]);
  assert.deepEqual([...f.pixels.slice(80, 84)], [0, 1, 0, 0]);
  assert.deepEqual([...f.pixels.slice(160, 164)], [0, 0, 1, 1]);
});

check('the counter reads all 32 bits, and the backlight can be off', () => {
  const { rgba, width, height } = frame(
    80,
    ['.'],
    [0x4c, 0x43, 0x44, 1, 0xff, 0xff, 0xff, 0xfe, 0],
  );
  const f = lcd.decodeFrame(rgba, width, height);
  assert.equal(f.seq, 0xfffffffe);
  assert.equal(f.backlight, false);
});

check('a picture without the stamp is not taken for a frame', () => {
  const { rgba, width, height } = frame(80, ['#'], [0x4c, 0x43, 0x45]);
  assert.equal(lcd.decodeFrame(rgba, width, height), null);
});

check('the text grid is as wide as the font says, and as tall as the text', () => {
  // D.FNT: 20 columns, the soft-key row unpadded.
  const rows = lcd.gridRows('V74.20.23Z'.padEnd(20) + 'FONT: D.FNT'.padEnd(20) + ' C  E12', 20);
  assert.deepEqual(rows, ['V74.20.23Z          ', 'FONT: D.FNT         ', ' C  E12'.padEnd(20)]);
  assert.equal(lcd.gridRows('x'.repeat(520)).length, 13, 'A.FNT, the default: 40 across');
  assert.equal(lcd.gridRows('').length, 1);
});

check('a WML file names its font in a <font> tag, in either case', () => {
  assert.equal(lcd.wmlFont('<card>\n  <font name="f.fnt" vspace="0"></font>'), 'F.FNT');
  assert.equal(lcd.wmlFont('<FONT vspace="0" NAME=\'MONOBD15.FNT\'>'), 'MONOBD15.FNT');
  assert.equal(lcd.wmlFont('<wml><display><card id="main"><p>x</p></card>'), null);
  assert.equal(lcd.wmlFont('<fontsize name="X.FNT">'), null, 'only <font> itself');
});

check('each font lays display.text out in its own number of columns', () => {
  assert.equal(lcd.lcdColumns(null), 40, 'no <font>: A.FNT');
  assert.equal(lcd.lcdColumns('F.FNT'), 15);
  assert.equal(lcd.lcdColumns('d.fnt'), 20);
  assert.equal(lcd.lcdColumns('P.FNT'), 40, 'a font the panel cannot draw falls back to A');
  assert.equal(lcd.lcdRows('G.FNT'), 2, 'fewer rows fit than display.text holds');
  assert.equal(lcd.lcdRows(null), 13);
});

check('the file on screen comes from load_card, then root_wml', () => {
  assert.equal(
    lcd.currentWmlFile({ 'display.load_card': 'E:Menu.wml#card2', 'display.root_wml': 'X.WML' }),
    'MENU.WML',
  );
  assert.equal(
    lcd.currentWmlFile({ 'display.load_card': '', 'display.root_wml': 'a_fnt.wml' }),
    'A_FNT.WML',
  );
  assert.equal(lcd.currentWmlFile({}), 'INDEX.WML');
});

/* display.text as the page reads it: decoded as windows-1252, a byte a character. */
const cp1252 = (bytes) => new TextDecoder('windows-1252').decode(Uint8Array.from(bytes));
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

check('display.text rows are cut in bytes, then read as UTF-8', () => {
  // A body line with U+00AA (the home icon) as two bytes, then the
  // soft-key row with only the icon's first byte, as the printer sends it.
  const text = cp1252([
    ...ascii('A'),
    0xc2,
    0xaa,
    ...ascii('B'.padEnd(17)),
    ...ascii(' '),
    0xc2,
    ...ascii('            ABOUT '),
  ]);
  const rows = lcd.screenRows(text, 20);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], 'AªB'.padEnd(20), 'one cell for the two-byte icon');
  assert.equal(rows[1], ' �            ABOUT ', 'a lone first byte is one cell too');
  assert.ok(rows.every((r) => r.length === 20));
});

check('a $(setting) in a WML value is filled in from the values read', () => {
  const values = { 'display.wml_font': 'NJ20WGL4.FNT' };
  assert.equal(lcd.resolveWmlValue('$(display.wml_font)', values), 'NJ20WGL4.FNT');
  assert.equal(lcd.resolveWmlValue('$(DISPLAY.WML_FONT)', values), 'NJ20WGL4.FNT');
  assert.equal(lcd.resolveWmlValue('F.FNT', {}), 'F.FNT');
  assert.equal(lcd.resolveWmlValue('$(display.other)', values), null, 'not read: null');
  assert.equal(lcd.resolveWmlValue(null, values), null);
  assert.equal(lcd.lcdColumns('NJ20WGL4.FNT'), 20, 'the printer’s own menu font');
});

const INDEX_CARD = `<wml><display><font name="$(display.wml_font)" vspace="0"></font>
<card id="DoMain" title="">
  <if condition="x = y"><p>HIDDEN</p></if>
  <p align="center" allcaps="on">PRINTER READY</p><br/><br/>
  <p align="center">$(ip.addr)</p><br/>
  <nav_bar><p1 highlight="off" href="H.WML">ª</p1><p2 highlight="on" href="#a">ABOUT</p2></nav_bar>
</card>
<card id="Darkness" title="">
  <p align="center">DARKNESS</p><br/><br/>
  <img src="DOWN_ARROW_ICON.BMP" align="left"/>
  <p align="center">$(print.tone)</p>
  <img src="UP_ARROW_ICON.BMP" align="right"/><br/>
  <nav_bar><p1 highlight="off" href="H.WML">º</p1></nav_bar>
</card></display></wml>`;

check('a WML file says how each card is laid out', () => {
  const layout = lcd.wmlLayout(INDEX_CARD);
  assert.equal(layout.cards.length, 2);
  const [main, dark] = layout.cards;
  assert.equal(main.nav, true);
  assert.deepEqual(main.highlighted, ['ABOUT']);
  assert.equal(main.navIcon, 'ª');
  assert.equal(dark.navIcon, 'º');
  assert.ok(main.aligned.some((a) => a.align === 'center' && a.pattern.test('PRINTER READY')));
  assert.ok(
    main.aligned.some((a) => a.pattern.test('192.168.1.81')),
    '$(ip.addr): anything',
  );
  assert.deepEqual(
    dark.flow.map((f) => f.type + (f.align ? `:${f.align}` : '')),
    ['text', 'br', 'br', 'img:left', 'text', 'img:right', 'br'],
  );
  assert.deepEqual(
    main.flow.map((f) => f.type),
    ['text', 'br', 'br', 'text', 'br'],
    'what an <if> holds is left out',
  );
});

check('the card on screen is the one whose text the screen shows', () => {
  const layout = lcd.wmlLayout(INDEX_CARD);
  const rows = ['      DARKNESS      ', '', '        1.5         ', '', '', ' �                  '];
  assert.equal(lcd.pickCard(layout, rows), layout.cards[1]);
  const idle = ['   PRINTER READY    ', '', '    192.168.1.81    '];
  assert.equal(lcd.pickCard(layout, idle), layout.cards[0]);
  assert.deepEqual(lcd.pickCard(null, idle), {}, 'no WML read yet');
});

check('a line the WML centres is placed by its own width, not the grid', () => {
  const g = lcd.lcdGeometry('NJ20WGL4.FNT');
  const { aligned } = lcd.wmlLayout(INDEX_CARD).cards[0];
  // Measured on the panel: "PRINTER READY" starts at 42, not column 3.
  assert.equal(lcd.rowStart('   PRINTER READY    ', g, aligned), 42);
  assert.equal(lcd.rowStart('    LINK-OS 6.4     ', g, []), 48, 'anything else: the grid');
});

check('pictures go where the panel puts them', () => {
  const g = lcd.lcdGeometry('NJ20WGL4.FNT');
  const sizes = { 'DOWN_ARROW_ICON.BMP': { width: 12, height: 15 } };
  sizes['UP_ARROW_ICON.BMP'] = sizes['DOWN_ARROW_ICON.BMP'];
  const dark = lcd.wmlLayout(INDEX_CARD).cards[1];
  const placed = lcd.placeImages(dark.flow, g, (src) => sizes[src]);
  assert.deepEqual(
    placed.map(({ x, y }) => [x, y]),
    [
      [0, 40],
      [228, 40],
    ],
  );
  // The home menu: 42-pixel icons inline from a 17-pixel spacer, a pixel
  // apart, two lines of them.
  const flow = [
    { type: 'img', src: 'S17', align: '' },
    { type: 'img', src: 'I', align: '' },
    { type: 'br' },
    { type: 'img', src: 'S17', align: '' },
    { type: 'img', src: 'I', align: '' },
  ];
  const home = { S17: { width: 17, height: 40 }, I: { width: 42, height: 42 } };
  assert.deepEqual(
    lcd.placeImages(flow, g, (src) => home[src]).map(({ x, y }) => [x, y]),
    [
      [0, 0],
      [18, 0],
      [0, 42],
      [18, 42],
    ],
  );
  assert.deepEqual(
    lcd.placeImages(flow, g, () => null),
    [],
    'none until they are read',
  );
});

check('a 1-bit BMP decodes with its palette deciding which bit is dark', () => {
  // 2x2, bottom-up, palette white then black: the top row is "#.".
  const bmp = new Uint8Array(62 + 8);
  const view = new DataView(bmp.buffer);
  bmp.set(ascii('BM'));
  view.setUint32(10, 62, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 2, true);
  view.setInt32(22, 2, true);
  view.setUint16(28, 1, true);
  bmp.set([0xff, 0xff, 0xff, 0, 0, 0, 0, 0], 54);
  bmp[62] = 0b01000000; // bottom row: ".#"
  bmp[66] = 0b10000000; // top row: "#."
  const img = lcd.decodeBmp(bmp);
  assert.deepEqual([img.width, img.height], [2, 2]);
  assert.deepEqual([...img.bits], [1, 0, 0, 1]);
  assert.equal(lcd.decodeBmp(Uint8Array.from(ascii('<html>'))), null);
});

check('the menu font has every character a menu can show', () => {
  for (let c = 0x21; c < 0x7f; c++) {
    const ch = String.fromCharCode(c);
    if (ch === '$') continue; // a WML menu cannot show one
    const bits = lcd.n20Glyph(ch);
    assert.ok(bits && bits.length === 240, `${ch} is a 12 x 20 cell`);
  }
  assert.ok(lcd.n20Glyph('é'), 'Latin-1 too');
  assert.equal(lcd.n20Glyph('一'), null);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
