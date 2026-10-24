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

/*
 * The standalone installer (tools/installer/), compiled for this
 * computer, both ways a person runs it: with an address on the command
 * line, and double-clicked -- its page, driven in Chrome.
 *
 * Each install is checked on the printer: the page it serves must carry
 * this version and a build stamp newer than before. The release's
 * install.sh is run too, against the files the compile left in dist/bin/
 * served from this computer as a release would serve them. Both installs put
 * back the same working tree the run deployed, so the printer ends as it
 * began.
 */

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, getvar } from './lib/printer.mjs';
import { skip } from './lib/harness.mjs';
import { hostTarget, binaryName, assetName } from '../../tools/installer/package.mjs';
import { readVersion } from '../../tools/version.mjs';

export const name = 'Installer';

/** The version and build stamp in the footer of the page the printer serves. */
async function served(ip) {
  const { status, bytes } = await http(ip, `/INDEX.SHTML?v=${Date.now()}`);
  assert.equal(status, 200, 'the printer serves the page');
  const footer = /Version (\d+\.\d+\.\d+) &middot; Built (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(
    Buffer.from(bytes).toString('latin1'),
  );
  assert.ok(footer, 'a footer with a version and a build stamp');
  return { version: footer[1], stamp: footer[2] };
}

/**
 * Serve dist/bin/ on 127.0.0.1 as a release's download URL would, noting
 * what was asked for; `replace` swaps in other contents for a file name.
 */
async function serveRelease(dir, replace = {}) {
  const asked = [];
  const server = createServer((req, res) => {
    const file = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    asked.push(file);
    const path = join(dir, file);
    if (!(file in replace) && (file.includes('/') || !existsSync(path))) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(file in replace ? replace[file] : readFileSync(path));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    asked,
    close: () => server.listening && server.close(),
  };
}

/** Run the installer to the end, collecting what it prints. */
function runInstaller(bin, args, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, out }));
  });
}

/**
 * Stand in for the telemetry server, so a diagnostic log a test sends
 * goes no further than this computer; `logs` is what it was sent.
 */
async function fakeTelemetry() {
  const logs = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (!req.url.endsWith('/log')) return res.writeHead(204).end();
      const upload = JSON.parse(body);
      logs.push(upload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reference: upload.deploy_id }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return {
    url: `http://127.0.0.1:${server.address().port}/telemetry`,
    logs,
    close: () => server.listening && server.close(),
  };
}

/** Start the installer's page without a browser; resolves to its address. */
function startGui(bin, env = process.env) {
  const child = spawn(bin, ['--gui', '--no-open'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env,
  });
  const exited = new Promise((resolveExit) => child.on('close', resolveExit));
  const url = new Promise((resolveUrl, rejectUrl) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/.exec(out);
      if (m) resolveUrl(m[0]);
    });
    child.on('close', () => rejectUrl(new Error(`the installer exited first:\n${out}`)));
  });
  return { child, url, exited };
}

export default function register(s, ctx) {
  const { cfg, root, browser } = ctx;
  const target = hostTarget();
  const version = readVersion();
  const binDir = join(root, 'dist/bin');
  const bin = target && join(binDir, binaryName(target, version));
  let gui = null;
  let telemetry = null;
  // The installer's data folder, so the logs it writes are the tests' own.
  const dataHome = mkdtempSync(join(tmpdir(), 'mu-installer-data-'));

  s.test(
    'the installer compiles for this computer',
    () => {
      if (!target) skip(`no installer target for ${process.platform}-${process.arch}`);
      execFileSync('node', ['tools/installer/package.mjs', '--only', target.name], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      assert.ok(existsSync(bin), `${bin} was built`);
    },
    { timeout: 600000 },
  );

  s.test("the release's install.sh fetches this version's installer, and checks it", async () => {
    if (!bin || !existsSync(bin)) skip('no installer was built');
    if (process.platform === 'win32') skip('install.sh is for macOS and Linux');
    const script = join(binDir, assetName(version, 'install.sh'));
    const sums = assetName(version, 'SHA256SUMS');
    const home = mkdtempSync(join(tmpdir(), 'zebra-install-'));
    const env = { ...process.env, XDG_DATA_HOME: home };
    let release = await serveRelease(binDir);
    try {
      const ok = await runInstaller('sh', [script, '--version'], {
        ...env,
        MONOCHROME_UNICORN_URL: release.url,
      });
      assert.equal(ok.code, 0, ok.out);
      assert.match(
        ok.out,
        new RegExp(`^${version.replaceAll('.', '\\.')}$`, 'm'),
        'it ran the installer it fetched',
      );
      assert.deepEqual(release.asked, [binaryName(target, version), sums]);
      release.close();

      // A download that does not match the checksums is refused, not run.
      release = await serveRelease(binDir, {
        [sums]: `${'0'.repeat(64)}  ${binaryName(target, version)}\n`,
      });
      const bad = await runInstaller('sh', [script, '--version'], {
        ...env,
        MONOCHROME_UNICORN_URL: release.url,
      });
      assert.notEqual(bad.code, 0);
      assert.match(bad.out, new RegExp(`does not match ${sums}`));
    } finally {
      release.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  s.test(
    'from the command line, it installs this version on the printer',
    async () => {
      if (!bin || !existsSync(bin)) skip('no installer was built');
      const before = await served(cfg.ip);
      const { code, out } = await runInstaller(bin, [cfg.ip]);
      assert.equal(code, 0, `the installer failed:\n${out}`);
      assert.match(out, new RegExp(`Open http://${cfg.ip.replaceAll('.', '\\.')}/`));
      const after = await served(cfg.ip);
      assert.equal(after.version, version);
      assert.ok(after.stamp > before.stamp, `a new build: ${before.stamp} -> ${after.stamp}`);
    },
    { timeout: 300000 },
  );

  s.test(
    'from the command line, --discover lists the printer',
    async () => {
      if (!bin || !existsSync(bin)) skip('no installer was built');
      const model = (await getvar(cfg.ip, 'device.product_name')).trim();
      const { code, out } = await runInstaller(bin, ['--discover']);
      assert.equal(code, 0, out);
      const line = out.split('\n').find((l) => l.trim().startsWith(`${cfg.ip} `));
      assert.ok(line, `the printer is listed:\n${out}`);
      assert.ok(line.includes(model), `as a ${model}: ${line}`);
    },
    { timeout: 60000 },
  );

  s.test(
    'from the command line, a range is scanned, and nothing installed without a yes',
    async () => {
      if (!bin || !existsSync(bin)) skip('no installer was built');
      const before = await served(cfg.ip);
      const last = Number(cfg.ip.split('.')[3]);
      const range = `${cfg.ip.split('.').slice(0, 3).join('.')}.${Math.max(1, last - 2)}-${Math.min(254, last + 2)}`;
      const { code, out } = await runInstaller(bin, [range]);
      assert.equal(code, 2, out);
      assert.ok(
        out.split('\n').some((l) => l.trim().startsWith(`${cfg.ip} `)),
        `the printer was found:\n${out}`,
      );
      assert.match(out, /without being asked, add --yes/);
      assert.equal((await served(cfg.ip)).stamp, before.stamp, 'nothing was installed');
    },
    { timeout: 60000 },
  );

  s.test(
    'a failed install from the command line writes its diagnostic log, and sends it if told',
    async () => {
      if (!bin || !existsSync(bin)) skip('no installer was built');
      telemetry ??= await fakeTelemetry();
      const env = {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        LOCALAPPDATA: dataHome,
        MONOCHROME_UNICORN_TELEMETRY_URL: telemetry.url,
      };
      // Nothing on this computer listens on 9100.
      const quiet = await runInstaller(bin, ['127.0.0.1'], env);
      assert.equal(quiet.code, 1, quiet.out);
      const path = /Diagnostic log: (.+\.log)/.exec(quiet.out)?.[1];
      assert.ok(path, `it says where the log is:\n${quiet.out}`);
      assert.ok(path.startsWith(join(dataHome, 'monochrome-unicorn', 'logs')), path);
      const log = readFileSync(path, 'utf8');
      assert.match(log, new RegExp(`^version: ${version.replaceAll('.', '\\.')}$`, 'm'));
      assert.match(log, /^failed at step: schema$/m);
      assert.match(log, /ended: error: ECONNREFUSED/);
      assert.match(log, /^error:\nError: Could not reach 127\.0\.0\.1:9100/m);
      // No terminal to ask in, so it says how to send it.
      assert.match(quiet.out, /--send-log-file/);
      assert.equal(telemetry.logs.length, 0, 'nothing is sent unasked');

      const told = await runInstaller(bin, ['127.0.0.1', '--send-log'], env);
      assert.equal(told.code, 1, told.out);
      assert.equal(telemetry.logs.length, 1, told.out);
      const [sent] = telemetry.logs;
      assert.equal(sent.version, version);
      assert.match(sent.log, /^failed at step: schema$/m);
      assert.match(told.out, new RegExp(`its reference is ${sent.deploy_id}`));

      // And one written earlier, sent afterwards.
      const later = await runInstaller(bin, ['--send-log-file', path], env);
      assert.equal(later.code, 0, later.out);
      assert.equal(telemetry.logs.length, 2);
      assert.equal(telemetry.logs[1].log, log);
    },
    { timeout: 120000 },
  );

  s.test(
    'double-clicked, its page installs on the printer typed in',
    async () => {
      if (!bin || !existsSync(bin)) skip('no installer was built');
      const before = await served(cfg.ip);
      telemetry ??= await fakeTelemetry();
      gui = startGui(bin, {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        LOCALAPPDATA: dataHome,
        MONOCHROME_UNICORN_TELEMETRY_URL: telemetry.url,
      });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(await gui.url);
        await page.locator('#ip').fill(cfg.ip);
        await page.locator('#go').click();
        const target = page.locator(`.target[data-ip="${cfg.ip}"]`);
        await target.locator('.result.ok').waitFor({ timeout: 240000 });
        assert.equal(await target.locator('.open').getAttribute('href'), `http://${cfg.ip}/`);
        assert.match(await target.locator('.ok-note').textContent(), new RegExp(version));
        assert.equal(await target.locator('.steps li.done').count(), 5, 'every step ticked');
        // Printers a search found are listed, not ticked: only this one was installed on.
        assert.equal(await page.locator('.target').count(), 1);
        assert.match(
          await page.locator(`#printers li[data-ip="${cfg.ip}"] .state`).textContent(),
          /installed/,
        );
      } finally {
        await context.close();
      }
      const after = await served(cfg.ip);
      assert.equal(after.version, version);
      assert.ok(after.stamp > before.stamp, `a new build: ${before.stamp} -> ${after.stamp}`);
    },
    { timeout: 300000 },
  );

  s.test('its page says plainly when nothing is a printer at the address', async () => {
    if (!gui) skip('the page did not start');
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(await gui.url);
      // Nothing on this computer listens on 9100.
      await page.locator('#ip').fill('127.0.0.1');
      await page.locator('#go').click();
      await page.locator('.result.bad').waitFor({ timeout: 60000 });
      assert.match(await page.locator('.bad-text').textContent(), /refused port 9100/);
      assert.equal(await page.locator('.steps li.failed').count(), 1);
    } finally {
      await context.close();
    }
  });

  s.test("its page saves a failed install's diagnostic log, and sends it", async () => {
    if (!gui) skip('the page did not start');
    const context = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await context.newPage();
      await page.goto(await gui.url);
      await page.locator('#ip').fill('127.0.0.1');
      await page.locator('#go').click();
      await page.locator('.diag').waitFor({ timeout: 60000 });
      assert.match(await page.locator('.diag-note').textContent(), /Also saved as .*\.log/);

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('.save-log').click(),
      ]);
      const saved = readFileSync(await download.path(), 'utf8');
      assert.match(saved, /^Monochrome Unicorn: diagnostic log of a failed deploy/);
      assert.match(saved, /^failed at step: schema$/m);

      const before = telemetry.logs.length;
      await page.locator('.send-log').click();
      await page.locator('.diag-note', { hasText: 'Sent, thank you' }).waitFor({ timeout: 20000 });
      assert.equal(telemetry.logs.length, before + 1);
      const sent = telemetry.logs.at(-1);
      assert.equal(sent.log, saved, 'what was sent is what was saved');
      assert.match(await page.locator('.diag-note').textContent(), new RegExp(sent.deploy_id));
    } finally {
      await context.close();
    }
  });

  s.test('its page lists the printers that answer a search, unticked', async () => {
    if (!gui) skip('the page did not start');
    const model = (await getvar(cfg.ip, 'device.product_name')).trim();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(await gui.url);
      const row = page.locator(`#printers li[data-ip="${cfg.ip}"]`);
      await row.waitFor({ timeout: 15000 });
      assert.match(await row.textContent(), new RegExp(model));
      assert.equal(await row.locator('input[type=checkbox]').isChecked(), false);
      assert.match(await page.locator('#search-note').textContent(), /answered/);
    } finally {
      await context.close();
    }
  });

  s.test('its page scans a range typed in, and ticks the printers it finds', async () => {
    if (!gui) skip('the page did not start');
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(await gui.url);
      // A range of one: the printer's own address, as a range.
      const last = cfg.ip.split('.')[3];
      await page.locator('#ip').fill(`${cfg.ip}-${last}`);
      await page.locator('#add').click();
      await page
        .locator('#add-note', { hasText: /Zebra printers? in 1 addresses/ })
        .waitFor({ timeout: 30000 });
      const row = page.locator(`#printers li[data-ip="${cfg.ip}"]`);
      assert.equal(await row.locator('input[type=checkbox]').isChecked(), true);
      assert.equal(await page.locator('#ip').inputValue(), '', 'the box is cleared');
      assert.equal(await page.locator('.target').count(), 0, 'Add does not install');
    } finally {
      await context.close();
    }
  });

  s.test(
    'its page installs on each printer ticked, one after another',
    async () => {
      if (!gui) skip('the page did not start');
      const before = await served(cfg.ip);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(await gui.url);
        // The printer, and an address with no printer: one works, one fails.
        for (const ip of [cfg.ip, '127.0.0.1']) {
          await page.locator('#ip').fill(ip);
          await page.locator('#add').click();
        }
        assert.equal(await page.locator('#go').textContent(), 'Install on 2 printers');
        await page.locator('#go').click();
        // In order of address, so the one with no printer goes first.
        await page
          .locator(`#printers li[data-ip="${cfg.ip}"] .state`, { hasText: 'installed' })
          .waitFor({ timeout: 240000 });
        const ips = await page
          .locator('.target')
          .evaluateAll((els) => els.map((e) => e.dataset.ip));
        assert.deepEqual(ips, ['127.0.0.1', cfg.ip]);
        const ok = page.locator(`.target[data-ip="${cfg.ip}"]`);
        assert.equal(await ok.locator('.result.ok').isVisible(), true);
        const bad = page.locator('.target[data-ip="127.0.0.1"]');
        assert.match(await bad.locator('.bad-text').textContent(), /refused port 9100/);
        assert.match(
          await page.locator('#printers li[data-ip="127.0.0.1"] .state').textContent(),
          /failed/,
        );
      } finally {
        await context.close();
      }
      const after = await served(cfg.ip);
      assert.ok(after.stamp > before.stamp, `a new build: ${before.stamp} -> ${after.stamp}`);
    },
    { timeout: 300000 },
  );

  s.test('its page refuses requests without the installer token', async () => {
    if (!gui) skip('the page did not start');
    const base = new URL(await gui.url);
    const res = await fetch(new URL('/deploy', base), {
      method: 'POST',
      body: JSON.stringify({ ip: cfg.ip }),
    });
    assert.equal(res.status, 404);
    const page = await fetch(new URL('/', base));
    assert.equal(page.status, 403);
  });

  s.test('Quit on its page stops the installer', async () => {
    if (!gui) skip('the page did not start');
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(await gui.url);
      await page.locator('#quit').click();
      await page.locator('#gone').waitFor();
    } finally {
      await context.close();
    }
    const code = await Promise.race([
      gui.exited,
      new Promise((r) => setTimeout(() => r('still running'), 10000)),
    ]);
    assert.equal(code, 0);
    gui = null;
  });

  s.cleanup(() => {
    if (gui) gui.child.kill();
    telemetry?.close();
    rmSync(dataHome, { recursive: true, force: true });
  }, 'stop the installer');
}
