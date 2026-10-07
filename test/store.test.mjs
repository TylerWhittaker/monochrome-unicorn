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

/* The state store the modes use. Run: node test/store.test.mjs */
import assert from 'node:assert/strict';
import { createStore } from '../src/js/store.js';

let calls = [];
const store = createStore({ n: 0 });
const log = (name) => (reason, state) => calls.push(`${name}:${reason}:${state.n}`);

// Reasons pick who hears; '*' hears all, in the order they subscribed.
store.on('edit', log('a'));
const offB = store.on(['edit', 'load'], log('b'));
store.on('*', log('all'));
store.update('edit', (s) => {
  s.n = 1;
});
assert.deepEqual(calls, ['a:edit:1', 'b:edit:1', 'all:edit:1']);

calls = [];
store.update('select');
assert.deepEqual(calls, ['all:select:1']);

calls = [];
offB();
store.update('load');
assert.deepEqual(calls, ['all:load:1'], 'unsubscribed');

// An update made by a subscriber waits for the round to finish.
calls = [];
const nested = createStore({ n: 0 });
nested.on('first', () => {
  calls.push('first-a');
  nested.update('second');
  calls.push('first-a done');
});
nested.on('first', () => calls.push('first-b'));
nested.on('second', () => calls.push('second'));
nested.update('first');
assert.deepEqual(calls, ['first-a', 'first-a done', 'first-b', 'second']);

// One that throws does not stop the others; the first error comes after.
calls = [];
const shaky = createStore({});
shaky.on('x', () => {
  throw new Error('boom');
});
shaky.on('x', () => calls.push('still ran'));
assert.throws(() => shaky.update('x'), /boom/);
assert.deepEqual(calls, ['still ran']);
calls = [];
shaky.on('y', () => calls.push('y'));
shaky.update('y');
assert.deepEqual(calls, ['y'], 'the store keeps working after a failure');

// A subscriber that unsubscribes another mid-round: that one is skipped.
calls = [];
const s2 = createStore({});
let offLater = null;
s2.on('z', () => {
  calls.push('one');
  offLater();
});
offLater = s2.on('z', () => calls.push('two'));
s2.update('z');
assert.deepEqual(calls, ['one']);

console.log('store: all passing');
