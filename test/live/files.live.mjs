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
 * File System: a file's whole life through the page -- upload, view,
 * download, edit, delete -- plus a picture, a type the browser cannot
 * upload, and a batch file run from the page whose effect is checked on
 * the printer and then undone.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openConsole } from './lib/browser.mjs';
import { makePng } from './lib/fixtures.mjs';
import { getvar, setvar, storeFile, removeFile, hasObject, http, waitFor } from './lib/printer.mjs';
import { skip } from './lib/harness.mjs';

export const name = 'File System';

const TEXT_FILE = 'ZTESTFILE';
const IMAGE_FILE = 'ZTESTPIC';
const BATCH_FILE = 'ZTESTRUN';

const ZPL_TEXT = '^XA\r\n^FO40,40^A0N,40,40^FDZTEST file^FS\r\n^XZ\r\n';

export default function register(s, ctx) {
  const { cfg } = ctx;
  let con;
  let page;
  let ui;
  let panel;
  let userP1 = null;

  const row = (name) => panel.locator('div.flex-wrap.gap-x-3', { hasText: name });
  const rowButton = (name, label) => row(name).getByRole('button', { name: label, exact: true });
  const dialog = (title) => page.locator('#modal-root .card', { hasText: title });

  /** Wait for the listing to finish reading (the spinner goes, Refresh comes back). */
  async function listingRead() {
    const refresh = panel.locator('.toolbar').getByRole('button', { name: 'Refresh' });
    await waitFor(() => refresh.isEnabled(), { timeout: 90000, what: 'the drive listing' });
  }

  async function refreshListing() {
    await listingRead();
    await panel.locator('.toolbar').getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(500);
    await listingRead();
  }

  s.cleanup(async () => {
    if (userP1 !== null) await setvar(cfg.ip, 'device.user_p1', userP1);
  }, 'put device.user_p1 back');
  s.cleanup(async () => {
    await removeFile(cfg.ip, `E:${TEXT_FILE}.ZPL`);
    await removeFile(cfg.ip, `E:${IMAGE_FILE}.GRF`);
    await removeFile(cfg.ip, `E:${IMAGE_FILE}2.GRF`);
    await removeFile(cfg.ip, `E:${BATCH_FILE}.BAT`);
  }, 'remove the test files');
  s.cleanup(() => con && con.close());

  s.test('the listing reads every drive, with a count', async () => {
    con = await openConsole(ctx.browser, cfg, 'files');
    ({ page, ui } = con);
    panel = ui.panel('files');
    await listingRead();
    assert.match(await panel.locator('.toolbar').textContent(), /\d+ files?/);
    await panel.locator('.toolbar select').selectOption('*');
    assert.ok((await row('Z:').count()) > 0, 'Z: is listed under All drives');
    await panel.locator('.toolbar select').selectOption('E');
  });

  s.test('the ROM drive is read-only, and each button says why it is off', async () => {
    await panel.locator('.toolbar select').selectOption('Z');
    const first = panel.locator('div.flex-wrap.gap-x-3').first();
    const del = first.getByRole('button', { name: 'Delete' });
    assert.equal(await del.isDisabled(), true);
    assert.equal(await del.getAttribute('title'), 'This drive is read-only.');
    const edit = first.getByRole('button', { name: 'Edit' });
    assert.equal(await edit.isDisabled(), true);
    assert.ok((await edit.getAttribute('title')).length > 10, 'Edit says why');
    await panel.locator('.toolbar select').selectOption('E');
  });

  s.test('Upload stores a .ZPL through the label form', async () => {
    await panel.locator('input[type="file"]').setInputFiles({
      name: 'ztestfile.zpl',
      mimeType: 'text/plain',
      buffer: Buffer.from(ZPL_TEXT),
    });
    const upload = dialog('Upload to the printer');
    assert.equal(await upload.locator('input').inputValue(), `${TEXT_FILE}.ZPL`);
    await upload.getByRole('button', { name: 'Upload' }).click();
    await ui.toast(new RegExp(`Stored E:${TEXT_FILE}\\.ZPL`), { timeout: 60000 });
    assert.ok(await hasObject(cfg.ip, 'E', TEXT_FILE));
    await listingRead();
    await row(`E:${TEXT_FILE}.ZPL`).waitFor({ timeout: 60000 });
  });

  s.test('the filter narrows the list by name', async () => {
    await panel.getByPlaceholder('Filter by name…').fill(TEXT_FILE.toLowerCase());
    await page.waitForTimeout(400);
    assert.equal(await panel.locator('div.flex-wrap.gap-x-3').count(), 1);
    assert.match(await panel.locator('.toolbar').textContent(), /1 of \d+ files/);
    await panel.getByPlaceholder('Filter by name…').fill('');
    await page.waitForTimeout(400);
  });

  s.test('View shows the stored label as ZPL', async () => {
    await rowButton(`E:${TEXT_FILE}.ZPL`, 'View').click();
    const view = dialog(`E:${TEXT_FILE}.ZPL`);
    await view.locator('pre').waitFor();
    assert.match(await view.locator('pre').textContent(), /\^FDZTEST file\^FS/);
    await view.getByRole('button', { name: 'Close' }).click();
  });

  s.test('Download saves it as readable ZPL', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      rowButton(`E:${TEXT_FILE}.ZPL`, 'Download').click(),
    ]);
    assert.equal(download.suggestedFilename(), `${TEXT_FILE}.ZPL`);
    const text = readFileSync(await download.path(), 'utf8');
    assert.match(text, /\^FDZTEST file\^FS/);
    assert.doesNotMatch(text, /[\x1e\x1f]/, 'not the printer’s tokenized form');
  });

  s.test('Edit opens it in the Label Editor, and a save there changes the file', async () => {
    await rowButton(`E:${TEXT_FILE}.ZPL`, 'Edit').click();
    await page.locator('.tab-btn[data-tab="editor"][aria-selected="true"]').waitFor();
    const editor = ui.panel('editor');
    // The label opens on the canvas; the editor's own file list may
    // still be catching up with the new file.
    await editor.locator('.preview-surface', { hasText: 'ZTEST file' }).first().waitFor();
    const node = editor.locator('.preview-surface > div[data-id]').first();
    await node.waitFor();
    await node.dispatchEvent('pointerdown', { clientX: 0, clientY: 0, button: 0 });
    await node.dispatchEvent('pointerup');
    const objectCard = page.locator('.card', {
      has: page.locator('h2', { hasText: 'Object options' }),
    });
    await ui.setField(ui.field(objectCard, 'Content'), 'ZTEST edited');
    await editor
      .locator('.toolbar')
      .nth(1)
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await ui.toast(new RegExp(`Saved E:${TEXT_FILE}\\.ZPL`), { timeout: 60000 });

    const form = Buffer.from(
      (await http(cfg.ip, `/zpl?dev=E&oname=${TEXT_FILE}&otype=ZPL`)).bytes,
    ).toString('latin1');
    assert.match(form, /ZTEST edited/);

    await ui.showTab('files');
    await rowButton(`E:${TEXT_FILE}.ZPL`, 'View').click();
    const view = dialog(`E:${TEXT_FILE}.ZPL`);
    await view.locator('pre').waitFor();
    assert.match(await view.locator('pre').textContent(), /ZTEST edited/);
    await view.getByRole('button', { name: 'Close' }).click();
  });

  s.test('Print asks first for a format with no fields', async () => {
    await rowButton(`E:${TEXT_FILE}.ZPL`, 'Print').click();
    const confirm = dialog('Print this file?');
    await confirm.waitFor();
    assert.match(await confirm.textContent(), /no fields to fill in/);
    if (!cfg.print) {
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      skip('printing not enabled (the confirmation was checked and cancelled)');
    }
    await confirm.getByRole('button', { name: 'Print' }).click();
    await ui.toast(new RegExp(`Told the printer to print E:${TEXT_FILE}\\.ZPL`));
  });

  s.test('Delete removes the file from the printer and the list', async () => {
    await rowButton(`E:${TEXT_FILE}.ZPL`, 'Delete').click();
    await dialog('Delete this file?').getByRole('button', { name: 'Delete' }).click();
    await ui.toast(new RegExp(`Deleted E:${TEXT_FILE}\\.ZPL`), { timeout: 60000 });
    assert.equal(await row(`E:${TEXT_FILE}.ZPL`).count(), 0);
    assert.equal(await hasObject(cfg.ip, 'E', TEXT_FILE), false);
  });

  s.test('a picture is uploaded as a .GRF and viewed as an image', async () => {
    await panel.locator('input[type="file"]').setInputFiles({
      name: 'ztestpic.png',
      mimeType: 'image/png',
      buffer: makePng(120, 60),
    });
    const add = dialog('Add an image');
    await add.locator('input[type="file"]').setInputFiles({
      name: 'ztestpic.png',
      mimeType: 'image/png',
      buffer: makePng(120, 60),
    });
    await add.locator('input[type="text"]').fill(IMAGE_FILE);
    await add.getByRole('button', { name: 'Upload to printer' }).click();
    await add.waitFor({ state: 'detached', timeout: 120000 });
    assert.ok(await hasObject(cfg.ip, 'E', IMAGE_FILE));
    await listingRead();
    await row(`E:${IMAGE_FILE}.GRF`).waitFor({ timeout: 60000 });
    await rowButton(`E:${IMAGE_FILE}.GRF`, 'View').click();
    const view = dialog(`E:${IMAGE_FILE}.GRF`);
    const img = view.locator('img');
    await waitFor(() => img.evaluate((n) => n.complete && n.naturalWidth > 0), {
      what: 'the graphic to load',
    });
    await view.getByRole('button', { name: 'Close' }).click();
  });

  s.test('Pictures shows thumbnails; Rename gives one a new name on the printer', async () => {
    const toggle = panel.locator('.toolbar').getByRole('button', { name: 'Pictures' });
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await row(`E:${TEXT_FILE}.ZPL`).count(), 0, 'only pictures');
    const tile = (name) => panel.locator(`[data-picture="${name}"]`);
    const img = tile(`E:${IMAGE_FILE}.GRF`).locator('img');
    await waitFor(() => img.evaluate((n) => n.complete && n.naturalWidth > 0), {
      what: 'the thumbnail to load',
    });
    assert.match(await tile(`E:${IMAGE_FILE}.GRF`).textContent(), /120 × 60/);

    const rename = async (from, to) => {
      await tile(from).getByRole('button', { name: 'Rename' }).click();
      const ask = dialog(`Rename ${from}`);
      await ask.locator('input').fill(to);
      await ask.getByRole('button', { name: 'Rename' }).click();
      await ui.toast(new RegExp(`Renamed ${from.replace('.', '\\.')} to E:${to}\\.GRF`), {
        timeout: 60000,
      });
    };
    await rename(`E:${IMAGE_FILE}.GRF`, `${IMAGE_FILE}2`);
    assert.equal(await hasObject(cfg.ip, 'E', `${IMAGE_FILE}2`), true, 'the new name');
    assert.equal(await hasObject(cfg.ip, 'E', IMAGE_FILE), false, 'not the old');
    await tile(`E:${IMAGE_FILE}2.GRF`).waitFor();

    // A name already taken is refused before anything is sent.
    await tile(`E:${IMAGE_FILE}2.GRF`).getByRole('button', { name: 'Rename' }).click();
    const ask = dialog(`Rename E:${IMAGE_FILE}2.GRF`);
    await ask.locator('input').fill(`${IMAGE_FILE}2`);
    await ask.getByRole('button', { name: 'Rename' }).click();
    await ask.getByText('That is its name already.').waitFor();
    await ask.getByRole('button', { name: 'Cancel' }).click();

    await rename(`E:${IMAGE_FILE}2.GRF`, IMAGE_FILE);
    assert.equal(await hasObject(cfg.ip, 'E', IMAGE_FILE), true);
    await toggle.click();
    await row(`E:${IMAGE_FILE}.GRF`).waitFor();
  });

  s.test('a type the web server cannot store says how to upload it instead', async () => {
    await panel.locator('input[type="file"]').setInputFiles({
      name: 'ztestrun.bat',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('! U1 getvar "device.unique_id"\r\n'),
    });
    const help = dialog('This file cannot be uploaded from a browser');
    await help.waitFor();
    assert.match(
      await help.locator('pre').textContent(),
      new RegExp(
        `node tools/upload\\.mjs ${cfg.ip.replace(/\./g, '\\.')} ztestrun\\.bat E:${BATCH_FILE}\\.BAT`,
      ),
    );
    await help.getByRole('button', { name: 'Close' }).click();
    assert.equal(await hasObject(cfg.ip, 'E', BATCH_FILE), false, 'nothing was stored');
  });

  s.test('Run executes a .BAT: it sets device.user_p1, which is then put back', async () => {
    userP1 = await getvar(cfg.ip, 'device.user_p1');
    if (userP1 === '?') {
      userP1 = null;
      skip('this printer has no device.user_p1');
    }
    const unique = `ZT${ctx.runId}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    await storeFile(cfg.ip, `! U1 setvar "device.user_p1" "${unique}"\r\n`, `E:${BATCH_FILE}.BAT`);

    await refreshListing();
    await rowButton(`E:${BATCH_FILE}.BAT`, 'Run').click();
    const confirm = dialog('Run this batch file?');
    await confirm.locator('pre').waitFor();
    assert.match(await confirm.locator('pre').textContent(), new RegExp(unique));
    await confirm.getByRole('button', { name: 'Run' }).click();
    await ui.toast(new RegExp(`Told the printer to run E:${BATCH_FILE}\\.BAT`));
    await waitFor(async () => (await getvar(cfg.ip, 'device.user_p1')) === unique, {
      what: `device.user_p1 to become ${unique}`,
    });
    await setvar(cfg.ip, 'device.user_p1', userP1);
    assert.equal(await getvar(cfg.ip, 'device.user_p1'), userP1, 'restored');
  });

  s.test('Delete takes types the CGI refuses (a .BAT) through file.delete', async () => {
    await rowButton(`E:${BATCH_FILE}.BAT`, 'Delete').click();
    await dialog('Delete this file?').getByRole('button', { name: 'Delete' }).click();
    await ui.toast(new RegExp(`Deleted E:${BATCH_FILE}\\.BAT`), { timeout: 60000 });
    assert.equal(await hasObject(cfg.ip, 'E', BATCH_FILE), false);
    await rowButton(`E:${IMAGE_FILE}.GRF`, 'Delete').click();
    await dialog('Delete this file?').getByRole('button', { name: 'Delete' }).click();
    await ui.toast(new RegExp(`Deleted E:${IMAGE_FILE}\\.GRF`), { timeout: 60000 });
    ui.assertNoErrors();
  });
}
