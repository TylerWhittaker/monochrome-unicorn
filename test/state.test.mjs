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

// Printer facts read at page load.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// state.js imports from the browser-side modules; nothing tested here
// needs them, so the imports are dropped.
const src = readFileSync(new URL('../src/js/state.js', import.meta.url), 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
const { activeIpAddress, loadedLabelSize, parseHostStatus } = await import(
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

// A ZD500R's ~HS reply, as device.host_status gives it, ready to print.
const READY = '412,0,0,1800,000,0,0,0,000,0,0,0\r\n000,0,0,0,0,3,3,0,00000000,1,017\r\n0000,0';
const flag = (line, field) => {
  const lines = READY.split('\r\n').map((l) => l.split(','));
  lines[line][field] = '1';
  return lines.map((l) => l.join(',')).join('\r\n');
};

check('the status pill: ready, paused, paper out, ribbon out, head open', () => {
  assert.equal(parseHostStatus(READY), 'ready');
  assert.equal(parseHostStatus(flag(0, 2)), 'paused');
  assert.equal(parseHostStatus(flag(0, 1)), 'paper out');
  assert.equal(parseHostStatus(flag(1, 3)), 'ribbon out');
  assert.equal(parseHostStatus(flag(1, 2)), 'head open');
  assert.equal(parseHostStatus(''), 'unknown');
});

check('head.latch and media.status count too, and the worst condition wins', () => {
  assert.equal(parseHostStatus(READY, { 'head.latch': 'open' }), 'head open');
  assert.equal(parseHostStatus(READY, { 'media.status': 'out' }), 'paper out');
  assert.equal(parseHostStatus(flag(0, 2), { 'head.latch': 'open' }), 'head open', 'not paused');
  assert.equal(parseHostStatus(READY, { 'head.latch': 'ok', 'media.status': 'ok' }), 'ready');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
