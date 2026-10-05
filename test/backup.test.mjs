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

/* Settings backups. Run: node test/backup.test.mjs */
import assert from 'node:assert/strict';
import { buildBackup, compareBackup, backupWorthy, BACKUP_FORMAT } from '../src/js/backup.js';

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

const meta = (name, def, access = 'RW', type = 'string') => ({
  name,
  default: def,
  type,
  writable: access.includes('W'),
  readable: access.includes('R'),
});

const METAS = [
  meta('media.speed', '4.0', 'RW', 'double'),
  meta('print.tone', '10.0', 'RW', 'double'),
  meta('device.user_p1', ''),
  meta('wlan.essid', '125'),
  meta('ip.addr', '0.0.0.0', 'RW', 'ipv4-address'),
  meta('ip.http.admin_password', 'admin'),
  meta('device.unique_id', null, 'R'),
  meta('file.drive_listing', null, 'RW', 'json'),
  meta('device.user_vars.test_string', null),
];
const VALUES = {
  'media.speed': '3.0',
  'print.tone': '10.0',
  'device.user_p1': 'mine',
  'wlan.essid': 'office',
  'ip.addr': '10.0.0.5',
  'ip.http.admin_password': 'secret',
  'device.unique_id': 'XYZ',
  'file.drive_listing': '{}',
  'device.user_vars.test_string': 'hello',
};
const same = (a, b) => Number(a) === Number(b) || a === b;

check('a backup holds what was changed, and never secrets, commands or user variables', () => {
  const b = buildBackup({
    metas: METAS,
    values: VALUES,
    same,
    now: new Date('2026-10-05T00:00:00Z'),
  });
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.captured, '2026-10-05T00:00:00.000Z');
  assert.deepEqual(b.settings, { 'media.speed': '3.0', 'device.user_p1': 'mine' });
});

check('everything writable, and the network only when asked', () => {
  const all = buildBackup({ metas: METAS, values: VALUES, same, includeAll: true });
  assert.deepEqual(Object.keys(all.settings), ['media.speed', 'print.tone', 'device.user_p1']);
  const net = buildBackup({ metas: METAS, values: VALUES, same, includeNetwork: true });
  assert.deepEqual(Object.keys(net.settings), [
    'media.speed',
    'device.user_p1',
    'wlan.essid',
    'ip.addr',
  ]);
  assert.equal(backupWorthy(meta('ip.http.admin_password', ''), { includeNetwork: true }), false);
});

check('a backup compared with a printer: differs, same, missing, read-only', () => {
  const backup = {
    format: BACKUP_FORMAT,
    settings: {
      'media.speed': '4',
      'print.tone': '10',
      'odd.setting': 'x',
      'device.unique_id': 'ABC',
    },
  };
  assert.deepEqual(
    compareBackup(backup, METAS, VALUES, same).map((r) => [r.name, r.status]),
    [
      ['media.speed', 'differs'],
      ['print.tone', 'same'],
      ['odd.setting', 'missing'],
      ['device.unique_id', 'read-only'],
    ],
  );
  assert.throws(() => compareBackup({ some: 'json' }, METAS, VALUES), /not a settings backup/);
});

check('never the clock, the odometers or settings that act when written', () => {
  for (const name of [
    'rtc.date',
    'rtc.unix_timestamp',
    'odometer.headclean',
    'head.element_test',
    'display.load_card',
    'ip.mirror.fetch',
    'zpl.calibrate',
    'ip.mirror.feedback.odometer',
    'weblink.cloud_connect.configuration_key',
  ]) {
    assert.equal(backupWorthy(meta(name, ''), { includeNetwork: true }), false, name);
  }
  assert.equal(backupWorthy(meta('media.speed', '4')), true);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
