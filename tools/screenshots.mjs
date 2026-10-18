#!/usr/bin/env node
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
 * The README's screenshots, taken from the console deployed on a real
 * printer, through the live tests' browser and config.
 *
 *   node tools/screenshots.mjs [--ip <printer-ip>] [--only editor,lcd] [--headed]
 *                              [--syslog-ip <printer-ip>]
 *
 * Writes docs/screenshots/*.png. A demo format is stored as
 * E:DEMOSHIP.ZPL for the Stored Formats shot and removed again, and
 * lcd_display_helper.sh runs for the LCD shot. The printer's serial
 * number and MAC addresses are blanked before each capture, and the
 * toasts hidden. Nothing is printed or saved. --syslog-ip takes the
 * Syslog & alerts shot from another printer, one whose log has lines.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, openConsole } from '../test/live/lib/browser.mjs';
import { loadConfig } from '../test/live/lib/config.mjs';
import { sendZpl, removeFile, hasObject, waitFor } from '../test/live/lib/printer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/screenshots');
const VIEWPORT = { width: 1440, height: 900 };
const FORMAT = 'DEMOSHIP';

const DEMO_LABEL = [
  '^XA',
  '^PW1200',
  '^LL900',
  '^FO30,30^GB1140,840,6^FS',
  '^FO70,70^A0N,80,80^FDMonochrome Unicorn^FS',
  '^FO70,170^A0N,40,40^FDShip to: Acme Widgets, Unit 4^FS',
  '^FO70,220^A0N,40,40^FD221B Baker Street, London NW1^FS',
  '^FO70,310^BY4^BCN,170,Y,N,N^FD0123456789^FS',
  '^FO890,290^BQN,2,9^FDQA,MONOCHROME-UNICORN^FS',
  '^FO70,580^GB1060,0,4^FS',
  '^FO70,620^A0N,36,36^FDLOT^FS',
  '^FO70,665^A0N,70,70^FD2026-10-A^FS',
  '^FO640,610^GE480,220,4^FS',
  '^FO720,690^A0N,60,60^FDFRAGILE^FS',
  '^XZ',
].join('\n');

const DEMO_FORMAT = [
  '^XA',
  `^DFE:${FORMAT}.ZPL^FS`,
  '^PW812',
  '^LL406',
  '^FO20,20^GB772,366,4^FS',
  '^FO50,50^A0N,50,50^FN1"NAME"^FS',
  '^FO50,115^A0N,36,36^FN2"STREET"^FS',
  '^FO50,160^A0N,36,36^FN3"CITY"^FS',
  '^FO50,230^BY3^BCN,100,Y,N,N^FN4"TRACKING"^FS',
  '^XZ',
].join('\r\n');

/** Blank what identifies the printer itself, in text and in inputs. */
async function redact(page) {
  await page.evaluate(() => {
    const toasts = document.getElementById('toasts');
    if (toasts) toasts.style.visibility = 'hidden';
    const MAC = /\b[0-9A-F]{2}(:[0-9A-F]{2}){5}\b|\b[0-9A-F]{12}\b/gi;
    const SN = /(S\/N )\w+/g;
    const scrub = (s) => s.replace(SN, '$1XXXXXXXXXXXX').replace(MAC, 'XX:XX:XX:XX:XX:XX');
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const v = scrub(n.nodeValue);
      if (v !== n.nodeValue) n.nodeValue = v;
    }
    for (const i of document.querySelectorAll('input')) {
      const v = scrub(i.value);
      if (v !== i.value) i.value = v;
    }
  });
}

async function shot(page, name, { locator, clip } = {}) {
  await redact(page);
  const path = join(OUT, `${name}.png`);
  if (locator) await locator.screenshot({ path });
  else await page.screenshot({ path, clip });
  console.log(`  ${name}.png`);
}

/** The settings sweep is done when Refresh values can be pressed again. */
async function settingsLoaded(page) {
  await page.locator('#maintenance').waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: 'Refresh values' }).and(page.locator(':enabled')).waitFor({
    timeout: 90000,
  });
}

const SCENES = {
  async settings(browser, cfg) {
    const con = await openConsole(browser, cfg, 'settings', { viewport: VIEWPORT });
    const { page } = con;
    await settingsLoaded(page);
    const filter = page.getByPlaceholder('Filter by name or value…');

    await filter.fill('media.');
    await page.waitForTimeout(600);
    await page.locator('[data-name="media.speed"] code').first().click();
    await page
      .locator('[data-explain="media.speed"]')
      .getByText(/Print speed/)
      .waitFor({ timeout: 30000 });
    await shot(page, 'settings');
    await page.locator('[data-name="media.speed"] code').first().click();

    await filter.fill('');
    await page.getByLabel('changed from default').check();
    await page.waitForTimeout(600);
    await shot(page, 'settings-changed');
    await page.getByLabel('changed from default').uncheck();

    await page.locator('#maintenance').scrollIntoViewIfNeeded();
    await page.locator('#media-sensor [data-gauge]').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(1000);
    await shot(page, 'maintenance', { locator: page.locator('#maintenance') });
    await shot(page, 'media-sensor', { locator: page.locator('#media-sensor') });

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#printer-menu summary').click();
    await page.waitForTimeout(300);
    await shot(page, 'printer-menu', { clip: { x: 0, y: 0, width: VIEWPORT.width, height: 420 } });
    await con.close();
  },

  async syslog(browser, cfg) {
    const con = await openConsole(browser, { ...cfg, ip: cfg.syslogIp || cfg.ip }, 'settings', {
      viewport: VIEWPORT,
    });
    const { page } = con;
    await page.getByRole('tab', { name: 'Syslog & alerts' }).click();
    await page.locator('#logs-tool').waitFor();
    await page.waitForTimeout(10000);
    await shot(page, 'syslog');
    await con.close();
  },

  async editor(browser, cfg) {
    const con = await openConsole(browser, cfg, 'editor', { viewport: VIEWPORT });
    const { page } = con;
    const panel = page.locator('[data-panel="editor"]');
    const viewButton = (label) => panel.locator('#view-toggle button', { hasText: label });

    await viewButton('Source').click();
    await page.waitForFunction(
      () => {
        const ace = document.querySelector('[data-panel="editor"] .ace_editor');
        return ace && ace.env && ace.env.editor;
      },
      null,
      { timeout: 30000 },
    );
    await page.evaluate((value) => {
      document.querySelector('[data-panel="editor"] .ace_editor').env.editor.setValue(value, -1);
    }, DEMO_LABEL);

    await viewButton('Visual').click();
    await panel
      .locator('#view-toggle button[aria-selected="true"]', { hasText: 'Visual' })
      .waitFor();
    await panel.locator('[data-id]').nth(4).click();
    await page.waitForTimeout(4000);
    await shot(page, 'editor');

    // The cursor on the barcode's ^BY, for the command panel beside it.
    await viewButton('Source').click();
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const ed = document.querySelector('[data-panel="editor"] .ace_editor').env.editor;
      ed.find('^BY');
      ed.clearSelection();
      ed.navigateLeft(1);
      ed.focus();
    });
    await page.waitForTimeout(3000);
    await shot(page, 'editor-source');
    await con.close();
  },

  async format(browser, cfg) {
    if (await hasObject(cfg.ip, 'E', FORMAT)) throw new Error(`E:${FORMAT}.ZPL already exists`);
    await sendZpl(cfg.ip, DEMO_FORMAT);
    await waitFor(() => hasObject(cfg.ip, 'E', FORMAT), { what: 'the demo format' });
    try {
      const con = await openConsole(browser, cfg, 'format', { viewport: VIEWPORT });
      const { page } = con;
      const panel = page.locator('[data-panel="format"]');
      const select = panel.locator('select').first();
      await waitFor(
        async () => (await select.locator(`option[value="E:${FORMAT}.ZPL"]`).count()) > 0,
        { timeout: 60000, what: 'the format in the list' },
      );
      await select.selectOption(`E:${FORMAT}.ZPL`);
      const inputs = panel.locator('label input[type="text"]');
      await inputs.first().waitFor();
      const values = [
        'Ada Lovelace',
        '12 St James’s Square',
        'London SW1Y 4JH',
        '1Z999AA10123456784',
      ];
      for (let i = 0; i < values.length; i++) {
        await inputs.nth(i).fill(values[i]);
        await inputs.nth(i).dispatchEvent('change');
      }
      await page.waitForTimeout(5000);
      await shot(page, 'formats');
      await con.close();
    } finally {
      await removeFile(cfg.ip, `E:${FORMAT}.ZPL`);
    }
  },

  async files(browser, cfg) {
    const con = await openConsole(browser, cfg, 'files', { viewport: VIEWPORT });
    const { page } = con;
    const panel = page.locator('[data-panel="files"]');
    await panel.getByRole('button', { name: 'View' }).first().waitFor({ timeout: 90000 });
    await page.waitForTimeout(1000);
    await shot(page, 'files');
    await panel.locator('.toolbar').getByRole('button', { name: 'Pictures' }).click();
    await page.waitForTimeout(10000);
    // Another organisation's logo has no place in the README.
    await page.evaluate(() => {
      for (const n of document.querySelectorAll('[data-panel="files"] *')) {
        if (n.children.length || !/IBEW/.test(n.textContent)) continue;
        let tile = n;
        while (tile.parentElement && tile.parentElement.children.length < 3)
          tile = tile.parentElement;
        tile.remove();
      }
    });
    await shot(page, 'pictures');
    await con.close();
  },

  async lcd(browser, cfg) {
    // First without the helper: the screen as display.text has it.
    if (!(await hasObject(cfg.ip, 'R', 'LCD'))) {
      const con = await openConsole(browser, cfg, 'lcd', { viewport: VIEWPORT });
      await con.page.waitForTimeout(6000);
      await shot(con.page, 'lcd-text');
      await con.close();
    }

    const dir = mkdtempSync(join(tmpdir(), 'mu-lcd-'));
    const helper = spawn(
      join(ROOT, 'lcd_display_helper.sh'),
      [cfg.ip, '--out', join(dir, 'lcd.bmp')],
      {
        stdio: 'ignore',
      },
    );
    try {
      await waitFor(() => hasObject(cfg.ip, 'R', 'LCD'), { timeout: 30000, what: 'R:LCD.GRF' });
      const con = await openConsole(browser, cfg, 'lcd', { viewport: VIEWPORT });
      await con.page.waitForTimeout(6000);
      await shot(con.page, 'lcd');
      await con.close();
    } finally {
      helper.kill('SIGINT');
      await waitFor(() => helper.exitCode !== null || helper.signalCode !== null, {
        what: 'the helper to exit',
      });
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

async function main() {
  const argv = process.argv.slice(2);
  const own = ['--only', '--syslog-ip'];
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const only = value('--only')?.split(',');
  const cfg = await loadConfig([
    '--yes',
    ...argv.filter((a, i) => !own.includes(a) && !own.includes(argv[i - 1])),
  ]);
  cfg.syslogIp = value('--syslog-ip');
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser(cfg);
  try {
    for (const [name, scene] of Object.entries(SCENES)) {
      if (only && !only.includes(name)) continue;
      console.log(name);
      await scene(browser, cfg);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
