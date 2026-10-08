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
const src = readFileSync(new URL('../src/js/lcd.js', import.meta.url), 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
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

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
