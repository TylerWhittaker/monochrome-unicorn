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

// Whether the printer will serve the page, asked before a deploy uploads
// anything: and when it will not, why, and turning its web server on.

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  checkWebServer,
  parseWebSettings,
  webBase,
  deploy,
  parseArgs,
  STEPS,
} from '../tools/deploy.mjs';
import { explainError } from '../tools/installer/server.mjs';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.stack}`);
  }
}

/** A port that nothing listens on, until something is told to. */
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * A fake printer: port 9100's getvars, setvar and device.reset, and a
 * web server on `httpPort` that is up only while ip.http.enable was on
 * at its last "restart" -- as a real one is.
 */
async function fakePrinter({ enable = 'on', whitelist = '', serving = null } = {}) {
  const httpPort = await freePort();
  // ip.http.port: where its web server listens.
  const state = { enable, port: String(httpPort), whitelist, heard: [] };
  let web = null;
  const startWeb = async () => {
    if (web) return;
    web = http.createServer((req, res) => res.writeHead(200).end('<title>Zebra</title>'));
    await new Promise((r) => web.listen(httpPort, '127.0.0.1', r));
  };
  const stopWeb = async () => {
    if (!web) return;
    web.closeAllConnections();
    await new Promise((r) => web.close(r));
    web = null;
  };
  if (serving ?? enable === 'on') await startWeb();

  const raw = net.createServer((socket) => {
    socket.on('data', async (data) => {
      const text = data.toString('latin1');
      state.heard.push(text);
      if (text.includes('device.reset')) {
        const m = /setvar "ip\.http\.enable" "(\w+)"/.exec(text);
        if (m) state.enable = m[1];
        socket.destroy();
        await stopWeb();
        // Back after a moment, serving if it is now turned on.
        setTimeout(() => {
          state.restarted = true;
          if (state.enable === 'on') startWeb();
        }, 100);
        return;
      }
      if (text.includes('getvar "ip.http.port"')) {
        socket.end(`"${state.enable}""${state.port}""${state.whitelist}"`);
      } else if (text.includes('getvar "ip.http.enable"')) {
        socket.end(`"${state.enable}"`);
      } else socket.destroy();
    });
  });
  await new Promise((r) => raw.listen(0, '127.0.0.1', r));
  return {
    state,
    opts: { port: raw.address().port, httpPort },
    httpPort,
    close: async () => {
      raw.close();
      await stopWeb();
    },
  };
}

const quiet = () => {};
const fast = { pause: 50, waitMs: 5000 };

await check('the base URL leaves out port 80, and names any other', () => {
  assert.equal(webBase('10.0.0.5'), 'http://10.0.0.5');
  assert.equal(webBase('10.0.0.5', '80'), 'http://10.0.0.5');
  assert.equal(webBase('10.0.0.5', 8080), 'http://10.0.0.5:8080');
});

await check("the web settings' answers, back to back, with ? for one not known", () => {
  assert.deepEqual(parseWebSettings('"off""80"""'), { enable: 'off', port: '80', whitelist: '' });
  assert.deepEqual(parseWebSettings('"on""?""?"'), { enable: 'on', port: '', whitelist: '' });
  assert.deepEqual(parseWebSettings(''), { enable: '', port: '', whitelist: '' });
});

await check('--enable-http is an option, and the check is a step of its own', () => {
  assert.equal(parseArgs(['10.0.0.5', '--enable-http']).enableHttp, true);
  assert.equal(parseArgs(['10.0.0.5']).enableHttp, false);
  assert.deepEqual(
    STEPS.map((s) => s.id),
    ['schema', 'web', 'build', 'clean', 'upload', 'verify'],
  );
});

await check('a printer that serves costs one request, and nothing on 9100', async () => {
  const fake = await fakePrinter();
  try {
    const base = await checkWebServer('127.0.0.1', fake.opts, { log: quiet });
    assert.equal(base, `http://127.0.0.1:${fake.httpPort}`);
    assert.deepEqual(fake.state.heard, []);
  } finally {
    await fake.close();
  }
});

await check('web server off, and no leave to turn it on: stops, saying so', async () => {
  const fake = await fakePrinter({ enable: 'off' });
  let asked = 0;
  try {
    const err = await checkWebServer('127.0.0.1', fake.opts, {
      log: quiet,
      confirmEnableHttp: async () => (asked++, false),
    }).catch((e) => e);
    assert.equal(err.code, 'http-off');
    assert.match(err.message, /ip\.http\.enable/);
    assert.match(err.message, /--enable-http/);
    assert.equal(asked, 1);
    assert.ok(!fake.state.heard.some((t) => /setvar|device\.reset/.test(t)), 'nothing changed');
    assert.match(explainError(err, '127.0.0.1'), /web server is turned off.*Nothing was installed/);
  } finally {
    await fake.close();
  }
});

await check('web server off, and leave given: turned on, restarted, and waited for', async () => {
  for (const how of ['flag', 'asked']) {
    const fake = await fakePrinter({ enable: 'off' });
    try {
      const base = await checkWebServer(
        '127.0.0.1',
        { ...fake.opts, enableHttp: how === 'flag' },
        { log: quiet, confirmEnableHttp: async () => how === 'asked', ...fast },
      );
      assert.equal(base, `http://127.0.0.1:${fake.httpPort}`);
      assert.equal(fake.state.enable, 'on', how);
      assert.ok(fake.state.restarted, `${how}: restarted`);
      const sent = fake.state.heard.find((t) => t.includes('device.reset'));
      assert.match(sent, /setvar "ip\.http\.enable" "on"\r\n! U1 do "device\.reset" ""/);
    } finally {
      await fake.close();
    }
  }
});

await check('a web server on another port is used there', async () => {
  const fake = await fakePrinter({ serving: false });
  const other = http.createServer((req, res) => res.writeHead(200).end());
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  fake.state.port = String(other.address().port);
  try {
    const base = await checkWebServer('127.0.0.1', fake.opts, { log: quiet });
    assert.equal(base, `http://127.0.0.1:${other.address().port}`);
  } finally {
    other.close();
    await fake.close();
  }
});

await check('on, but not answering: the allowed-address list, or the network', async () => {
  const listed = await fakePrinter({ serving: false, whitelist: '10.9.9.9' });
  try {
    const err = await checkWebServer('127.0.0.1', listed.opts, { log: quiet }).catch((e) => e);
    assert.equal(err.code, 'http-firewall');
    assert.match(err.message, /10\.9\.9\.9/);
  } finally {
    await listed.close();
  }
  const blocked = await fakePrinter({ serving: false });
  try {
    const err = await checkWebServer('127.0.0.1', blocked.opts, { log: quiet }).catch((e) => e);
    assert.equal(err.code, 'http-unreachable');
    assert.match(explainError(err, '127.0.0.1'), /could not reach it/);
  } finally {
    await blocked.close();
  }
});

await check(
  'a deploy to a printer that cannot serve stops before building or uploading',
  async () => {
    const fake = await fakePrinter({ enable: 'off' });
    try {
      const err = await deploy(
        { ...parseArgs(['127.0.0.1', '--no-schema', '--no-telemetry']), ...fake.opts },
        {
          staged: () => assert.fail('nothing is built'),
          readSchema: () => ({}),
          version: '9.8.7',
          emit: () => {},
        },
      ).catch((e) => e);
      assert.equal(err.code, 'http-off');
      assert.match(err.diagnosticLog, /^failed at step: web$/m);
      assert.match(err.diagnosticLog, /ip\.http\.enable "off"/);
      assert.ok(!fake.state.heard.some((t) => t.includes('CISDFCRC16')), 'nothing uploaded');
    } finally {
      await fake.close();
    }
  },
);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
