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

/*
 * Stored Formats, with formats made for the purpose: a ZPL one stored
 * the way a host would (^DF over port 9100) and a CPCL one uploaded as a
 * file. ZPL formats are read back and previewed; CPCL ones the web
 * server will neither list under their real name nor hand over, so they
 * arrive through the drive listing and have their source pasted.
 */

import assert from 'node:assert/strict';
import { openConsole } from './lib/browser.mjs';
import { watchZpl } from './lib/fixtures.mjs';
import { sendZpl, storeFile, removeFile, getvar, waitFor } from './lib/printer.mjs';
import { skip } from './lib/harness.mjs';

export const name = 'Stored Formats';

const ZPL_FORMAT = 'ZTESTFMT';
const CPCL_FORMAT = 'ZTESTCP';

/** A ZPL format with three named fields, one of them with a default. */
function zplFormat({ width, height }) {
  return [
    '^XA',
    `^DFE:${ZPL_FORMAT}.ZPL^FS`,
    `^PW${width}`,
    `^LL${height}`,
    '^FO30,30^A0N,40,40^FN1"NAME"^FDdefault name^FS',
    '^FO30,90^A0N,30,30^FN2"CITY"^FS',
    '^FO30,140^BY2^BCN,60,Y,N,N^FN3"SKU"^FD12345^FS',
    '^XZ',
  ].join('\r\n');
}

/** A CPCL format with three \\ placeholders. */
const CPCL_SOURCE = [
  '! 0 200 200 300 1',
  'TEXT 4 0 30 30 \\\\',
  'TEXT 4 0 30 90 \\\\',
  'BARCODE 128 1 1 50 30 150 \\\\',
  'FORM',
  'PRINT',
  '',
].join('\r\n');

export default function register(s, ctx) {
  const { cfg } = ctx;
  let con;
  let page;
  let ui;
  let zpl;
  let panel;
  let languages;

  const select = () => panel.locator('select').first();
  const inputs = () => panel.locator('label input[type="text"]');
  const printButton = () =>
    panel.locator('.toolbar').first().getByRole('button', { name: 'Print', exact: true });

  s.cleanup(() => removeFile(cfg.ip, `E:${ZPL_FORMAT}.ZPL`), `remove E:${ZPL_FORMAT}.ZPL`);
  s.cleanup(() => removeFile(cfg.ip, `E:${CPCL_FORMAT}.FMT`), `remove E:${CPCL_FORMAT}.FMT`);
  s.cleanup(() => con && con.close());

  s.test('store a ZPL format (^DF) and a CPCL one (file upload)', async () => {
    await sendZpl(cfg.ip, zplFormat(cfg.label));
    await storeFile(cfg.ip, CPCL_SOURCE, `E:${CPCL_FORMAT}.FMT`);
    languages = await getvar(cfg.ip, 'device.languages');
  });

  s.test('the ZPL format is listed at once, as ZPL', async () => {
    con = await openConsole(ctx.browser, cfg, 'format');
    ({ page, ui } = con);
    zpl = watchZpl(page);
    panel = ui.panel('format');
    await waitFor(
      async () => (await select().locator(`option[value="E:${ZPL_FORMAT}.ZPL"]`).count()) === 1,
      { what: `E:${ZPL_FORMAT}.ZPL in the list` },
    );
    assert.match(
      await select().locator(`option[value="E:${ZPL_FORMAT}.ZPL"]`).textContent(),
      /— ZPL/,
    );
  });

  s.test('choosing it reads its fields, with their names and defaults', async () => {
    const since = Date.now();
    await select().selectOption(`E:${ZPL_FORMAT}.ZPL`);
    await waitFor(async () => (await inputs().count()) === 3, { what: 'three fields' });
    const captions = await panel.locator('label .label-text').allTextContents();
    assert.deepEqual(
      captions.map((c) => c.replace(/\s+/g, ' ').trim()),
      ['NAME (^FN1)', 'CITY (^FN2)', 'SKU (^FN3)'],
    );
    assert.equal(await inputs().nth(0).inputValue(), 'default name');
    assert.equal(await inputs().nth(0).getAttribute('placeholder'), 'default: default name');
    assert.equal(await inputs().nth(2).inputValue(), '12345');
    assert.match(await panel.textContent(), /ZPL · 3 fields/);
    const first = await zpl.next('preview', { since });
    assert.match(first.data, new RegExp(`\\^XFE:${ZPL_FORMAT}\\.ZPL\\^FS`));
  });

  s.test('filling the fields previews the recalled format', async () => {
    await inputs().nth(0).fill('Ada Lovelace');
    await inputs().nth(1).fill('London & Co');
    await inputs().nth(2).fill('SKU-42');
    const since = Date.now();
    const post = await zpl.next('preview', { since });
    await page.waitForTimeout(900);
    const data = zpl.last('preview').data || post.data;
    assert.match(data, /\^FN1\^FH\^FDAda Lovelace\^FS/);
    assert.match(data, /\^FN2\^FH\^FDLondon & Co\^FS/);
    assert.match(data, /\^FN3\^FH\^FDSKU-42\^FS/);
    await panel.getByText('up to date').waitFor();
    const img = panel.locator('img[alt="Rendered label"]');
    await waitFor(() => img.evaluate((n) => n.complete && n.naturalWidth > 0), {
      what: 'the preview image',
    });
  });

  s.test('Enter walks the fields; Reset to defaults puts them back', async () => {
    await inputs().nth(0).focus();
    await page.keyboard.press('Enter');
    assert.equal(
      await inputs()
        .nth(1)
        .evaluate((n) => n === document.activeElement),
      true,
    );
    await panel.getByRole('button', { name: 'Reset to defaults' }).click();
    assert.equal(await inputs().nth(0).inputValue(), 'default name');
    assert.equal(await inputs().nth(1).inputValue(), '');
  });

  s.test('copies become ^PQ in the recall', async () => {
    const copies = panel.locator('label', { hasText: 'Copies' }).locator('input');
    const since = Date.now();
    await copies.fill('2');
    await copies.dispatchEvent('change');
    const post = await zpl.next('preview', { since });
    assert.match(post.data, /\^PQ2\n\^XZ/);
    await copies.fill('0');
    await copies.dispatchEvent('change');
    assert.equal(await copies.inputValue(), '1', 'zero becomes one');
    await copies.fill('1');
    await copies.dispatchEvent('change');
  });

  s.test('Print sends the filled-in format', async () => {
    if (!cfg.print) skip('printing not enabled');
    await inputs().nth(0).fill(`ZTEST format ${ctx.runId}`);
    const odometer = Number(await getvar(cfg.ip, 'odometer.total_label_count')) || null;
    const since = Date.now();
    await printButton().click();
    const sent = await zpl.next('print', { since });
    assert.match(sent.data, new RegExp(`\\^FN1\\^FH\\^FDZTEST format ${ctx.runId}`));
    await ui.toast(/Label sent to the printer/);
    if (odometer !== null) {
      await waitFor(
        async () => Number(await getvar(cfg.ip, 'odometer.total_label_count')) > odometer,
        { timeout: 30000, what: 'the label counter to go up' },
      );
    }
  });

  s.test('the CPCL format joins the list once the drive listing is read', async () => {
    // It is listed by /dir as "---", so only the drive listing names it.
    await waitFor(
      async () => (await select().locator(`option[value="E:${CPCL_FORMAT}.FMT"]`).count()) === 1,
      { timeout: 90000, what: `E:${CPCL_FORMAT}.FMT in the list` },
    );
    assert.match(
      await select().locator(`option[value="E:${CPCL_FORMAT}.FMT"]`).textContent(),
      /— CPCL/,
    );
    assert.equal(await panel.getByText('looking for CPCL formats…').count(), 0);
  });

  s.test('a CPCL format says what cannot be done, and takes a field count', async () => {
    await select().selectOption(`E:${CPCL_FORMAT}.FMT`);
    await panel.getByText('CPCL format', { exact: false }).first().waitFor();
    const text = await panel.textContent();
    assert.match(text, /will not return the contents of a CPCL file/);
    assert.match(text, /no preview for CPCL|only renders ZPL previews/);
    const speaksCpcl = ['cpcl', 'line_print'].includes(languages.trim().toLowerCase());
    assert.equal(/does not parse CPCL/.test(text), !speaksCpcl, `device.languages is ${languages}`);

    const count = panel.locator('label', { hasText: 'placeholders' }).locator('input');
    await count.fill('2');
    await count.dispatchEvent('change');
    await waitFor(async () => (await inputs().count()) === 2, { what: 'two blank fields' });
  });

  s.test('pasting its source names the fields', async () => {
    await panel.getByRole('button', { name: 'Paste source…' }).click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Paste CPCL source' });
    await dialog.locator('textarea').fill(CPCL_SOURCE);
    await dialog.getByRole('button', { name: 'Read fields' }).click();
    await ui.toast(/Found 3 placeholder/);
    const captions = await panel.locator('label .label-text').allTextContents();
    assert.equal(captions.length, 3);
    assert.match(captions[0], /^1\. TEXT 4 0 30 30/);
    assert.match(captions[2], /^3\. BARCODE 128/);
  });

  s.test('printing CPCL sends ! UF with the values, one to a line', async () => {
    if (!cfg.print) skip('printing not enabled');
    if (!['cpcl', 'line_print'].includes(languages.trim().toLowerCase())) {
      skip(`device.languages is ${languages}, which does not parse CPCL`);
    }
    await inputs().nth(0).fill('ZTEST CPCL');
    await inputs().nth(1).fill(ctx.runId);
    await inputs().nth(2).fill('12345');
    const since = Date.now();
    await printButton().click();
    const sent = await zpl.next('print', { since });
    assert.match(sent.data, new RegExp(`^! UF ${CPCL_FORMAT}\\.FMT\\r\\nZTEST CPCL\\r\\n`));
    await ui.toast(/Label sent to the printer/);
  });

  s.test('File System’s Print hands a CPCL format over with its fields read', async () => {
    await ui.showTab('files');
    const files = ui.panel('files');
    const row = files.locator('div.flex-wrap.gap-x-3', { hasText: `E:${CPCL_FORMAT}.FMT` });
    await row.waitFor({ timeout: 90000 });
    const print = row.getByRole('button', { name: 'Print', exact: true });
    if (!(await print.count())) skip('File System offers no Print for a .FMT');
    await print.click();
    await page.locator('.tab-btn[data-tab="format"][aria-selected="true"]').waitFor();
    await waitFor(async () => (await inputs().count()) === 3, {
      what: 'the three placeholders, read from the file',
    });
    assert.equal(await select().inputValue(), `E:${CPCL_FORMAT}.FMT`);
    ui.assertNoErrors();
  });
}
