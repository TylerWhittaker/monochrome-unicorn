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

// What a deploy reports: the printer's identity, asked before anything
// is uploaded, and a start and an end that say whether it worked.

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

// Every report this file causes goes to a server of its own.
const reports = [];
const collector = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    reports.push(JSON.parse(body));
    res.writeHead(204).end();
  });
});
await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
process.env.MONOCHROME_UNICORN_TELEMETRY_URL = `http://127.0.0.1:${collector.address().port}/t`;
delete process.env.MONOCHROME_UNICORN_NO_TELEMETRY;

const { IDENTITY_QUERY, parseIdentity, identifyForTelemetry, deploy, parseArgs } =
  await import('../tools/deploy.mjs');

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

/** A fake printer; `answers` maps what a command starts with to its reply. */
async function fakePrinter(answers) {
  const server = net.createServer((socket) => {
    socket.on('data', (data) => {
      const text = data.toString('latin1');
      const key = Object.keys(answers).find((k) => text.startsWith(k));
      if (key === undefined) socket.destroy();
      else socket.end(answers[key]);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => server.close() };
}

await check('the identity is three quoted answers, "?" for one not known', () => {
  assert.deepEqual(parseIdentity('"ZD500R""40J132100037""V74.20.23Z"'), {
    model: 'ZD500R',
    serial: '40J132100037',
    firmware: 'V74.20.23Z',
  });
  assert.deepEqual(parseIdentity('"ZM400""?""V53.17.11Z"'), {
    model: 'ZM400',
    serial: '',
    firmware: 'V53.17.11Z',
  });
  assert.deepEqual(parseIdentity(''), { model: '', serial: '', firmware: '' });
});

await check('a printer that will not answer the getvars is asked ~HI', async () => {
  const fake = await fakePrinter({
    [IDENTITY_QUERY]: '"?""1234""?"',
    '~HI': '\x02ZM400-200dpi,V53.17.11Z,8,8176KB\x03',
  });
  try {
    assert.deepEqual(await identifyForTelemetry('127.0.0.1', { port: fake.port }), {
      model: 'ZM400-200dpi',
      serial: '1234',
      firmware: 'V53.17.11Z',
    });
  } finally {
    fake.close();
  }
});

await check('no printer at all is an empty identity, not a throw', async () => {
  const fake = await fakePrinter({});
  fake.close();
  assert.deepEqual(await identifyForTelemetry('127.0.0.1', { port: fake.port }), {
    model: '',
    serial: '',
    firmware: '',
  });
});

await check('a deploy that fails reports its start, and the step it failed at', async () => {
  const fake = await fakePrinter({ [IDENTITY_QUERY]: '"ZM400""40J0001""V53.17.11Z"' });
  reports.length = 0;
  const log = [];
  try {
    // The catalogue is read from 127.0.0.1:9100, where nothing listens.
    await assert.rejects(
      deploy(
        { ...parseArgs(['127.0.0.1']), port: fake.port },
        {
          staged: () => assert.fail('nothing is built for a printer that cannot be read'),
          version: '9.8.7',
          emit: (e) => e.type === 'log' && log.push(e.text),
        },
      ),
    );
  } finally {
    fake.close();
  }
  assert.equal(reports.length, 2, log.join(''));
  const [start, end] = reports;
  assert.deepEqual(
    { ...start, deploy_id: '' },
    {
      model: 'ZM400',
      serial: '40J0001',
      firmware: 'V53.17.11Z',
      version: '9.8.7',
      event: 'start',
      deploy_id: '',
    },
  );
  assert.match(start.deploy_id, /^[0-9a-f]{16}$/);
  assert.deepEqual(end, { ...start, event: 'end', ok: false, step: 'schema' });
  assert.match(log.join(''), /Telemetry: reporting this deploy's start and end, for ZM400/);
});

await check('--no-telemetry, or a build with no upload, reports nothing', async () => {
  reports.length = 0;
  const opts = { ...parseArgs(['127.0.0.1', '--no-telemetry']), fetchSchema: false };
  await assert.rejects(deploy(opts, { staged: {}, emit: () => {} }), /--no-schema needs/);
  const build = { ...parseArgs(['--no-upload', '--no-schema']) };
  await assert.rejects(deploy(build, { staged: {}, emit: () => {} }), /--no-schema needs/);
  assert.equal(reports.length, 0);
});

collector.close();
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exitCode = failures ? 1 : 0;
