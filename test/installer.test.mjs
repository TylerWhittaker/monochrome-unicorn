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

// The deploy tool's command line, and the standalone installer: its page's
// server, with a fake deploy, and the zip its macOS builds go out in.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { parseArgs, USAGE, STEPS } from '../tools/deploy.mjs';
import { assemble, STAGED_PARTS } from '../tools/assemble.mjs';
import { startGui, validAddress, explainError } from '../tools/installer/server.mjs';
import {
  zipOne,
  crc32,
  TARGETS,
  binaryName,
  assetName,
  stampScript,
} from '../tools/installer/package.mjs';

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

await check('the deploy command line keeps deploy.sh options', () => {
  assert.deepEqual(parseArgs(['192.168.1.81']), {
    ip: '192.168.1.81',
    fetchSchema: true,
    upload: true,
    clean: true,
    packed: false,
    source: null,
    help: false,
  });
  const o = parseArgs(['--packed', '10.0.0.5', '--no-clean', '--allcv', '--unpacked', '--clean']);
  assert.equal(o.ip, '10.0.0.5');
  assert.equal(o.packed, true);
  assert.equal(o.clean, false, '--clean is the default, and does not undo --no-clean');
  assert.equal(o.source, 'allcv');
  assert.equal(parseArgs(['--no-schema', '--no-upload']).ip, '', 'a build needs no printer');
  assert.throws(
    () => parseArgs([]),
    (err) => err.message === USAGE,
  );
  assert.throws(() => parseArgs(['1.2.3.4', '--bogus']), /unknown option: --bogus/);
  assert.equal(parseArgs(['--help']).help, true);
});

// A catalogue as fetch-schema.mjs compacts it, cut down to three settings.
const SCHEMA = {
  source: 'allconfig',
  types: ['string', 'enum'],
  access: ['R', 'W', 'RW', 'RW?'],
  ranges: [],
  branches: ['media', 'display'],
  slow: [],
  settings: {
    'media.darkness': [0, null, 2, '20'],
    'media.type': [1, null, 2, 'LABEL'],
    'display.text': [0, null, 0, ''],
  },
};
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const STAGED = {
  template: page,
  css: 'body{}',
  htmx: 'var htmx;',
  app: 'function start(){}',
  unpack: 'unpack();',
  version: '9.8.7',
  zplref: '{}\n',
  sgdref: '{}\n',
};

await check('a page assembles from the staged build alone, with no npm tools', () => {
  const result = assemble({ staged: STAGED, schema: SCHEMA, now: new Date(0) });
  assert.match(result.html, /Version 9\.8\.7 &middot; Built 1970-01-01 00:00:00/);
  assert.ok(!result.html.includes('{{'));
  assert.ok(result.lcd);
  assert.ok(result.helpers.some((f) => f.dest === 'E:ZPLREF.SHTML' && f.contents === '{}\n'));
  assert.ok(result.helpers.some((f) => f.dest === 'E:LCD.SHTML'));
  assert.ok(!('branchFiles' in SCHEMA), 'the caller’s catalogue is left as it was');

  const noLcd = { ...SCHEMA, settings: { 'media.type': [1, null, 2, 'LABEL'] } };
  assert.ok(!assemble({ staged: STAGED, schema: noLcd }).html.includes('data-tab="lcd"'));
});

await check('a staged build missing a part is refused', () => {
  for (const part of STAGED_PARTS) {
    const staged = { ...STAGED };
    delete staged[part];
    assert.throws(() => assemble({ staged, schema: SCHEMA }), new RegExp(`no ${part}`));
  }
});

await check('a printer address is an IP or a host name, nothing else', () => {
  for (const ok of ['192.168.1.81', 'zebra-1', 'printer.local', 'ZD620'])
    assert.ok(validAddress(ok), ok);
  for (const bad of ['', ' 1.2.3.4', 'a b', 'http://1.2.3.4', '1.2.3.4/x', '-x', 'a;b', 42])
    assert.ok(!validAddress(bad), String(bad));
});

await check('errors are put plainly, by what went wrong', () => {
  const say = (message) => explainError(new Error(message), '10.0.0.9');
  assert.match(say('getaddrinfo ENOTFOUND zebra'), /no computer called "10.0.0.9"/);
  assert.match(say('connect ECONNREFUSED 10.0.0.9:9100'), /refused port 9100/);
  assert.match(say('Timed out waiting for 10.0.0.9:9100'), /Nothing answered/);
  assert.match(say('connect EHOSTUNREACH 10.0.0.9:9100'), /same network/);
  assert.match(
    say('10.0.0.9 answered neither the JSON question nor allcv: is it a Zebra printer?'),
    /did not answer as a Zebra printer/,
  );
  assert.match(say('The printer answered 500 for INDEX.SHTML after the upload'), /restart/);
  assert.match(say('something else'), /did not finish/);
});

/** Start the page's server with a deploy that only reports. */
async function fakeGui(deploy) {
  const gui = await startGui({
    staged: STAGED,
    page: '<p>{{VERSION}} {{TOKEN}}</p><script>const S = {{STEPS}};</script>',
    version: '9.8.7',
    deploy,
  });
  const base = new URL(gui.url).origin;
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'X-Installer-Token': gui.token, ...headers },
      body: body && JSON.stringify(body),
    });
  return { ...gui, base, post };
}

await check('the page needs the token in its address, and fills in its slots', async () => {
  const gui = await fakeGui();
  try {
    assert.equal((await fetch(gui.base + '/')).status, 403);
    assert.equal((await fetch(gui.base + '/?t=wrong')).status, 403);
    const res = await fetch(gui.url);
    assert.equal(res.status, 200);
    assert.equal(
      await res.text(),
      `<p>9.8.7 ${gui.token}</p><script>const S = ${JSON.stringify(STEPS)};</script>`,
    );
  } finally {
    gui.close();
  }
});

await check('a deploy needs the token header, and a printer address', async () => {
  let called = 0;
  const gui = await fakeGui(async () => called++);
  try {
    const noToken = await fetch(gui.base + '/deploy', {
      method: 'POST',
      body: JSON.stringify({ ip: '10.0.0.9' }),
    });
    assert.equal(noToken.status, 404);
    assert.equal((await gui.post('/deploy', { ip: '10.0.0.9; rm' })).status, 400);
    assert.equal(called, 0);
  } finally {
    gui.close();
  }
});

await check('a request naming another host is refused (DNS rebinding)', async () => {
  const gui = await fakeGui();
  try {
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        `${gui.base}/?t=${gui.token}`,
        { headers: { Host: 'evil.example:80' } },
        (res) => resolve(res.statusCode),
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 421);
  } finally {
    gui.close();
  }
});

await check('a deploy streams its events, then done; one at a time', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let opts;
  const gui = await fakeGui(async (o, { emit }) => {
    opts = o;
    emit({ type: 'step', id: 'schema', label: 'Read' });
    emit({ type: 'log', text: 'hello ' });
    await gate;
    return { url: `http://${o.ip}/`, version: '9.8.7', served: '9.8.7' };
  });
  try {
    const first = gui.post('/deploy', { ip: '10.0.0.9', packed: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await gui.post('/deploy', { ip: '10.0.0.9' })).status, 409);
    release();
    const res = await first;
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
    const events = (await res.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      events.map((e) => e.type),
      ['step', 'log', 'done'],
    );
    assert.equal(events[2].url, 'http://10.0.0.9/');
    assert.equal(opts.packed, true);
    assert.equal(opts.fetchSchema, true);
  } finally {
    gui.close();
  }
});

await check('a failed deploy ends in a plain error, with the detail', async () => {
  const gui = await fakeGui(async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.9:9100');
  });
  try {
    const events = (await (await gui.post('/deploy', { ip: '10.0.0.9' })).text())
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).message, /refused port 9100/);
    assert.match(events.at(-1).detail, /ECONNREFUSED/);
  } finally {
    gui.close();
  }
});

await check('Quit ends the installer', async () => {
  const gui = await fakeGui();
  assert.equal((await gui.post('/quit')).status, 204);
  await gui.closed;
});

await check('CRC-32 is the one zip uses', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

await check('the zip holds the executable whole, marked executable', () => {
  const data = Buffer.from('#!/bin/sh\necho hello\n'.repeat(50));
  const zip = zipOne('tool', data, new Date(2026, 9, 17, 12, 30, 10));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const nameLen = zip.readUInt16LE(26);
  const size = zip.readUInt32LE(18);
  assert.equal(zip.toString('utf8', 30, 30 + nameLen), 'tool');
  const body = zip.subarray(30 + nameLen, 30 + nameLen + size);
  assert.deepEqual(inflateRawSync(body), data);
  assert.equal(zip.readUInt32LE(14), crc32(data));
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.equal(zip.readUInt16LE(central + 4) >> 8, 3, 'made on Unix');
  assert.equal((zip.readUInt32LE(central + 38) >>> 16) & 0o777, 0o755);
  const end = zip.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(zip.readUInt32LE(end + 16), central, 'the end record points at the directory');
  assert.equal(end + 22, zip.length);
});

await check('every platform has an installer, named for its version', () => {
  assert.deepEqual(
    TARGETS.map((t) => binaryName(t, '1.2.3')),
    [
      'monochrome-unicorn-1.2.3-windows-x64.exe',
      'monochrome-unicorn-1.2.3-macos-arm64',
      'monochrome-unicorn-1.2.3-macos-x64',
      'monochrome-unicorn-1.2.3-linux-x64',
      'monochrome-unicorn-1.2.3-linux-arm64',
    ],
  );
  assert.equal(assetName('1.2.3', 'SHA256SUMS'), 'monochrome-unicorn-1.2.3-SHA256SUMS');
});

await check('the install scripts name the files package.mjs makes', () => {
  const sh = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  const ps1 = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
  assert.match(sh, /^name=monochrome-unicorn-\$VERSION-\$os-\$arch$/m);
  assert.match(sh, /^sums=monochrome-unicorn-\$VERSION-SHA256SUMS$/m);
  assert.match(ps1, /^\$name = "monochrome-unicorn-\$version-windows-x64\.exe"$/m);
  assert.match(ps1, /^\$sumsName = "monochrome-unicorn-\$version-SHA256SUMS"$/m);
});

await check('a released install script fetches its own release', () => {
  const sh = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  const ps1 = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
  assert.match(stampScript(sh, '1.2.3'), /^VERSION=\$\{MONOCHROME_UNICORN_VERSION:-1\.2\.3\}$/m);
  assert.match(
    stampScript(ps1, '1.2.3'),
    /^\$version = if \(\$env:MONOCHROME_UNICORN_VERSION\) \{ \$env:MONOCHROME_UNICORN_VERSION \} else \{ '1\.2\.3' \}$/m,
  );
  assert.throws(() => stampScript('echo hi\n', '1.2.3'), /no version line/);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
