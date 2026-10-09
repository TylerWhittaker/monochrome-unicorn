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

/* Reading the syslog and its settings. Run: node test/syslog.test.mjs */
import assert from 'node:assert/strict';
import * as s from '../src/js/syslog.js';

// Lines as the ZD620 writes them, and as the manual's examples do (no host).
const LOG = [
  'Sep 23 02:30:50 nto : [Power][Informational][0X14] Power On',
  'Sep 23 02:31:04 nto : [Network][Notice][0X1C] Cold Start',
  'Sep 25 17:40:10 nto last message repeated 15 times',
  'Sep 25 17:50:37 nto : [SGD][Informational][0X1D] SGD Set media.sense_mode -> bar',
  'Feb 17 14:28:17: [Print][Error][0XF] Paper Out',
  'something the printer did not format',
].join('\n');

const entries = s.parseSyslog(LOG);
assert.equal(entries.length, 6);
assert.deepEqual(
  { ...entries[0] },
  {
    raw: 'Sep 23 02:30:50 nto : [Power][Informational][0X14] Power On',
    time: 'Sep 23 02:30:50',
    host: 'nto',
    feature: 'Power',
    severity: 'Informational',
    level: 6,
    code: '0X14',
    message: 'Power On',
  },
);
assert.equal(entries[2].repeat, 15, 'a repeat line');
assert.equal(entries[2].feature, 'Network', 'takes the line it repeats');
assert.equal(entries[2].level, 5);
assert.equal(entries[3].message, 'SGD Set media.sense_mode -> bar');
assert.equal(entries[4].host, '', 'the manual’s form has no host');
assert.equal(entries[4].level, 3);
assert.deepEqual(entries[5], { raw: 'something the printer did not format', level: -1 });

// Filtering: a severity floor, a feature, words.
assert.equal(s.filterEntries(entries).length, 6, 'no filter keeps everything');
assert.deepEqual(
  s.filterEntries(entries, { minLevel: 5 }).map((e) => e.message),
  ['Cold Start', 'last message repeated 15 times', 'Paper Out'],
);
assert.equal(s.filterEntries(entries, { feature: 'SGD' }).length, 1);
assert.equal(s.filterEntries(entries, { search: 'COLD' }).length, 1);

assert.equal(s.severityLevel('Informational'), 6);
assert.equal(s.severityLevel('crit'), 2);
assert.equal(s.severityLevel('Emergency'), 0);
assert.equal(s.severityLevel('nonsense'), -1);

// device.syslog.configuration: lower case, no spaces, ";" after each.
const rows = s.parseSyslogConfig('ERR,local; info,10.0.0.9;');
assert.deepEqual(rows, [
  { severity: 'err', destination: 'local' },
  { severity: 'info', destination: '10.0.0.9' },
]);
assert.equal(s.formatSyslogConfig(rows), 'err,local;info,10.0.0.9;');
assert.deepEqual(s.parseSyslogConfig(''), []);
assert.deepEqual(s.checkSyslogRows(rows), []);
assert.match(s.checkSyslogRows([{ severity: 'loud', destination: 'local' }])[0], /severity/);
assert.match(s.checkSyslogRows([{ severity: 'err', destination: '10.0.0.300' }])[0], /IPv4/);
assert.match(
  s.checkSyslogRows([
    { severity: 'err', destination: 'local' },
    { severity: 'crit', destination: 'local' },
  ])[0],
  /first "local"/,
);

// alerts.configured: as the printers hold it, and back.
const factory = 'COLD START,SNMP,Y,N,255.255.255.255,162,N';
const alerts = s.parseAlerts(`${factory}|SGD SET,UDP,Y,N,192.0.2.1,9999,Y,media.darkness`);
assert.deepEqual(alerts[0], {
  condition: 'COLD START',
  destination: 'SNMP',
  onSet: true,
  onClear: false,
  address: '255.255.255.255',
  port: '162',
  quelling: false,
  sgd: '',
});
assert.equal(alerts[1].sgd, 'media.darkness');
assert.equal(
  s.formatAlerts(alerts),
  `${factory}|SGD SET,UDP,Y,N,192.0.2.1,9999,Y,media.darkness`,
  'round trip, and no trailing "|" (the printer refuses one)',
);
assert.equal(
  s.formatAlerts([{ ...alerts[0], sgd: 'ignored' }]),
  factory,
  'an SGD name only for SGD SET',
);
assert.deepEqual(s.parseAlerts(''), []);
assert.equal(s.formatAlerts([]), '');

const lists = {
  conditions: s.parseList('ALL MESSAGES, PAPER OUT, COLD START, SGD SET'),
  destinations: s.parseList('SERIAL, E-MAIL, TCP, UDP, SNMP'),
};
assert.deepEqual(lists.destinations, ['SERIAL', 'E-MAIL', 'TCP', 'UDP', 'SNMP']);
assert.deepEqual(s.checkAlertRows(alerts.slice(0, 1), lists), []);
const bad = s.checkAlertRows(
  [
    {
      condition: 'PAPER OUT',
      destination: 'TCP',
      onSet: false,
      onClear: false,
      address: '',
      port: 'x',
    },
  ],
  lists,
);
assert.equal(bad.length, 3, bad.join(' / '));
assert.match(s.checkAlertRows([{ ...alerts[0], address: 'a,b' }], lists)[0], /cannot contain/);
assert.match(
  s.checkAlertRows([{ ...alerts[1], sgd: '' }], {
    ...lists,
    destinations: ['UDP'],
  })[0],
  /SGD SET needs/,
);

console.log('syslog: all passing');
