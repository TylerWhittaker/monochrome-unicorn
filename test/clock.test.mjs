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

/* The printer clock's drift. Run: node test/clock.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/js/clock.js', import.meta.url), 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
const c = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

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

check('drift is the printer ahead (+) or behind (-), in seconds', () => {
  assert.equal(c.clockDrift(1000, 990_000), 10);
  assert.equal(c.clockDrift('990', 1_000_000), -10);
});

check('a few seconds either way is in step; more is fast or slow', () => {
  assert.equal(c.describeDrift(0), 'in step');
  assert.equal(c.describeDrift(-5), 'in step');
  assert.equal(c.describeDrift(42), '42 s fast');
  assert.equal(c.describeDrift(-125), '2 min 5 s slow');
  assert.equal(c.describeDrift(3600 + 120), '1 h 2 min fast');
  assert.equal(c.describeDrift(-(3 * 86400 + 7200)), '3 d 2 h slow');
  assert.equal(c.describeDrift(NaN), 'unknown');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
