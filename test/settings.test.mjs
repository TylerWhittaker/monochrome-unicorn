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

/* How the settings list is ordered. Run: node test/settings.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

/* The sort is pure; the rest of the module wants a document. */
const src = readFileSync(new URL('../src/js/settings.js', import.meta.url), 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
const s = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

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

/** Sort names the way the list does, in the given mode. */
function order(names, mode) {
  return [...names].sort((a, b) => s.compareNames(s.sortKeyFor(a, mode), s.sortKeyFor(b, mode)));
}

// ip.* as the catalogue has it: not alphabetical, and .enable is in the
// middle of each little group of siblings.
const IP = [
  'ip.ftp.execute_file',
  'ip.addr',
  'ip.ftp.enable',
  'ip.dhcp.cid_all',
  'ip.ftp.request_password',
  'ip.dhcp.enable',
];

check('the three modes are offered, catalogue order first', () => {
  assert.deepEqual(
    s.SORT_MODES.map(([value]) => value),
    ['default', 'alpha', 'alpha-enable'],
  );
});

check('alphabetical leaves .enable among its siblings', () => {
  assert.deepEqual(order(IP, 'alpha'), [
    'ip.addr',
    'ip.dhcp.cid_all',
    'ip.dhcp.enable',
    'ip.ftp.enable',
    'ip.ftp.execute_file',
    'ip.ftp.request_password',
  ]);
});

check('.enable-first floats each .enable to the head of its own group', () => {
  assert.deepEqual(order(IP, 'alpha-enable'), [
    'ip.addr',
    'ip.dhcp.enable',
    'ip.dhcp.cid_all',
    'ip.ftp.enable',
    'ip.ftp.execute_file',
    'ip.ftp.request_password',
  ]);
});

check('a .enable sorts ahead of a sibling that would otherwise precede it', () => {
  // The case alphabetical gets wrong: "autostart" < "enable".
  const names = ['ip.ftp.autostart', 'ip.ftp.enable'];
  assert.deepEqual(order(names, 'alpha'), ['ip.ftp.autostart', 'ip.ftp.enable']);
  assert.deepEqual(order(names, 'alpha-enable'), ['ip.ftp.enable', 'ip.ftp.autostart']);
});

check('a .enable stays inside its own group, not ahead of the next one', () => {
  assert.deepEqual(order(['ip.gateway', 'ip.ftp.enable', 'ip.dhcp.enable'], 'alpha-enable'), [
    'ip.dhcp.enable',
    'ip.ftp.enable',
    'ip.gateway',
  ]);
});

check('only a whole ".enable" suffix counts', () => {
  // ip.dhcp.auto_provision_enable is a setting on this printer, and is
  // not one of these.
  assert.equal(
    s.sortKeyFor('ip.dhcp.auto_provision_enable', 'alpha-enable'),
    'ip.dhcp.auto_provision_enable',
  );
  assert.equal(s.sortKeyFor('ip.ftp.enable', 'alpha-enable'), 'ip.ftp.\u0000');
  assert.equal(
    s.sortKeyFor('ip.ftp.enable', 'alpha'),
    'ip.ftp.enable',
    'the other modes are untouched',
  );
});

check('every filter word must match, in any order', () => {
  const names = [
    'weblink.ip.conn1.location',
    'weblink.ip.conn1.proxy',
    'weblink.ip.conn2.proxy',
    'weblink.enable',
    'ip.proxy',
  ];
  const hits = (filter) => names.filter((n) => s.matchesFilter(filter, n, undefined));
  assert.deepEqual(hits('weblink conn1'), ['weblink.ip.conn1.location', 'weblink.ip.conn1.proxy']);
  assert.deepEqual(hits('conn1 weblink'), hits('weblink conn1'));
  assert.deepEqual(hits('weblink conn proxy'), [
    'weblink.ip.conn1.proxy',
    'weblink.ip.conn2.proxy',
  ]);
  assert.deepEqual(hits('  WebLink   CONN2 '), ['weblink.ip.conn2.proxy']);
  assert.deepEqual(hits(''), names, 'an empty filter shows everything');
});

check('a word may match the name and another the value', () => {
  assert.ok(s.matchesFilter('media 203', 'media.darkness', '203 dpi'));
  assert.ok(!s.matchesFilter('media 300', 'media.darkness', '203 dpi'));
  assert.ok(!s.matchesFilter('media 203', 'media.darkness', undefined));
});

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
