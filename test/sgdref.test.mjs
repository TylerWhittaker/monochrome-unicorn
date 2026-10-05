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

/* The printer-setting reference. Run: node test/sgdref.test.mjs */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { SGD } from '../src/data/sgd-reference.mjs';

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

check('every entry is a sentence or two about a dotted setting name', () => {
  const bad = Object.entries(SGD).filter(
    ([name, text]) =>
      !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(name) ||
      typeof text !== 'string' ||
      text.length < 10 ||
      !/[.)…]$/.test(text.trim()),
  );
  assert.deepEqual(bad, []);
});

check('it covers the settings catalogue this build was made from', () => {
  const path = new URL('../data/sgd-schema.json', import.meta.url);
  if (!existsSync(path)) {
    console.log('       (no data/sgd-schema.json yet: nothing to check against)');
    return;
  }
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  // A user's own settings (device.user_vars.*) are theirs, not the guide's.
  const missing = Object.keys(schema.settings).filter(
    (n) => !SGD[n] && !/^device\.user_vars\.(?!create$|set_range$)/.test(n),
  );
  assert.deepEqual(missing, []);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
