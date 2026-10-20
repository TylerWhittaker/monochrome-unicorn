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

/* The page as a whole: what the printer serves, the header, the tabs. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openConsole } from './lib/browser.mjs';
import { http, getvar, setvar, sendZpl, waitFor } from './lib/printer.mjs';
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
    // Unpacked (the default) it is about 495 KB; packed (deploy.sh
    // --packed) about 170 KB. Well past either is a regression.
    const packed = Buffer.from(page.bytes).toString('latin1').includes('id="packed"');
    const budget = (packed ? 250 : 600) * 1024;
    assert.ok(
      page.bytes.length < budget,
      `INDEX.SHTML (${packed ? 'packed' : 'unpacked'}) is ${page.bytes.length} bytes`,
    );
  });

  s.test('the ZPL command reference is served beside the page, as JSON', async () => {
    const { status, bytes } = await http(cfg.ip, '/ZPLREF.SHTML');
    assert.equal(status, 200);
    const reference = JSON.parse(Buffer.from(bytes).toString('utf8'));
    assert.ok(Object.keys(reference).length > 200, 'every command');
    assert.equal(reference['^FO'].name, 'Field Origin');
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
    // Read again if it comes back empty: just after a deploy port 9100
    // can answer before the printer has its settings to hand.
    let friendly = '';
    await waitFor(async () => (friendly = await getvar(cfg.ip, 'device.friendly_name')) !== '', {
      what: 'device.friendly_name over port 9100',
    });
    await page.locator('#hdr-name', { hasText: friendly }).waitFor();
    assert.equal((await page.locator('#hdr-ip').textContent()).trim(), cfg.ip);
    const meta = await page.locator('#hdr-meta').textContent();
    assert.match(meta, new RegExp(`${cfg.dpi} dpi`));
    assert.match(meta, new RegExp(ctx.firmware.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const status = (await page.locator('#hdr-status').textContent()).trim();
    assert.ok(['ready', 'paper out', 'paused', 'unknown'].includes(status), `status "${status}"`);
    assert.equal(await page.title(), `${friendly} — Monochrome Unicorn`);
  });

  s.test('the packed page unpacks: styles, catalogue, htmx and app all in place', async () => {
    const served = await http(cfg.ip, '/INDEX.SHTML');
    if (!Buffer.from(served.bytes).toString('latin1').includes('id="packed"')) {
      skip('the printer has the unpacked page, the default (deploy.sh --packed packs it)');
    }
    const state = await con.page.evaluate(() => ({
      unpacking: document.documentElement.classList.contains('unpacking'),
      packed: Boolean(document.getElementById('packed')),
      schema: Boolean(document.getElementById('sgd-schema')),
      htmx: typeof window.htmx,
      header: getComputedStyle(document.querySelector('header')).backgroundColor,
      fatal: Boolean(document.getElementById('fatal')),
    }));
    assert.deepEqual(
      { ...state, header: state.header !== 'rgba(0, 0, 0, 0)' },
      { unpacking: false, packed: false, schema: true, htmx: 'object', header: true, fatal: false },
    );
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

  s.test('the footer offers the source, as the AGPL asks of a network program', async () => {
    const link = con.page.locator('footer #source-link');
    assert.equal(
      await link.getAttribute('href'),
      'https://github.com/TylerWhittaker/monochrome-unicorn',
    );
    const repo = await fetch(await link.getAttribute('href'), { method: 'HEAD' });
    assert.equal(repo.status, 200, 'the source it points at is there');
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

  /** The pause flag in device.host_status, read straight from the printer. */
  const paused = async () => (await getvar(cfg.ip, 'device.host_status')).split(',')[2] === '1';
  const menuItem = (name) => con.page.locator('#printer-menu').getByRole('menuitem', { name });
  const openMenu = () => con.page.locator('#printer-menu summary').click();

  s.cleanup(() => sendZpl(cfg.ip, '~PS'), 'make sure the printer is not left paused');

  s.test('the status the header polls is served as a helper file', async () => {
    const { status, bytes } = await http(cfg.ip, '/STATUS.SHTML');
    assert.equal(status, 200);
    assert.match(Buffer.from(bytes).toString('utf8'), /@device\.host_status=\d+,/);
  });

  s.test('the Printer menu offers what is done at the printer', async () => {
    await openMenu();
    const items = await con.page.locator('#printer-menu [role="menuitem"]').allTextContents();
    assert.deepEqual(items, [
      'Feed a label',
      'Pause',
      'Cancel all jobs',
      'Calibrate media',
      'Set clock…',
      'Print configuration label',
    ]);
    await openMenu();
  });

  s.test('Pause and Resume from the menu, shown on the printer and in the header', async () => {
    await openMenu();
    await menuItem('Pause').click();
    await waitFor(paused, { what: 'the printer to pause' });
    await con.page.locator('#hdr-status', { hasText: 'paused' }).waitFor();
    await openMenu();
    await menuItem('Resume').click();
    await waitFor(async () => !(await paused()), { what: 'the printer to resume' });
    await con.page.locator('#hdr-status', { hasText: 'ready' }).waitFor();
  });

  s.test('a change at the printer reaches the header without a reload', async () => {
    await sendZpl(cfg.ip, '~PP');
    await con.page.locator('#hdr-status', { hasText: 'paused' }).waitFor({ timeout: 40000 });
    await sendZpl(cfg.ip, '~PS');
    await con.page.locator('#hdr-status', { hasText: 'ready' }).waitFor({ timeout: 40000 });
  });

  s.cleanup(
    () => setvar(cfg.ip, 'rtc.unix_timestamp', String(Math.round(Date.now() / 1000))),
    'put the printer’s clock right',
  );

  s.test('Set clock shows how far out the printer is, and sets it', async () => {
    if ((await getvar(cfg.ip, 'rtc.exists')) !== 'yes') skip('this printer has no clock');
    // An hour slow, so there is something to see and to put right.
    await setvar(cfg.ip, 'rtc.unix_timestamp', String(Math.round(Date.now() / 1000) - 3600));
    await openMenu();
    await menuItem('Set clock…').click();
    const dialog = con.page.locator('#modal-root .card', { hasText: 'Printer clock' });
    await dialog
      .getByText(/The printer’s clock is 1 h( \d+ s)? slow\./)
      .waitFor({ timeout: 30000 });
    await dialog.getByRole('button', { name: 'Set to this computer’s time' }).click();
    await dialog.getByText('The printer’s clock is right.').waitFor({ timeout: 30000 });
    const drift = Number(await getvar(cfg.ip, 'rtc.unix_timestamp')) - Date.now() / 1000;
    assert.ok(Math.abs(drift) < 10, `printer clock ${drift.toFixed(1)} s out`);
    await dialog.getByRole('button', { name: 'Close' }).click();
  });

  s.test('? shows every shortcut, but not while typing', async () => {
    const { page } = con;
    const sheet = page.locator('#modal-root [data-shortcuts]');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('?');
    await sheet.waitFor();
    assert.match(await sheet.textContent(), /Ctrl\+V.*Paste/);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });

    // A ? typed into the settings filter is just a character.
    const filter = page.locator('[data-panel="settings"] input').first();
    await filter.click();
    await page.keyboard.press('?');
    await page.waitForTimeout(300);
    assert.equal(await sheet.count(), 0);
    assert.equal(await filter.inputValue(), '?');
    await filter.fill('');

    // And the Label Editor has a button for it.
    await page.locator('.tab-btn[data-tab="editor"]').click();
    await page.locator('[data-panel="editor"]').getByRole('button', { name: 'Shortcuts' }).click();
    await sheet.waitFor();
    await page.locator('#modal-root').getByRole('button', { name: 'Close' }).click();
    await page.locator('.tab-btn[data-tab="settings"]').click();
  });

  s.test('Cancel all asks first', async () => {
    await openMenu();
    await menuItem('Cancel all jobs').click();
    const dialog = con.page.locator('#modal-root .card', { hasText: 'Cancel all jobs?' });
    await dialog.getByRole('button', { name: 'Cancel all' }).click();
    await con.ui.toast(/Cancelled every job/);
  });

  s.test('Feed, Calibrate and the configuration label move media', async () => {
    if (!cfg.print) skip('printing not enabled');
    for (const [name, button, done] of [
      ['Feed a label', null, /Fed a label/],
      ['Calibrate media', 'Calibrate', /Calibrating/],
      ['Print configuration label', 'Print', /configuration label/],
    ]) {
      await openMenu();
      await menuItem(name).click();
      if (button) {
        await con.page.locator('#modal-root .card').getByRole('button', { name: button }).click();
      }
      await con.ui.toast(done);
      await con.page.waitForTimeout(4000);
    }
    con.ui.assertNoErrors();
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
