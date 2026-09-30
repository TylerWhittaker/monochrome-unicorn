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

check('the text grid still splits into six rows of twenty', () => {
  const rows = lcd.gridRows('A'.repeat(25));
  assert.equal(rows.length, 6);
  assert.equal(rows[1], 'AAAAA' + ' '.repeat(15));
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
