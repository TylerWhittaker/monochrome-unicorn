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

/* The source view's command reference. Run: node test/zplhelp.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ZPL } from '../src/data/zpl-reference.mjs';

// zplhelp.js wants tokenizeZpl from zpl.js; put the two together, as the
// build does, and leave out the DOM helpers the panel itself needs.
const read = (f) => readFileSync(new URL(`../src/js/${f}`, import.meta.url), 'utf8');
const src = (read('zpl.js') + '\n' + read('zplhelp.js')).replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
const h = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

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

/** The rows for the command at the marker | in a line of ZPL. */
function rowsAt(marked) {
  const offset = marked.indexOf('|');
  const source = marked.replace('|', '');
  const at = h.commandAt(source, offset);
  const entry = h.lookup(ZPL, at.key);
  return {
    at,
    rows: h.describeArguments(entry, at).map((r) => [r.param[0], r.value, r.active]),
  };
}

check('the command the cursor is in, by its reference name', () => {
  const zpl = '^XA\n^FO10,20^A0N,30,40^FDhi^FS\n^XZ';
  assert.equal(h.commandAt(zpl, 0).key, '^XA');
  assert.equal(h.commandAt(zpl, 6).key, '^FO');
  assert.equal(h.commandAt(zpl, zpl.indexOf('^A0') + 1).key, '^A');
  assert.equal(h.commandAt(zpl, zpl.indexOf('^FS') + 3).key, '^FS', 'just after its end');
  assert.equal(h.commandAt('^XA^A@N,30,30,E:SWISS.TTF^FS', 4).key, '^A@');
  assert.equal(h.commandAt('~DGR:X.GRF,4,1,FF', 2).key, '~DG');
  assert.equal(h.commandAt('no commands', 3), null);
});

check('arguments are matched to parameters, and the one under the cursor marked', () => {
  const { rows } = rowsAt('^FO10,2|0');
  assert.deepEqual(rows, [
    ['x', '10', false],
    ['y', '20', true],
    ['z', '', false],
  ]);
  assert.equal(rowsAt('^F|O10,20').at.argIndex, -1, 'on the name itself');
});

check('^A’s font and rotation are glued to the command', () => {
  assert.deepEqual(rowsAt('^A0|N,30,40').rows, [
    ['f', '0', true],
    ['o', 'N', true],
    ['h', '30', false],
    ['w', '40', false],
  ]);
});

check('a stored object is drive, name and extension in one argument', () => {
  assert.deepEqual(rowsAt('^XGE:LOGO.GRF,2,|3').rows, [
    ['d', 'E', false],
    ['o', 'LOGO', false],
    ['x', 'GRF', false],
    ['mx', '2', false],
    ['my', '3', true],
  ]);
  assert.deepEqual(rowsAt('^A@N,30,30,E:SWISS.T|TF').rows.slice(3), [
    ['d', 'E', true],
    ['f', 'SWISS', true],
    ['x', 'TTF', true],
  ]);
});

check('^FN’s number and quoted prompt', () => {
  assert.deepEqual(rowsAt('^FN1|"NAME"').rows, [
    ['#', '1', true],
    ['a', 'NAME', true],
  ]);
});

check('arguments past the documented ones are still shown', () => {
  const { rows } = rowsAt('^CI0,21,36,|35,64,33,34');
  assert.deepEqual(rows.slice(3), [
    ['s2', '35', true],
    ['d2', '64', false],
    ['#6', '33', false],
    ['#7', '34', false],
  ]);
});

check('a second spelling finds its entry, and an unknown command finds nothing', () => {
  assert.equal(h.lookup(ZPL, '~CC').name, 'Change Caret');
  assert.equal(h.lookup(ZPL, '~PH').name, 'Slew to Home Position');
  assert.equal(h.lookup(ZPL, '^ZQ'), null);
});

check('every entry’s Format line places each of its parameters', () => {
  // These lay their arguments out in ways the Format line cannot say.
  const irregular = new Set(['^FN', '^HZ', '^WX', '^RB', '^RL', '~DB', '^CI', '^FM', '^JI']);
  const problems = [];
  for (const [key, entry] of Object.entries(ZPL)) {
    if (entry.alias || irregular.has(key)) continue;
    const placed = h.argumentSlots(entry, key).flatMap((s) => s.names);
    const missing = entry.params.map((p) => p[0]).filter((n) => !placed.includes(n));
    if (missing.length) problems.push(`${key} (${entry.format}): ${missing.join(' ')}`);
  }
  assert.deepEqual(problems, []);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
