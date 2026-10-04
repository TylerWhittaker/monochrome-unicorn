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

/* The designer canvas's rulers. Run: node test/wysiwyg.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

/* The tick maths is pure; the rest of the module wants a document. */
const src = readFileSync(new URL('../src/js/wysiwyg.js', import.meta.url), 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
const w = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

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

const labels = (ticks) => ticks.filter((t) => t.major).map((t) => t.label);

check('a mark every 100 dots, whatever the length', () => {
  const ticks = w.rulerTicks(1218, 1);
  assert.deepEqual(
    ticks.map((t) => t.at),
    [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200],
  );
});

check('at full size every mark is numbered', () => {
  assert.deepEqual(labels(w.rulerTicks(400, 1)), [0, 100, 200, 300, 400]);
});

check('zoomed out, the marks stay but the numbers thin out', () => {
  // 100 dots at 0.25 is 25px: too close to number, so every other one.
  const ticks = w.rulerTicks(1200, 0.25);
  assert.equal(ticks.length, 13);
  assert.deepEqual(labels(ticks), [0, 200, 400, 600, 800, 1000, 1200]);
  assert.deepEqual(labels(w.rulerTicks(1200, 0.05)), [0, 1000]);
});

check('a position snaps to the nearest grid line, and not at all with no grid', () => {
  assert.equal(w.snap(112, 75), 75);
  assert.equal(w.snap(113, 75), 150);
  assert.equal(w.snap(0, 75), 0);
  assert.equal(w.snap(113, 0), 113);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
