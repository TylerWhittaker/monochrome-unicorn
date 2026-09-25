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

// Printer facts read at page load.

// How the build packs settings branches into helper files.

import assert from 'node:assert/strict';
import { packBranches } from '../tools/build.mjs';

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

const branches = (sizes) =>
  new Map(
    Object.entries(sizes).map(([b, n]) => [b, Array.from({ length: n }, (_, i) => `${b}.${i}`)]),
  );

check('small branches share a file, up to the limit', () => {
  const groups = packBranches(branches({ a: 30, b: 12, c: 9, d: 5, e: 1 }), 40);
  assert.deepEqual(groups, [
    ['a', 'c', 'e'],
    ['b', 'd'],
  ]);
});

check('a branch bigger than the limit keeps a file to itself', () => {
  const groups = packBranches(branches({ wlan: 89, zpl: 12, ribbon: 2 }), 40);
  assert.deepEqual(groups, [['wlan'], ['ribbon', 'zpl']]);
});

check('every branch lands in exactly one file', () => {
  const sizes = { a: 41, b: 40, c: 39, d: 20, e: 20, f: 1, g: 1 };
  const all = packBranches(branches(sizes), 40).flat().sort();
  assert.deepEqual(all, Object.keys(sizes).sort());
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
