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

// The diagnostic log a failed deploy leaves: what the printer said, how
// and when, with its secrets out; and sending it. Run: node test/diag.test.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Telemetry and logs from this file go to a server of its own.
const received = [];
let answer = (res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
let answerReport = (res) => res.writeHead(204).end();
const collector = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    received.push({ url: req.url, body: JSON.parse(body) });
    if (req.url.endsWith('/log')) answer(res, JSON.parse(body));
    else answerReport(res, JSON.parse(body));
  });
});
await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
process.env.MONOCHROME_UNICORN_TELEMETRY_URL = `http://127.0.0.1:${collector.address().port}/t`;

const { deploy, parseArgs, sendDiagnosticLog, logHeader, writeDiagnosticLog, LOG_LIMIT } =
  await import('../tools/deploy.mjs');
const {
  escapeBytes,
  redact,
  capText,
  formatTrace,
  startTrace,
  stopTrace,
  traceConnection,
  failureCause,
  CAUSES,
} = await import('../tools/diag.mjs');
const { parseListing, checkUploaded, LIST_E } = await import('../tools/deploy.mjs');
const { uploadFile } = await import('../tools/upload.mjs');

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

/**
 * A fake printer; `answers` maps what a command starts with to its
 * reply, or to a list of pieces sent 30 ms apart. Anything else is hung
 * up on, as quick a "nothing" as a real printer's silence.
 */
async function fakePrinter(answers) {
  const server = net.createServer((socket) => {
    socket.on('data', async (data) => {
      const text = data.toString('latin1');
      const key = Object.keys(answers).find((k) => text.startsWith(k));
      if (key === undefined) return socket.destroy();
      const pieces = [].concat(answers[key]);
      for (const [i, piece] of pieces.entries()) {
        if (i) await new Promise((r) => setTimeout(r, 30));
        socket.write(piece);
      }
      socket.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => server.close() };
}

await check('replies are shown byte for byte, line endings and all', () => {
  assert.equal(escapeBytes('\x02ZM400\x03\r\nnext\tline'), '\\x02ZM400\\x03\\r\\n\nnext\\tline');
  assert.equal(escapeBytes('caf\xe9'), 'caf\\xe9');
});

await check("secret settings' values are taken out, in allcv's shape and JSON's", () => {
  const allcv = [
    'wlan.wep.key1 : 0123456789 , Choices: 0-9',
    'wlan.wpa.psk : hunter2',
    'ip.snmp.get_community_name : public',
    'bluetooth.pin : 4321',
    'wlan.essid : Office',
    'media.darkness : 20 , Choices: 0-30',
    'wlan.wep.key2 : ',
  ].join('\r\n');
  assert.equal(
    redact(allcv),
    [
      'wlan.wep.key1 : <redacted> , Choices: 0-9',
      'wlan.wpa.psk : <redacted>',
      'ip.snmp.get_community_name : <redacted>',
      'bluetooth.pin : <redacted>',
      'wlan.essid : Office',
      'media.darkness : 20 , Choices: 0-30',
      'wlan.wep.key2 : ',
    ].join('\r\n'),
  );
  assert.equal(
    redact('{"wlan.wpa.psk":{"value":"hunter2","type":"string"},"wlan.essid":{"value":"Office"}}'),
    '{"wlan.wpa.psk":{"value":"<redacted>","type":"string"},"wlan.essid":{"value":"Office"}}',
  );
  assert.equal(redact('{"wlan.password":"s3cr\\"et"}'), '{"wlan.password":"<redacted>"}');
  // Not a setting called "pin": spinning, mapping.
  assert.equal(redact('media.spinning : on'), 'media.spinning : on');
});

await check('a reply too long to keep whole keeps its head and tail', () => {
  const capped = capText('a'.repeat(300) + 'b'.repeat(100), 200);
  assert.ok(capped.startsWith('a'.repeat(150)));
  assert.ok(capped.endsWith('b'.repeat(50)));
  assert.match(capped, /\[\.\.\. 200 characters cut \.\.\.\]/);
  assert.equal(capText('short', 200), 'short');
});

await check('a failed deploy against an old printer leaves a log of every exchange', async () => {
  const fake = await fakePrinter({
    '! U1 getvar "device.product_name"': '"ZM400""40J0001""V53.17.11Z"',
    '~HI': '\x02ZM400-200dpi,V53.17.11Z,8,8176KB\x03',
    // Pre-Link-OS: no answer to the JSON question, and an allcv that
    // comes in two pieces and holds nothing that looks like a setting.
    '! U1 getvar "allcv"': ['Unknown command\r\n', 'Error\r\n'],
  });
  let error;
  try {
    error = await deploy(
      { ...parseArgs(['127.0.0.1', '--no-telemetry']), port: fake.port },
      { staged: () => assert.fail('nothing is built'), version: '9.8.7', emit: () => {} },
    ).catch((err) => err);
  } finally {
    fake.close();
  }
  assert.ok(error instanceof Error, 'the deploy failed');
  const log = error.diagnosticLog;
  assert.equal(typeof log, 'string');
  assert.match(error.deployId, /^[0-9a-f]{16}$/);
  assert.equal(logHeader(log).deployId, error.deployId);
  assert.equal(logHeader(log).version, '9.8.7');
  assert.match(log, /^failed at step: schema$/m);
  assert.match(log, /^likely cause: other -- none of the known causes$/m);
  assert.match(log, /^os: /m);
  assert.match(log, /\| Asking 127\.0\.0\.1 what it is \.\.\./);
  // ~HI's answer, byte for byte, and how its read ended.
  assert.match(log, /> ~HI\\r\\n/);
  assert.match(log, /\| \\x02ZM400-200dpi,V53\.17\.11Z,8,8176KB\\x03/);
  assert.match(log, /ended: closed by the printer/);
  // The JSON question, unanswered.
  assert.match(
    log,
    /> \{\}\{"appl\.name":null\}\\r\\n\n {2}connected: \+\d+ ms\n {2}received 0 bytes/,
  );
  // allcv, both chunks.
  assert.match(log, /received 24 bytes in 2 chunks: \+\d+ ms 17, \+\d+ ms 7/);
  assert.match(log, /\| Unknown command\\r\\n\n {2}\| Error\\r\\n/);
  assert.match(log, /^error:\nError: Nothing in the allcv reply looked like a setting/m);
  assert.match(log, /at fetchSchema/, 'the stack');
  assert.equal(stopTrace(), null, 'the trace is over');
});

await check("an upload's contents stay out of the log, only its header goes in", async () => {
  const fake = await fakePrinter({});
  const trace = startTrace({});
  try {
    await uploadFile('127.0.0.1', 'secret page contents', 'E:INDEX.SHTML', {
      port: fake.port,
      quiet: 0.05,
    });
  } catch {
    // The fake hangs up; whether that throws does not matter here.
  } finally {
    stopTrace();
    fake.close();
  }
  const log = formatTrace(trace);
  assert.match(log, /> ! CISDFCRC16\\r\\n/);
  assert.match(log, /<20 bytes of E:INDEX\.SHTML>/);
  assert.doesNotMatch(log, /secret page contents/);
});

await check('outside a deploy, nothing is recorded', () => {
  assert.equal(stopTrace(), null);
  const conn = traceConnection('x:9100', 'sent');
  conn.connected();
  conn.data(Buffer.from('x'));
  conn.end('closed');
  assert.equal(stopTrace(), null);
});

await check(
  'a log is sent with its deploy id and version, and comes back a reference',
  async () => {
    received.length = 0;
    answer = (res, body) =>
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ reference: body.deploy_id }));
    const outcome = await sendDiagnosticLog('the log', {
      deployId: '0123456789abcdef',
      version: '9.8.7',
    });
    assert.deepEqual(outcome, { reference: '0123456789abcdef' });
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/t/log');
    assert.deepEqual(received[0].body, {
      deploy_id: '0123456789abcdef',
      version: '9.8.7',
      log: 'the log',
    });
  },
);

await check('a log with no id gets one, and one too long is cut to fit', async () => {
  received.length = 0;
  await sendDiagnosticLog('x'.repeat(LOG_LIMIT + 5000), { deployId: '' });
  const { body } = received[0];
  assert.match(body.deploy_id, /^[0-9a-f]{16}$/);
  assert.ok(body.log.length <= LOG_LIMIT, `${body.log.length} characters`);
});

await check('a server that refuses it, or is not there, is a reason, not a throw', async () => {
  answer = (res) => res.writeHead(507).end();
  assert.deepEqual(await sendDiagnosticLog('x', {}), { error: 'the server answered 507' });
  const gone = await sendDiagnosticLog('x', { url: 'http://127.0.0.1:1/log' });
  assert.ok(gone.error, JSON.stringify(gone));
});

await check('a log is written into its directory, made if need be', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-diag-'));
  try {
    const path = writeDiagnosticLog('the log', join(dir, 'logs'));
    assert.match(path, /deploy-failed-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.log$/);
    assert.equal(readFileSync(path, 'utf8'), 'the log');
    // Two in the same second, from two deploys, are two files.
    const a = writeDiagnosticLog('deploy_id: 0123456789abcdef\n', dir);
    const b = writeDiagnosticLog('deploy_id: fedcba9876543210\n', dir);
    assert.notEqual(a, b);
    assert.match(a, /Z-0123456789abcdef\.log$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check('--send-log and --send-log-file are options; the second needs no printer', () => {
  assert.equal(parseArgs(['1.2.3.4', '--send-log']).sendLog, true);
  assert.equal(parseArgs(['--send-log-file', 'x.log']).sendLogFile, 'x.log');
  assert.throws(() => parseArgs(['--send-log-file']), /needs the log/);
});

await check(
  'a failure is given a cause: from its code, its message, or what the printer said',
  () => {
    const coded = (code) => Object.assign(new Error('x'), { code });
    const fetchFailed = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
    assert.equal(failureCause(coded('http-off')), 'http-off');
    assert.equal(failureCause(coded('upload-missing')), 'upload-missing');
    // Port 9100's errors.
    assert.equal(
      failureCause(new Error('Could not reach 10.0.0.5:9100: connect ECONNREFUSED 10.0.0.5:9100')),
      'printer-refused',
    );
    assert.equal(
      failureCause(new Error('Could not reach 10.0.0.5:9100: connect EHOSTUNREACH 10.0.0.5:9100')),
      'printer-unreachable',
    );
    assert.equal(
      failureCause(new Error('Could not reach nope:9100: getaddrinfo ENOTFOUND nope')),
      'printer-unknown',
    );
    assert.equal(failureCause(new Error('No response from 10.0.0.5:9100')), 'printer-silent');
    assert.equal(failureCause(new Error('Timed out waiting for 10.0.0.5:9100')), 'printer-silent');
    // fetch()'s, as node and as bun put them.
    assert.equal(failureCause(fetchFailed('ECONNREFUSED')), 'http-refused');
    const bun = Object.assign(
      new TypeError('Unable to connect. Is the computer able to access the url?'),
      { code: 'ConnectionRefused' },
    );
    assert.equal(failureCause(bun), 'http-refused');
    assert.equal(
      failureCause(Object.assign(new Error('t'), { name: 'TimeoutError' })),
      'http-timeout',
    );
    // A refusal on port 80 from a printer whose settings say its web
    // server is off: the 0.55.3 log of a ZD621R, in miniature.
    const listing =
      '{"allconfig":\r\n{"ip.http.enable":{"value":"off","type":"bool","default":"off"},\r\n';
    assert.equal(failureCause(bun, listing), 'http-off');
    assert.equal(failureCause(bun, '"off""80"'), 'http-refused', 'only the named setting counts');
    assert.equal(
      failureCause(new Error('anything else'), listing),
      'other',
      'not for a non-HTTP failure',
    );
    for (const code of Object.keys(CAUSES)) {
      assert.match(code, /^[a-z-]{1,24}$/, 'what the server takes');
    }
  },
);

await check("the log's header says the likely cause", () => {
  startTrace({ version: '1.2.3' });
  const log = formatTrace(stopTrace(), {
    error: new Error('x'),
    step: 'verify',
    cause: 'http-off',
  });
  assert.match(
    log,
    /^failed at step: verify\nlikely cause: http-off -- the printer's web server is turned off \(ip\.http\.enable\)$/m,
  );
});

await check('a ^HW listing is read as names and sizes; anything else is not one', () => {
  const files = parseListing(
    '\x02\r\n- DIR E:*.* \r\n* E:INDEX.SHTML    538999          \r\n' +
      '* E:TT0003M_.TTF    169188  P       \r\n\r\n-  56822272 bytes free E: ONBOARD FLASH \r\n\x03',
  );
  assert.deepEqual(
    [...files],
    [
      ['E:INDEX.SHTML', 538999],
      ['E:TT0003M_.TTF', 169188],
    ],
  );
  assert.deepEqual([...parseListing('\x02\r\n- DIR E:*.* \r\n\r\n-  1 bytes free\r\n\x03')], []);
  assert.equal(parseListing(''), null);
  assert.equal(parseListing('Unknown command'), null);
});

await check('after the upload, each file is looked for on E: at the size it was sent', async () => {
  const fake = await fakePrinter({
    '^XA^HWE:':
      '\x02\r\n- DIR E:*.* \r\n* E:INDEX.SHTML    500          \r\n* E:V_1.SHTML    40\r\n\x03',
  });
  const logged = [];
  const log = (t) => logged.push(t);
  try {
    assert.equal(LIST_E, '^XA^HWE:*.*^XZ\r\n');
    await checkUploaded('127.0.0.1', [{ name: 'E:INDEX.SHTML', bytes: 500 }], {
      log,
      port: fake.port,
    });
    assert.match(logged.join(''), /all 1 there/);
    const err = await checkUploaded(
      '127.0.0.1',
      [
        { name: 'E:INDEX.SHTML', bytes: 500 },
        { name: 'E:V_1.SHTML', bytes: 41 },
        { name: 'E:V_2.SHTML', bytes: 9 },
      ],
      { log, port: fake.port },
    ).catch((e) => e);
    assert.equal(err.code, 'upload-missing');
    assert.match(err.message, /2 of the 3 files .* E:V_1\.SHTML, E:V_2\.SHTML/);
    assert.match(logged.join(''), /E:V_1\.SHTML: sent 41 bytes, 40 there/);
    assert.match(logged.join(''), /E:V_2\.SHTML: sent 9 bytes, not there/);
  } finally {
    fake.close();
  }
  // A printer that will not list is let through.
  const deaf = await fakePrinter({});
  try {
    await checkUploaded('127.0.0.1', [{ name: 'E:X', bytes: 1 }], { log, port: deaf.port });
    assert.match(logged.join(''), /would not list E:, so not checked/);
  } finally {
    deaf.close();
  }
});

await check(
  "a failed deploy's end report carries its cause, and an older server still gets one",
  async () => {
    // Nothing listens on this port: the web server is "off".
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const httpPort = s.address().port;
    await new Promise((r) => s.close(r));
    const fake = await fakePrinter({
      '! U1 getvar "device.product_name"': '"ZD621R""DBJ0001""V93.21.48Z"',
      '! U1 getvar "ip.http.enable"': `"off""${httpPort}"""`,
    });
    const run = () =>
      deploy(
        { ...parseArgs(['127.0.0.1', '--no-schema']), port: fake.port, httpPort },
        {
          staged: () => assert.fail('nothing is built'),
          readSchema: () => ({}),
          version: '9.8.7',
          emit: () => {},
        },
      ).catch((e) => e);
    try {
      received.length = 0;
      const err = await run();
      assert.equal(err.code, 'http-off');
      assert.match(err.diagnosticLog, /^likely cause: http-off -- /m);
      const end = received.find((r) => r.body.event === 'end');
      assert.deepEqual(
        { ok: end.body.ok, step: end.body.step, cause: end.body.cause },
        { ok: false, step: 'web', cause: 'http-off' },
      );
      // A server from before causes refuses the field: sent again without it.
      received.length = 0;
      answerReport = (res, body) => res.writeHead('cause' in body ? 422 : 204).end();
      await run();
      const ends = received.filter((r) => r.body.event === 'end');
      assert.equal(ends.length, 2);
      assert.equal(ends[0].body.cause, 'http-off');
      assert.ok(!('cause' in ends[1].body));
      assert.equal(ends[1].body.step, 'web');
    } finally {
      answerReport = (res) => res.writeHead(204).end();
      fake.close();
    }
  },
);

collector.close();
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exitCode = failures ? 1 : 0;
