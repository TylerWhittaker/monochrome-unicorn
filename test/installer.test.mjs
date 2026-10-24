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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  parseArgs,
  runCli,
  USAGE,
  STEPS,
  telemetryFromPage,
  sendTelemetry,
} from '../tools/deploy.mjs';
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

// The tests' own environment must not turn telemetry off for them.
delete process.env.MONOCHROME_UNICORN_NO_TELEMETRY;

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
    targets: ['192.168.1.81'],
    fetchSchema: true,
    upload: true,
    clean: true,
    packed: false,
    source: null,
    telemetry: true,
    sendLog: false,
    sendLogFile: null,
    discover: false,
    yes: false,
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
  assert.equal(parseArgs(['1.2.3.4', '--no-telemetry']).telemetry, false);
  process.env.MONOCHROME_UNICORN_NO_TELEMETRY = '1';
  try {
    assert.equal(parseArgs(['1.2.3.4']).telemetry, false, 'the environment turns it off too');
  } finally {
    delete process.env.MONOCHROME_UNICORN_NO_TELEMETRY;
  }
});

await check('the command line takes several printers, ranges, --discover and --yes', () => {
  const o = parseArgs(['10.0.0.5', '10.0.0.6', '192.168.1.0/24', '--yes']);
  assert.deepEqual(o.targets, ['10.0.0.5', '10.0.0.6', '192.168.1.0/24']);
  assert.equal(o.ip, '10.0.0.5');
  assert.equal(o.yes, true);
  assert.equal(parseArgs(['--discover']).discover, true, 'needs no printer');
  assert.throws(() => parseArgs(['10.0.0.5', '10.0.0.6', '--no-schema']), /takes one printer/);
  assert.throws(() => parseArgs(['10.0.0.1-5', '--no-schema']), /takes one printer/);
});

/** runCli with its output kept rather than printed. */
async function quietCli(argv, context) {
  const out = [];
  const saved = { log: console.log, error: console.error, write: process.stdout.write };
  console.log = console.error = (...a) => out.push(a.join(' ') + '\n');
  process.stdout.write = (text) => out.push(String(text)) && true;
  try {
    const code = await runCli(argv, context);
    return { code, out: out.join('') };
  } finally {
    Object.assign(console, { log: saved.log, error: saved.error });
    process.stdout.write = saved.write;
  }
}

await check(
  'several printers are installed on in turn, and any failure fails the run',
  async () => {
    const asked = [];
    const { code, out } = await quietCli(['10.0.0.5', '10.0.0.6', '10.0.0.5', '--no-telemetry'], {
      deploy: async (opts) => {
        asked.push(opts.ip);
        if (opts.ip === '10.0.0.6') throw new Error('connect ECONNREFUSED 10.0.0.6:9100');
        return { url: `http://${opts.ip}/` };
      },
    });
    assert.deepEqual(asked, ['10.0.0.5', '10.0.0.6'], 'each once, in order');
    assert.equal(code, 1);
    assert.match(out, /== 10\.0\.0\.5 \(1 of 2\) ==/);
    assert.match(out, /Open http:\/\/10\.0\.0\.5\//);
    assert.match(out, /Installed on 1 of 2 printers\.\nFailed: 10\.0\.0\.6/);

    const one = await quietCli(['10.0.0.5'], { deploy: async () => ({ url: 'http://10.0.0.5/' }) });
    assert.equal(one.code, 0);
    assert.doesNotMatch(one.out, /==|Installed on/, 'one printer reads as it always has');
  },
);

await check('a range that does not parse is a usage error, before anything is sent', async () => {
  const { code, out } = await quietCli(['10.0.0.300-310'], {
    deploy: async () => assert.fail('nothing is installed'),
  });
  assert.equal(code, 2);
  assert.match(out, /"300-310" in the fourth number/);
});

await check('telemetry reports what the served page says, and only that', () => {
  const page =
    '<script type="text/plain" id="boot-vars">\n\n' +
    '@device.product_name=ZD620&amp;R@\n' +
    '@device.friendly_name=Bench@\n' +
    '@device.unique_id=D2J123456789@\r\n' +
    '@appl.name=V84.20.23Z@\n' +
    '@ip.addr=192.168.1.81@\n</script>';
  assert.deepEqual(telemetryFromPage(page, '1.2.3'), {
    model: 'ZD620&R',
    serial: 'D2J123456789',
    firmware: 'V84.20.23Z',
    version: '1.2.3',
  });
  assert.deepEqual(telemetryFromPage('<p>no boot vars</p>', '1.2.3'), {
    model: '',
    serial: '',
    firmware: '',
    version: '1.2.3',
  });
});

await check('telemetry is POSTed as JSON, and a failure is a reason, not a throw', async () => {
  const http = await import('node:http');
  let got = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got = { method: req.method, type: req.headers['content-type'], body: JSON.parse(body) };
      res.writeHead(req.url === '/down' ? 503 : 204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = { model: 'ZD500R', serial: 'X', firmware: 'V74', version: '1.2.3' };
    assert.equal(await sendTelemetry(report, { url: `${base}/telemetry` }), 'sent');
    assert.deepEqual(got, { method: 'POST', type: 'application/json', body: report });
    assert.equal(await sendTelemetry(report, { url: `${base}/down` }), 'the server answered 503');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  // A port nothing listens on: one just given up by a fresh server.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const url = `http://127.0.0.1:${port}/telemetry`;
  assert.equal(await sendTelemetry({}, { url }), 'ECONNREFUSED');
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
async function fakeGui(deploy, more = {}) {
  const gui = await startGui({
    staged: STAGED,
    page: '<p>{{VERSION}} {{TOKEN}}</p><script>const S = {{STEPS}};</script>',
    version: '9.8.7',
    deploy,
    ...more,
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
    assert.equal(opts.telemetry, true, 'on unless the page says otherwise');
  } finally {
    gui.close();
  }
});

await check("the installer page's telemetry box reaches the deploy", async () => {
  let opts;
  const gui = await fakeGui(async (o) => {
    opts = o;
    return { url: `http://${o.ip}/`, version: '9.8.7', served: '9.8.7' };
  });
  try {
    await (await gui.post('/deploy', { ip: '10.0.0.9', telemetry: false })).text();
    assert.equal(opts.telemetry, false);
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

await check("a failed deploy's log can be saved and sent, with the token", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-gui-'));
  const sent = [];
  const gui = await fakeGui(
    async () => {
      throw Object.assign(new Error('Nothing in the allcv reply looked like a setting'), {
        diagnosticLog: 'the diagnostic log\n',
        deployId: '0123456789abcdef',
      });
    },
    {
      logDir: dir,
      sendLog: async (text, fields) => {
        sent.push({ text, ...fields });
        return { reference: fields.deployId };
      },
    },
  );
  try {
    assert.equal((await gui.post('/log')).status, 404, 'no log before a failure');
    const events = (await (await gui.post('/deploy', { ip: '10.0.0.9' })).text())
      .trim()
      .split('\n')
      .map(JSON.parse);
    const { log } = events.at(-1);
    assert.equal(log.bytes, 19);
    assert.equal(readFileSync(log.path, 'utf8'), 'the diagnostic log\n');

    const noToken = await fetch(gui.base + '/log', { method: 'POST' });
    assert.equal(noToken.status, 404);
    const saved = await gui.post('/log');
    assert.equal(saved.status, 200);
    assert.equal(await saved.text(), 'the diagnostic log\n');

    const res = await gui.post('/log/send');
    assert.deepEqual(await res.json(), { reference: '0123456789abcdef' });
    assert.deepEqual(sent, [
      { text: 'the diagnostic log\n', deployId: '0123456789abcdef', version: '9.8.7' },
    ]);
  } finally {
    gui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("each failed install's log is kept, and asked for by its deploy id", async () => {
  let n = 0;
  const sent = [];
  const gui = await fakeGui(
    async () => {
      n++;
      throw Object.assign(new Error('Nothing in the allcv reply looked like a setting'), {
        diagnosticLog: `log ${n}\n`,
        deployId: `${n}`.repeat(16),
      });
    },
    {
      sendLog: async (text, fields) => {
        sent.push(text);
        return { reference: fields.deployId };
      },
    },
  );
  try {
    const fail = async (ip) =>
      (await (await gui.post('/deploy', { ip })).text()).trim().split('\n').map(JSON.parse).at(-1);
    assert.equal((await fail('10.0.0.1')).log.deployId, '1'.repeat(16));
    assert.equal((await fail('10.0.0.2')).log.deployId, '2'.repeat(16));
    assert.equal(await (await gui.post('/log', { deployId: '1'.repeat(16) })).text(), 'log 1\n');
    assert.equal(await (await gui.post('/log')).text(), 'log 2\n', 'the latest, by default');
    assert.equal((await gui.post('/log', { deployId: 'f'.repeat(16) })).status, 404);
    const res = await gui.post('/log/send', { deployId: '1'.repeat(16) });
    assert.deepEqual(await res.json(), { reference: '1'.repeat(16) });
    assert.deepEqual(sent, ['log 1\n']);
  } finally {
    gui.close();
  }
});

await check('the page asks the installer to search the network, and to scan a range', async () => {
  let scanned = null;
  const gui = await fakeGui(undefined, {
    discover: async () => [{ ip: '10.0.0.7', model: 'ZD620', via: 'discovery' }],
    scan: async (addresses, { onProgress, onPrinter }) => {
      scanned = addresses;
      onProgress({ phase: 'discovery', done: addresses.length, total: addresses.length });
      const printer = { ip: addresses[1], model: 'ZD500R', via: 'discovery' };
      onPrinter(printer);
      return [printer];
    },
  });
  try {
    assert.deepEqual(await (await gui.post('/discover')).json(), {
      printers: [{ ip: '10.0.0.7', model: 'ZD620', via: 'discovery' }],
    });
    const res = await gui.post('/scan', { range: '10.0.0.1-3' });
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
    const events = (await res.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(scanned, ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    assert.deepEqual(
      events.map((e) => e.type),
      ['progress', 'printer', 'done'],
    );
    assert.equal(events[1].printer.ip, '10.0.0.2');
    assert.equal(events[2].total, 3);

    const bad = await gui.post('/scan', { range: '10.0.0.1-300' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /"1-300" in the fourth number/);
    const noToken = await fetch(gui.base + '/discover', { method: 'POST' });
    assert.equal(noToken.status, 404);
  } finally {
    gui.close();
  }
});

await check('a search that cannot be made says why, rather than failing', async () => {
  const gui = await fakeGui(undefined, {
    discover: async () => {
      throw new Error('bind EACCES');
    },
  });
  try {
    assert.deepEqual(await (await gui.post('/discover')).json(), {
      printers: [],
      error: 'bind EACCES',
    });
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
