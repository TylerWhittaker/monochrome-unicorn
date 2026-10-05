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

/* The Maintenance card's odometers. Run: node test/maintenance.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/js/maintenance.js', import.meta.url), 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

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

check('an odometer length, as a ZD500R reports it', () => {
  assert.deepEqual(m.parseOdometerLength('2026 INCHES, 5147 CENTIMETERS'), {
    inches: 2026,
    cm: 5147,
  });
  assert.deepEqual(m.parseOdometerLength('0 INCHES, 0 CENTIMETERS'), { inches: 0, cm: 0 });
  assert.equal(m.parseOdometerLength('1749'), null);
});

check('shown in inches and metres', () => {
  assert.equal(m.describeLength('2026 INCHES, 5147 CENTIMETERS'), '2,026 in · 51.5 m');
  assert.equal(m.describeLength('12 INCHES, 30 CENTIMETERS'), '12 in · 0.3 m');
  assert.equal(m.describeLength('odd'), 'odd', 'anything else as it came');
});

check('uptime, shortened', () => {
  assert.equal(m.describeUptime('00 days 02 hours 56 mins 32 secs'), '2 h 56 min');
  assert.equal(m.describeUptime('03 days 02 hours 00 mins 05 secs'), '3 d 2 h');
  assert.equal(m.describeUptime('00 days 00 hours 00 mins 09 secs'), '9 s');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
