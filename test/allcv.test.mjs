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

/* The catalogue a pre-Link-OS printer gives. Run: node test/allcv.test.mjs */
import assert from 'node:assert/strict';
import {
  parseAllcv,
  parseHostIdentification,
  allcvLooksComplete,
  compactSchema,
  typeFromEntry,
  accessFromEntry,
  mergeUserVars,
  answersJsonProbe,
  speaksJson,
  fetchSchema,
  LINK_OS_FIRMWARE,
} from '../tools/fetch-schema.mjs';
import net from 'node:net';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Which printer is this
 * ------------------------------------------------------------------ */

check('~HI gives the firmware version, STX/ETX and all', () => {
  // What the bench ZD500R actually answers.
  const linkOs = parseHostIdentification(
    '\x02ZD500R-300dpi,V74.20.23Z,12,4096KB,CUTTER DETECTED\x03\r\n',
  );
  assert.equal(linkOs.model, 'ZD500R-300dpi');
  assert.equal(linkOs.version, 'V74.20.23Z');
  assert.equal(linkOs.major, 74);
  assert.equal(linkOs.preLinkOs, false);
});

check('firmware below V68 is pre-Link-OS', () => {
  assert.equal(parseHostIdentification('\x02QL320 Plus,V54.16.3Z,8,1024KB\x03').preLinkOs, true);
  assert.equal(
    parseHostIdentification(`\x02X,V${LINK_OS_FIRMWARE - 1}.0.0Z,8\x03`).preLinkOs,
    true,
  );
  assert.equal(parseHostIdentification(`\x02X,V${LINK_OS_FIRMWARE}.0.0Z,8\x03`).preLinkOs, false);
});

check('an unreadable ~HI is treated as Link-OS rather than guessed at', () => {
  const unknown = parseHostIdentification('garbage');
  assert.equal(unknown.version, null);
  assert.equal(unknown.preLinkOs, false, 'the JSON path is the safer default');
});

/* ------------------------------------------------------------------ *
 * Knowing when the listing has finished
 * ------------------------------------------------------------------ */

check('the closing quote line ends the listing, but only unterminated', () => {
  assert.equal(allcvLooksComplete('a.b : 1\r\n"'), true);
  assert.equal(allcvLooksComplete('a.b : 1\r\n""'), true, 'the bench printer sends two');
  assert.equal(
    allcvLooksComplete('a.b : 1\r\n"\r\n'),
    false,
    'a quote with a line ending after it is part of a value, not the end',
  );
  assert.equal(allcvLooksComplete('a.b : 1\r\n'), false);
  assert.equal(allcvLooksComplete(''), false);
});

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

// Every shape the format has, including the two that make it awkward:
// a value that runs over several lines, and a quote alone on a line
// inside one.
const SAMPLE =
  [
    'bluetooth.',
    'bluetooth.discoverable : off , Choices: on,off',
    'bluetooth.friendly_name : 40J132100037 ',
    'bluetooth.clear_bonding_cache',
    'bluetooth.minimum_security_mode : 4 , Choices: 1,2,3,4',
    'ip.',
    'ip.ping_remote',
    'ip.dhcp.lease.length : 86400 , Choices: 0-4294967295',
    'ip.netstat : Active Internet connections',
    'Proto Recv-Q Send-Q  Local Address          Foreign Address        State',
    'tcp        0      0  *.9100                 *.*                    LISTEN',
    'device.',
    'device.syslog : line one',
    '"',
    'line after a lone quote',
    'device.epl_legacy_mode : allow , Choices: allow,disallow',
    'print.',
    'print.tone : 15.0 , Choices: -30.0-30.0',
  ].join('\r\n') + '\r\n"';

const config = parseAllcv(SAMPLE);

check('categories are markers, not settings', () => {
  assert.ok(!('bluetooth.' in config) && !('ip.' in config));
  assert.equal(Object.keys(config).length, 10);
});

check('a listed choice means the printer will take it: read/write', () => {
  assert.equal(config['bluetooth.discoverable'].access, 'RW');
  assert.equal(config['bluetooth.discoverable'].range, 'on,off');
  assert.equal(config['bluetooth.discoverable'].type, 'bool');
});

check('a name with no value at all is a command', () => {
  assert.equal(config['bluetooth.clear_bonding_cache'].access, 'W');
  assert.equal(config['ip.ping_remote'].access, 'W');
});

check('a value with no choices is unverified, not read-only', () => {
  // Measured against the same printer's allconfig: 195 of these were
  // read-only and 111 were writable, so neither answer is right.
  assert.equal(config['bluetooth.friendly_name'].access, 'RW?');
  assert.equal(config['ip.netstat'].access, 'RW?');
});

check('allcv knows no factory defaults, and none are invented', () => {
  for (const meta of Object.values(config)) assert.equal(meta.default, null);
});

check('trailing spaces go, and the value keeps its own content', () => {
  assert.equal(config['bluetooth.friendly_name'].range, '');
  assert.equal(config['bluetooth.minimum_security_mode'].range, '1,2,3,4');
  assert.equal(config['bluetooth.minimum_security_mode'].type, 'enum');
});

check('a multi-line value does not start new settings', () => {
  assert.ok(!('Proto' in config) && !('tcp' in config));
  assert.ok(!('line after a lone quote' in config));
  assert.ok('device.syslog' in config, 'a quote inside a value is just a line');
  assert.ok('device.epl_legacy_mode' in config, 'the setting after it still parses');
});

check('the closing quote line is not a setting either', () => {
  assert.ok(!('"' in config));
});

/* ------------------------------------------------------------------ *
 * Inference
 * ------------------------------------------------------------------ */

check('type is read off the shape of the choices', () => {
  assert.equal(typeFromEntry({ choices: 'on,off' }), 'bool');
  assert.equal(typeFromEntry({ choices: 'OFF,ON' }), 'bool', 'case does not matter');
  assert.equal(typeFromEntry({ choices: '1,2,3,4' }), 'enum');
  assert.equal(typeFromEntry({ choices: '0-4294967295' }), 'integer');
  assert.equal(typeFromEntry({ choices: '-30.0-30.0' }), 'double', 'a negative low bound');
  assert.equal(typeFromEntry({ choices: null }), 'string');
});

check('a range the settings editor can use comes through intact', () => {
  assert.equal(config['ip.dhcp.lease.length'].type, 'integer');
  assert.equal(config['ip.dhcp.lease.length'].range, '0-4294967295');
  assert.equal(config['print.tone'].type, 'double');
  assert.equal(config['print.tone'].range, '-30.0-30.0');
});

check('access is decided by what the entry has', () => {
  assert.equal(accessFromEntry({ value: null, choices: null }), 'W');
  assert.equal(accessFromEntry({ value: 'x', choices: 'a,b' }), 'RW');
  assert.equal(accessFromEntry({ value: 'x', choices: null }), 'RW?');
});

/* ------------------------------------------------------------------ *
 * The schema the page is built with
 * ------------------------------------------------------------------ */

check('an allcv schema says so, and carries the same shape as a JSON one', () => {
  const schema = compactSchema(config, 'allcv');
  assert.equal(schema.source, 'allcv');
  assert.ok(schema.access.includes('RW?'), 'the unverified state has a code');
  assert.deepEqual(schema.branches, ['bluetooth', 'device', 'ip', 'print']);

  const [type, range, access, def] = schema.settings['bluetooth.discoverable'];
  assert.equal(schema.types[type], 'bool');
  assert.equal(schema.ranges[range], 'on,off');
  assert.equal(schema.access[access], 'RW');
  assert.equal(def, null);
});

check('slow settings are only listed when the printer has them', () => {
  // The list follows the catalogue rather than naming settings that
  // will never be asked for: file.dir is in allcv but not in allconfig,
  // and ip.netstat -- a page of connections -- is in this sample.
  assert.deepEqual(compactSchema(config, 'allcv').slow, ['ip.netstat']);
  const withDir = {
    ...config,
    'file.dir': { type: 'string', range: '', access: 'R', default: null },
  };
  assert.deepEqual(compactSchema(withDir, 'allcv').slow, ['file.dir', 'ip.netstat']);
});

check('user variables, which allconfig leaves out, are added from the branch', () => {
  // A getvar of device.user_vars, as a ZD500R answers it.
  const listing = [
    'device.user_vars.',
    'device.user_vars.create',
    'device.user_vars.set_range',
    'device.user_vars.test_string : hello ',
    'device.user_vars.test_integer : 5 , Choices: 1-100',
    'device.user_vars.test_double : 1.5 , Choices: 0.5-99.5',
    'device.user_vars.test_choices : green , Choices: red,green,blue',
  ].join('\r\n');
  const config = { 'device.user_vars.create': { type: 'string', range: '', access: 'W' } };
  assert.equal(mergeUserVars(config, listing), 4);
  assert.deepEqual(config['device.user_vars.test_choices'], {
    type: 'enum',
    range: 'red,green,blue',
    access: 'RW',
    default: null,
  });
  assert.equal(config['device.user_vars.test_integer'].type, 'integer');
  assert.equal(config['device.user_vars.test_double'].type, 'double');
  assert.equal(config['device.user_vars.test_string'].type, 'string');
  assert.equal(config['device.user_vars.test_string'].access, 'RW', 'writable, not RW?');
  assert.equal(config['device.user_vars.create'].access, 'W', 'what allconfig said stands');
});

/* ------------------------------------------------------------------ *
 * Asking the printer whether it speaks JSON, rather than going by its
 * firmware: a fake printer on 127.0.0.1 that answers what it is told to,
 * and hangs up on the rest -- as quick a "nothing" as a real printer's
 * silence, without the wait.
 * ------------------------------------------------------------------ */

/** Start a fake printer; `answers` maps what a command starts with to its reply. */
async function fakePrinter(answers) {
  const heard = [];
  const server = net.createServer((socket) => {
    socket.on('data', (data) => {
      const text = data.toString('latin1');
      heard.push(text);
      const key = Object.keys(answers).find((k) => text.startsWith(k));
      if (key === undefined) socket.destroy();
      else socket.end(answers[key]);
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return { port: server.address().port, heard, close: () => server.close() };
}

const ALLCONFIG = JSON.stringify({
  allconfig: {
    'media.darkness': { type: 'integer', range: '0-30', access: 'RW', value: '20', default: '20' },
  },
});
const ALLCV = 'media.\r\nmedia.darkness : 20 , Choices: 0-30\r\n"';
const quiet = () => {};

await check('a JSON answer to the probe means JSON; anything else does not', () => {
  assert.equal(answersJsonProbe('{"appl.name":"V84.20.23Z"}'), true);
  assert.equal(answersJsonProbe(''), false);
  assert.equal(answersJsonProbe('"V54.16.3Z"'), false, 'a getvar answer is not JSON');
  assert.equal(answersJsonProbe('{"other":1}'), false);
  assert.equal(answersJsonProbe('{"appl.name":'), false);
});

await check('a printer that answers the JSON probe is read with allconfig', async () => {
  const fake = await fakePrinter({
    '~HI': '\x02ZD620-203dpi,V84.20.23Z,8,8176KB\x03',
    '{}{"appl.name"': '{"appl.name":"V84.20.23Z"}',
    '{}{"allconfig"': ALLCONFIG,
    '! U1 getvar "device.user_vars"': '"device.user_vars : "',
  });
  try {
    assert.equal(await speaksJson('127.0.0.1', { port: fake.port }), true);
    const schema = await fetchSchema('127.0.0.1', { port: fake.port, log: quiet });
    assert.equal(schema.source, 'allconfig');
    assert.ok(!fake.heard.some((t) => t.includes('allcv')));
  } finally {
    fake.close();
  }
});

await check('Link-OS firmware with no JSON answer is read with allcv, and says why', async () => {
  // Firmware the version check would have sent to JSON.
  const fake = await fakePrinter({
    '~HI': '\x02ZD500R-300dpi,V74.20.23Z,12,4096KB\x03',
    '! U1 getvar "allcv"': ALLCV,
  });
  let said = '';
  try {
    const schema = await fetchSchema('127.0.0.1', {
      port: fake.port,
      log: (t) => (said += t),
    });
    assert.equal(schema.source, 'allcv');
    assert.ok('media.darkness' in schema.settings);
    assert.match(said, /no JSON answer, trying allcv/);
    assert.match(said, /JSON channel may be turned off/);
    assert.ok(!fake.heard.some((t) => t.includes('allconfig')), 'allconfig never asked for');
  } finally {
    fake.close();
  }
});

await check('old firmware that does answer JSON is read with allconfig after all', async () => {
  const fake = await fakePrinter({
    '~HI': '\x02QL320 Plus,V54.16.3Z,8,1024KB\x03',
    '{}{"appl.name"': '{"appl.name":"V54.16.3Z"}',
    '{}{"allconfig"': ALLCONFIG,
    '! U1 getvar "device.user_vars"': '"device.user_vars : "',
  });
  try {
    const schema = await fetchSchema('127.0.0.1', { port: fake.port, log: quiet });
    assert.equal(schema.source, 'allconfig');
  } finally {
    fake.close();
  }
});

await check('no answer to ~HI does not stop it; no answer to anything does', async () => {
  const fake = await fakePrinter({ '! U1 getvar "allcv"': ALLCV });
  try {
    const schema = await fetchSchema('127.0.0.1', { port: fake.port, log: quiet });
    assert.equal(schema.source, 'allcv');
  } finally {
    fake.close();
  }
  const silent = await fakePrinter({});
  try {
    await assert.rejects(
      fetchSchema('127.0.0.1', { port: silent.port, log: quiet }),
      /answered neither the JSON question nor allcv/,
    );
  } finally {
    silent.close();
  }
});

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
