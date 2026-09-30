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

check('a 4in label at 300dpi, drawn at a quarter size, is labelled every inch', () => {
  // 300 dots/in x 0.25 = 75px an inch: the half inch would be 37px, too close.
  const ticks = w.rulerTicks(1200, 'in', 0.25, 300);
  assert.deepEqual(labels(ticks), [0, 1, 2, 3, 4]);
  assert.equal(ticks.length, 17, 'quarter-inch ticks between');
});

check('zoomed in, the labels come closer together', () => {
  assert.deepEqual(
    labels(w.rulerTicks(600, 'in', 1, 300)),
    [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  );
});

check('millimetres and dots have steps of their own', () => {
  assert.deepEqual(labels(w.rulerTicks(300, 'mm', 1, 300)).slice(0, 3), [0, 5, 10]);
  assert.deepEqual(
    labels(w.rulerTicks(1000, 'dots', 0.5, 300)),
    [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000],
  );
});

check('minor ticks thin out rather than crowd', () => {
  const ticks = w.rulerTicks(1200, 'dots', 0.05, 300);
  const px = ticks.map((t) => t.at * 0.05);
  const gaps = px.slice(1).map((p, i) => p - px[i]);
  assert.ok(Math.min(...gaps) >= 5, `ticks ${Math.min(...gaps)}px apart`);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
