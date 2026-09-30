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

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// state.js imports from the browser-side modules; nothing tested here
// needs them, so the imports are dropped.
const src = readFileSync(new URL('../src/js/state.js', import.meta.url), 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
const { activeIpAddress, loadedLabelSize } = await import(
  'data:text/javascript;base64,' + Buffer.from(src).toString('base64')
);

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

check('on Ethernet the header shows the wired address', () => {
  assert.equal(
    activeIpAddress({
      'ip.active_network': 'internal_wired',
      'internal_wired.ip.addr': '10.0.0.7',
      'wlan.ip.addr': '0.0.0.0',
      'ip.addr': '0.0.0.0',
    }),
    '10.0.0.7',
  );
});

check('"internal wired", as the catalogue spells it, means the same', () => {
  assert.equal(
    activeIpAddress({
      'ip.active_network': 'internal wired',
      'internal_wired.ip.addr': '10.0.0.7',
    }),
    '10.0.0.7',
  );
});

check('on wireless it shows the wireless address', () => {
  assert.equal(
    activeIpAddress({
      'ip.active_network': 'wireless',
      'wlan.ip.addr': '192.168.1.81',
      'internal_wired.ip.addr': '0.0.0.0',
      'ip.addr': '192.168.1.81',
    }),
    '192.168.1.81',
  );
});

check('an unknown network, or none, falls back to ip.addr', () => {
  assert.equal(
    activeIpAddress({ 'ip.active_network': 'external_wired', 'ip.addr': '1.2.3.4' }),
    '1.2.3.4',
  );
  assert.equal(activeIpAddress({ 'ip.addr': '1.2.3.4' }), '1.2.3.4');
  assert.equal(activeIpAddress({}), '');
});

check('an interface with no address yet falls back too', () => {
  assert.equal(
    activeIpAddress({
      'ip.active_network': 'internal_wired',
      'internal_wired.ip.addr': '0.0.0.0',
      'ip.addr': '5.6.7.8',
    }),
    '5.6.7.8',
  );
});

check('a new label is the size the printer has loaded, where it says', () => {
  assert.deepEqual(loadedLabelSize({ 'ezpl.print_width': '1200', 'zpl.label_length': '1800' }), {
    width: 1200,
    height: 1800,
  });
  assert.deepEqual(loadedLabelSize({ 'ezpl.print_width': '0', 'zpl.label_length': '?' }), {
    width: undefined,
    height: undefined,
  });
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
