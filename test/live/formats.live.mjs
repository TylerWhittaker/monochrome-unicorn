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

/** A ZPL format with three named fields, the last fixed by the format itself. */
function zplFormat({ width, height }) {
  return [
    '^XA',
    `^DFE:${ZPL_FORMAT}.ZPL^FS`,
    `^PW${width}`,
    `^LL${height}`,
    '^FO30,30^A0N,40,40^FN1"NAME"^FS',
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

  s.test('choosing it reads its fields; one the format fills in is fixed', async () => {
    const since = Date.now();
    await select().selectOption(`E:${ZPL_FORMAT}.ZPL`);
    await waitFor(async () => (await inputs().count()) === 3, { what: 'three fields' });
    const captions = await panel.locator('label .label-text').allTextContents();
    assert.deepEqual(
      captions.map((c) => c.replace(/\s+/g, ' ').trim()),
      ['NAME (^FN1)', 'CITY (^FN2)', 'SKU (^FN3)'],
    );
    assert.equal(await inputs().nth(0).inputValue(), '');
    // ^FN3^FD12345 in the format: the printer prints that whatever is sent.
    assert.equal(await inputs().nth(2).inputValue(), '12345');
    assert.equal(
      await inputs()
        .nth(2)
        .evaluate((n) => n.readOnly),
      true,
    );
    assert.match(await panel.textContent(), /Set by the format \(\^FD\)/);
    assert.match(await panel.textContent(), /ZPL · 3 fields/);
    const first = await zpl.next('preview', { since });
    assert.match(first.data, new RegExp(`\\^XFE:${ZPL_FORMAT}\\.ZPL\\^FS`));
  });

  s.test('filling the fields previews the recalled format, without the fixed one', async () => {
    await inputs().nth(0).fill('Ada Lovelace');
    await inputs().nth(1).fill('London & Co');
    const since = Date.now();
    const post = await zpl.next('preview', { since });
    await page.waitForTimeout(900);
    const data = zpl.last('preview').data || post.data;
    assert.match(data, /\^FN1\^FH\^FDAda Lovelace\^FS/);
    assert.match(data, /\^FN2\^FH\^FDLondon & Co\^FS/);
    // Sent, it would print on its own in the label's corner.
    assert.doesNotMatch(data, /\^FN3/);
    await panel.getByText('up to date').waitFor();
    const img = panel.locator('img[alt="Rendered label"]');
    await waitFor(() => img.evaluate((n) => n.complete && n.naturalWidth > 0), {
      what: 'the preview image',
    });
  });

  s.test('a spinner turns while the preview is rendering', async () => {
    const spinner = panel.getByRole('status', { name: 'Rendering' });
    assert.equal(await spinner.isVisible(), false);
    // Hold the printer's answer, so the render is caught in progress.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const passed = [];
    await page.route('**/zpl', (route) => {
      const through = held.then(() => route.continue());
      passed.push(through);
      return through;
    });
    try {
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
      await panel.getByText('rendering…').waitFor();
      assert.equal(await spinner.isVisible(), true);
    } finally {
      release();
      // Taken down only once what it held has gone on to the printer.
      await Promise.all(passed);
      await page.unroute('**/zpl');
    }
    await panel.getByText('up to date').waitFor();
    assert.equal(await spinner.isVisible(), false);
  });

  s.test('Enter walks the fields; Clear fields empties them', async () => {
    await inputs().nth(0).focus();
    await page.keyboard.press('Enter');
    assert.equal(
      await inputs()
        .nth(1)
        .evaluate((n) => n === document.activeElement),
      true,
    );
    await panel.getByRole('button', { name: 'Clear fields' }).click();
    assert.equal(await inputs().nth(0).inputValue(), '');
    assert.equal(await inputs().nth(1).inputValue(), '');
    assert.equal(await inputs().nth(2).inputValue(), '12345', 'the fixed field stays');
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

  s.test('a CSV batch: columns matched by name, a row previewed', async () => {
    await panel.getByRole('button', { name: 'Batch from CSV…' }).click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Batch from CSV' });
    // Columns in another order than the fields, to be matched by ^FN name.
    await dialog
      .locator('textarea')
      .fill(
        'SKU,NAME,CITY\nS-1,Ada,London\nS-2,"Grace, Rear Admiral",Arlington\nS-3,Alan,Wilmslow\n',
      );
    await dialog.getByRole('button', { name: 'Use these rows' }).click();
    await panel.getByText('Batch: 3 rows from pasted CSV').waitFor();
    assert.equal(await panel.locator('tr[data-row]').count(), 3);
    const mapped = await panel
      .locator('label', {
        has: page.locator('select', { has: page.locator('option', { hasText: '— none —' }) }),
      })
      .evaluateAll((labels) =>
        labels.map((l) => [
          l.textContent.split('—')[0].trim(),
          l.querySelector('select').selectedOptions[0].textContent,
        ]),
      );
    assert.deepEqual(
      mapped.map(([field, column]) => [
        field.replace(/\s+/g, ' ').replace(/ \(\^FN\d\).*$/, ''),
        column,
      ]),
      [
        ['NAME', 'NAME'],
        ['CITY', 'CITY'],
      ],
      'the fixed SKU is not offered a column',
    );
    const since = Date.now();
    await panel.locator('tr[data-row="1"]').click();
    const post = await zpl.next('preview', { since });
    assert.match(post.data, /\^FN1\^FH\^FDGrace, Rear Admiral\^FS/);
    assert.match(post.data, /\^FN2\^FH\^FDArlington\^FS/);
    assert.doesNotMatch(post.data, /\^FN3/);
    assert.match(await panel.textContent(), /Print 3 labels/);

    // Next and the arrow keys step through the rows, previewing each.
    const rowOf = panel.locator('[data-row-of]');
    const previewed = (pattern) =>
      waitFor(() => pattern.test((zpl.last('preview') || {}).data || ''), {
        what: `a preview matching ${pattern}`,
      });
    await panel.getByRole('button', { name: 'Next ›' }).click();
    assert.equal(await rowOf.textContent(), 'Row 3 of 3');
    await previewed(/\^FDAlan\^FS/);
    assert.equal(await panel.getByRole('button', { name: 'Next ›' }).isDisabled(), true);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await rowOf.textContent(), 'Row 1 of 3');
    await previewed(/\^FDAda\^FS/);
  });

  s.test('a CSV batch prints every row', async () => {
    if (!cfg.print) {
      await panel.getByRole('button', { name: 'Clear', exact: true }).click();
      skip('printing not enabled');
    }
    const since = Date.now();
    await panel.getByRole('button', { name: 'Print 3 labels' }).click();
    await ui.toast(/Sent 3 rows to the printer/, { timeout: 60000 });
    const sent = zpl.posts.filter((p) => p.action === 'print' && p.at >= since);
    assert.equal(sent.length, 1, 'three rows fit one request');
    assert.equal((sent[0].data.match(/\^XF/g) || []).length, 3);
    await panel.getByRole('button', { name: 'Clear', exact: true }).click();
  });

  s.test('a CSV batch says which rows leave a field empty', async () => {
    await panel.getByRole('button', { name: 'Batch from CSV…' }).click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Batch from CSV' });
    // A blank NAME in row 2, and no column called CITY.
    await dialog.locator('textarea').fill('NAME,TOWN\nAda,x\n,y\nAlan,z\n');
    await dialog.getByRole('button', { name: 'Use these rows' }).click();
    await panel.getByText('Batch: 3 rows from pasted CSV').waitFor();
    const notes = await panel.locator('[data-gap]').allTextContents();
    assert.ok(
      notes.some((n) => /^CITY\b.* has no column/.test(n)),
      `CITY unmatched: ${notes.join(' | ')}`,
    );
    const nameGap = panel.locator('[data-gap]', {
      hasText: /^1 row leaves NAME\b.* empty \(first: row 2\)\.$/,
    });
    await nameGap.click();
    assert.equal(await panel.locator('[data-row-of]').textContent(), 'Row 2 of 3');
    await panel.getByRole('button', { name: 'Clear', exact: true }).click();
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

  s.test('a CPCL format’s fields are read from the file itself; there is no preview', async () => {
    // /zpl only opens a .ZPL, but the stored file can be fetched as itself.
    await select().selectOption(`E:${CPCL_FORMAT}.FMT`);
    await panel.getByText('CPCL format', { exact: false }).first().waitFor();
    await waitFor(async () => (await inputs().count()) === 3, { what: 'three placeholders' });
    const captions = await panel.locator('label .label-text').allTextContents();
    assert.match(captions[0], /^1\. TEXT 4 0 30 30/);
    assert.match(captions[2], /^3\. BARCODE 128/);
    const text = await panel.textContent();
    assert.doesNotMatch(text, /would not hand over/);
    assert.equal(await panel.getByRole('button', { name: 'Paste source…' }).count(), 0);
    assert.match(text, /no preview for CPCL|only renders ZPL previews/);
    const speaksCpcl = ['cpcl', 'line_print'].includes(languages.trim().toLowerCase());
    assert.equal(/does not parse CPCL/.test(text), !speaksCpcl, `device.languages is ${languages}`);
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
