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
 * this version and a build stamp newer than before. Both installs put
 * back the same working tree the run deployed, so the printer ends as it
 * began.
 */

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { http } from './lib/printer.mjs';
import { skip } from './lib/harness.mjs';
import { hostTarget } from '../../tools/installer/package.mjs';
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

/** Run the installer to the end, collecting what it prints. */
function runInstaller(bin, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, out }));
  });
}

/** Start the installer's page without a browser; resolves to its address. */
function startGui(bin) {
  const child = spawn(bin, ['--gui', '--no-open'], { stdio: ['ignore', 'pipe', 'inherit'] });
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
  const bin = target && join(root, 'dist/bin', target.file);
  const version = readVersion();
  let gui = null;

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
    'double-clicked, its page installs on the printer typed in',
    async () => {
      if (!bin || !existsSync(bin)) skip('no installer was built');
      const before = await served(cfg.ip);
      gui = startGui(bin);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(await gui.url);
        await page.locator('#ip').fill(cfg.ip);
        await page.locator('#go').click();
        await page.locator('#ok').waitFor({ timeout: 240000 });
        assert.equal(await page.locator('#open').getAttribute('href'), `http://${cfg.ip}/`);
        assert.match(await page.locator('#ok-note').textContent(), new RegExp(version));
        assert.equal(await page.locator('#steps li.done').count(), 5, 'every step ticked');
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
      await page.locator('#bad').waitFor({ timeout: 60000 });
      assert.match(await page.locator('#bad-text').textContent(), /refused port 9100/);
      assert.equal(await page.locator('#steps li.failed').count(), 1);
    } finally {
      await context.close();
    }
  });

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
  }, 'stop the installer');
}
