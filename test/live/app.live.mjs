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

/* The page as a whole: what the printer serves, the header, the tabs. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openConsole } from './lib/browser.mjs';
import { http, getvar } from './lib/printer.mjs';
import { skip } from './lib/harness.mjs';

export const name = 'App shell';

export default function register(s, ctx) {
  const { cfg } = ctx;
  let con;

  s.cleanup(() => con && con.close());

  s.test('the printer serves the console at / and /INDEX.SHTML', async () => {
    const page = await http(cfg.ip, '/INDEX.SHTML');
    const root = await http(cfg.ip, '/');
    assert.equal(page.status, 200);
    assert.equal(root.status, 200);
    assert.equal(root.bytes.length, page.bytes.length, 'both serve the same page');
    const html = Buffer.from(page.bytes).toString('utf8');
    assert.match(html, /GNU Affero General Public License/, 'the licence travels with the page');
  });

  s.test('the page stays near its size budget', async () => {
    const page = await http(cfg.ip, '/INDEX.SHTML');
    // ~56 KB/s: README keeps the total near 200 KB; well past 400 KB is a regression.
    assert.ok(page.bytes.length < 450 * 1024, `INDEX.SHTML is ${page.bytes.length} bytes`);
  });

  s.test('the settings helper file streams @name=value@ records', async () => {
    const { status, bytes } = await http(cfg.ip, '/V_ALL.SHTML', { timeout: 120000 });
    assert.equal(status, 200);
    const text = Buffer.from(bytes).toString('utf8');
    const records = text.match(/@[a-z0-9_.]+=/gi) || [];
    assert.ok(records.length > 100, `only ${records.length} settings in V_ALL.SHTML`);
    assert.doesNotMatch(text, /<!--#exec/, 'the preprocessor ran');
  });

  s.test('opens on Printer Settings with the header filled in', async () => {
    con = await openConsole(ctx.browser, cfg, 'settings');
    const { page } = con;
    const friendly = await getvar(cfg.ip, 'device.friendly_name');
    await page.locator('#hdr-name', { hasText: friendly }).waitFor();
    assert.equal((await page.locator('#hdr-ip').textContent()).trim(), cfg.ip);
    const meta = await page.locator('#hdr-meta').textContent();
    assert.match(meta, new RegExp(`${cfg.dpi} dpi`));
    assert.match(meta, new RegExp(ctx.firmware.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const status = (await page.locator('#hdr-status').textContent()).trim();
    assert.ok(['ready', 'paper out', 'paused', 'unknown'].includes(status), `status "${status}"`);
    assert.equal(await page.title(), `${friendly} — Printer Console`);
  });

  s.test('the footer carries this build’s version', async () => {
    const version = JSON.parse(readFileSync(`${ctx.root}/package.json`, 'utf8')).version;
    const footer = await con.page.locator('footer').textContent();
    const shown = /Version\s+(\S+)/.exec(footer);
    assert.ok(shown, 'a version in the footer');
    if (!cfg.deploy && shown[1] !== version) {
      skip(`printer runs ${shown[1]}, this tree is ${version} (not deployed)`);
    }
    assert.equal(shown[1], version);
  });

  s.test('every tab mounts without a script error, and the hash follows', async () => {
    const { page, ui } = con;
    const tabs = await page.locator('.tab-btn').evaluateAll((n) => n.map((b) => b.dataset.tab));
    for (const tab of tabs) {
      await ui.showTab(tab);
      assert.equal(new URL(page.url()).hash, `#${tab}`);
      assert.equal(await ui.panel(tab).isVisible(), true, `${tab} panel visible`);
      // A mode that failed to mount says so in its panel.
      assert.equal(
        await ui.panel(tab).getByText('This mode failed to start.').count(),
        0,
        `${tab} mounted`,
      );
    }
    await page.waitForTimeout(1500);
    ui.assertNoErrors();
    // Back to Settings, so nothing polls the printer from here on.
    await ui.showTab('settings');
  });

  s.test('the LCD Viewer tab is there exactly when the printer has a display', async () => {
    const hasDisplay = (await getvar(cfg.ip, 'display.text')) !== '?';
    const tab = await con.page.locator('.tab-btn[data-tab="lcd"]').count();
    assert.equal(tab, hasDisplay ? 1 : 0);
    const helper = await http(cfg.ip, '/LCD.SHTML');
    assert.equal(helper.status === 200, hasDisplay, 'LCD.SHTML uploaded only with a display');
  });

  s.test(
    'a hash in the address opens that mode, and an unknown one lands on Settings',
    async () => {
      const { page } = con;
      await page.goto(`http://${cfg.ip}/INDEX.SHTML?t=${Date.now()}#files`);
      await page.locator('.tab-btn[data-tab="files"][aria-selected="true"]').waitFor();
      await page.goto(`http://${cfg.ip}/INDEX.SHTML?t=${Date.now()}#nonsense`);
      await page.locator('.tab-btn[data-tab="settings"][aria-selected="true"]').waitFor();
      con.ui.assertNoErrors();
    },
  );
}
