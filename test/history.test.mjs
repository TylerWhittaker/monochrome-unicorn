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

/* The Label Editor's undo history. Run: node test/history.test.mjs */
import assert from 'node:assert/strict';
import { createHistory } from '../src/js/history.js';

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

/** A history on a clock the test moves by hand. */
function make(opts = {}) {
  let t = 0;
  const h = createHistory({ ...opts, now: () => t });
  return { h, tick: (ms = 1000) => (t += ms) };
}

check('undo walks back and redo forward', () => {
  const { h, tick } = make();
  h.reset('a');
  h.record('b');
  tick();
  h.record('c');
  assert.equal(h.undo(), 'b');
  assert.equal(h.undo(), 'a');
  assert.equal(h.undo(), null, 'nothing before the start');
  assert.equal(h.redo(), 'b');
  assert.equal(h.redo(), 'c');
  assert.equal(h.redo(), null);
});

check('changes close together are one step', () => {
  const { h, tick } = make();
  h.reset('a');
  h.record('b');
  tick(100);
  h.record('c');
  tick(100);
  h.record('d');
  assert.equal(h.undo(), 'a', 'the whole burst goes at once');
  tick(1000);
  assert.equal(h.redo(), 'd');
});

check('a new change after undoing drops what could have been redone', () => {
  const { h, tick } = make();
  h.reset('a');
  h.record('b');
  tick();
  h.undo();
  h.record('x');
  assert.equal(h.canRedo, false);
  assert.equal(h.undo(), 'a');
});

check('recording the same state is not a change', () => {
  const { h } = make();
  h.reset('a');
  assert.equal(h.record('a'), false);
  assert.equal(h.canUndo, false);
});

check('the history keeps only so many steps, and reset clears it', () => {
  const { h, tick } = make({ limit: 3 });
  h.reset('0');
  for (const s of ['1', '2', '3', '4', '5']) {
    tick();
    h.record(s);
  }
  assert.deepEqual([h.undo(), h.undo(), h.undo(), h.undo()], ['4', '3', '2', null]);
  h.reset('new');
  assert.equal(h.canUndo || h.canRedo, false);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
