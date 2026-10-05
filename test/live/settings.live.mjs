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
 * Printer Settings, against settings made for the purpose.
 *
 * device.user_vars.create makes a setting of a chosen type, range and
 * default (ZPL manual, device.user_vars.create), so each kind of editor
 * the page builds can be tried without touching anything the printer
 * actually uses. The name may not hold a dot -- "test.integer" would
 * become test_integer -- so they are device.user_vars.test_*.
 *
 * The page only shows the settings in the catalogue captured when it was
 * built, so they are made in prepare(), before the deploy. They cannot
 * be deleted: they last until the printer is next power cycled, and
 * creating one that already exists is silently ignored -- so prepare()
 * also puts their values back to the defaults.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openConsole } from './lib/browser.mjs';
import { getvar, setvar, waitFor } from './lib/printer.mjs';
import { skip } from './lib/harness.mjs';

export const name = 'Printer Settings';

const BRANCH = 'device.user_vars';

/** The test settings: what each is made as, and how the page should show it. */
export const TEST_VARS = {
  test_string: { create: 'STRING:0-20:hello', initial: 'hello', editor: 'text' },
  test_integer: { create: 'INTEGER:1-100:5', initial: '5', editor: 'number' },
  test_double: { create: 'DOUBLE:0.5-99.5:1.5', initial: '1.5', editor: 'number' },
  test_choices: { create: 'CHOICES:red,green,blue:green', initial: 'green', editor: 'select' },
};

const full = (key) => `${BRANCH}.${key}`;

export async function prepare(ctx) {
  const { ip } = ctx.cfg;
  for (const [key, spec] of Object.entries(TEST_VARS)) {
    await setvar(ip, `${BRANCH}.create`, `${key}:${spec.create}`);
    // Already there from an earlier run: creating it again did nothing.
    await setvar(ip, full(key), spec.initial);
  }
}

export default function register(s, ctx) {
  const { cfg } = ctx;
  let con;
  let page;
  let ui;

  const row = (key) => page.locator(`[data-name="${full(key)}"]`);
  const editorOf = (key) => row(key).locator('input, select, textarea').first();

  /** Commit a value through a row's editor, the way a person would. */
  async function commit(key, value) {
    const editor = editorOf(key);
    if ((await editor.evaluate((n) => n.tagName)) === 'SELECT') {
      await editor.selectOption(String(value));
    } else {
      await editor.fill(String(value));
      await editor.press('Enter');
    }
    // "saving…" then whatever the read-back said.
    await waitFor(
      async () => {
        const text = await row(key).textContent();
        return !/saving…/.test(text) && /saved|kept|rejected|Applied/.test(text) ? text : null;
      },
      { timeout: 20000, what: `${key} to finish saving` },
    );
    return row(key).textContent();
  }

  s.cleanup(async () => {
    for (const [key, spec] of Object.entries(TEST_VARS))
      await setvar(cfg.ip, full(key), spec.initial);
  }, 'put the test settings back');
  s.cleanup(() => con && con.close());

  s.test('the printer made the test settings', async () => {
    for (const [key, spec] of Object.entries(TEST_VARS)) {
      const value = await getvar(cfg.ip, full(key));
      assert.notEqual(value, '?', `${full(key)} does not exist`);
      assert.equal(Number(value) || value, Number(spec.initial) || spec.initial, key);
    }
  });

  s.test('the page lists them, once the sweep has read every value', async () => {
    con = await openConsole(ctx.browser, cfg, 'settings');
    ({ page, ui } = con);
    const missing = [];
    for (const key of Object.keys(TEST_VARS)) if (!(await row(key).count())) missing.push(key);
    if (missing.length && !cfg.deploy) {
      skip(`not in the deployed catalogue (${missing.join(', ')}); run without --no-deploy`);
    }
    assert.deepEqual(missing, [], 'test settings missing from the catalogue');
    // Refresh is disabled while the sweep runs.
    const refresh = ui.button(ui.panel('settings'), 'Refresh values');
    await waitFor(() => refresh.isEnabled(), { timeout: 90000, what: 'the sweep to finish' });
    for (const [key, spec] of Object.entries(TEST_VARS)) {
      const value = await editorOf(key).inputValue();
      assert.equal(Number(value) || value, Number(spec.initial) || spec.initial, key);
    }
  });

  s.test('the Maintenance card shows the printer’s own odometers', async () => {
    const card = page.locator('#maintenance');
    await card.getByText('Labels printed').waitFor({ timeout: 60000 });
    const belowTable = await card.evaluate((node) => {
      const table = document.getElementById('settings-empty').closest('.card');
      return Boolean(table.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.ok(belowTable, 'the card sits below the settings table');
    const labels = Number(await getvar(cfg.ip, 'odometer.total_label_count'));
    const shown = Number(
      (
        await card
          .locator('div', { hasText: /^Labels printed/ })
          .locator('span')
          .last()
          .textContent()
      ).replace(/,/g, ''),
    );
    assert.equal(shown, labels);
    const cleaned = await getvar(cfg.ip, 'odometer.headclean');
    const inches = /^(\d+) INCHES/.exec(cleaned);
    if (inches) {
      assert.match(
        await card.textContent(),
        new RegExp(`Since the head was cleaned${Number(inches[1]).toLocaleString('en-US')} in`),
      );
    }
    // Resetting is checked as far as its confirmation: the printer's real
    // count could not be put back afterwards.
    await card.getByRole('button', { name: 'Head cleaned' }).click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Head cleaned?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await getvar(cfg.ip, 'odometer.headclean'), cleaned, 'Cancel changed nothing');
  });

  s.test('the filter finds them by name, word by word in any order', async () => {
    const filter = page.getByPlaceholder('Filter by name or value…');
    await filter.fill('test_ user_vars');
    await page.waitForTimeout(400);
    const shown = await page
      .locator('[data-name]:visible')
      .evaluateAll((n) => n.map((r) => r.dataset.name));
    assert.deepEqual(shown.sort(), Object.keys(TEST_VARS).map(full).sort());
    assert.match(await ui.panel('settings').locator('.toolbar').textContent(), /4 of \d+ settings/);
    await filter.fill('no_such_setting_anywhere');
    await page.locator('#settings-empty:visible').waitFor();
    await filter.fill('test_ user_vars');
    await page.waitForTimeout(400);
  });

  s.test('each type gets its own editor', async () => {
    const choices = editorOf('test_choices');
    assert.equal(await choices.evaluate((n) => n.tagName), 'SELECT', 'CHOICES is a dropdown');
    assert.deepEqual(await choices.locator('option').allTextContents(), ['red', 'green', 'blue']);
    assert.equal(await choices.inputValue(), 'green');

    const integer = editorOf('test_integer');
    assert.equal(await integer.getAttribute('type'), 'number');
    assert.equal(await integer.getAttribute('min'), '1');
    assert.equal(await integer.getAttribute('max'), '100');
    assert.equal(await integer.getAttribute('step'), '1');

    const double = editorOf('test_double');
    assert.equal(await double.getAttribute('type'), 'number');
    assert.equal(await double.getAttribute('step'), 'any');
    assert.equal(Number(await double.getAttribute('min')), 0.5);
    assert.equal(Number(await double.getAttribute('max')), 99.5);

    const text = editorOf('test_string');
    assert.equal(await text.evaluate((n) => n.tagName), 'INPUT');
    assert.equal(await text.getAttribute('type'), 'text');
    // The branch listing does not say a string's length limit, so the
    // box has none; the printer still enforces it, and the read-back shows.
  });

  s.test('choosing from the dropdown writes the choice', async () => {
    assert.match(await commit('test_choices', 'blue'), /saved/);
    assert.equal(await getvar(cfg.ip, full('test_choices')), 'blue');
  });

  s.test('an integer in range is written; one out of range is refused and shown', async () => {
    assert.match(await commit('test_integer', '42'), /saved/);
    assert.equal(await getvar(cfg.ip, full('test_integer')), '42');

    const result = await commit('test_integer', '500');
    assert.match(result, /Printer kept/, 'the row says the printer refused it');
    assert.equal(await editorOf('test_integer').inputValue(), '42', 'the box shows what was kept');
    assert.equal(await getvar(cfg.ip, full('test_integer')), '42');
    await ui.toast(/test_integer/);
  });

  s.test('a double is written and read back as a number', async () => {
    assert.match(await commit('test_double', '12.25'), /saved/);
    assert.equal(Number(await getvar(cfg.ip, full('test_double'))), 12.25);
  });

  s.test('a string with & " < > survives the round trip', async () => {
    // The preprocessor escapes these on the way out; the page must undo it.
    const value = 'A&B "q" <x>';
    assert.match(await commit('test_string', value), /saved/);
    assert.equal(await getvar(cfg.ip, full('test_string')), value);
    assert.equal(await editorOf('test_string').inputValue(), value);
  });

  s.test('a string longer than its range is refused by the printer, and shown', async () => {
    const before = await getvar(cfg.ip, full('test_string'));
    const result = await commit('test_string', 'x'.repeat(25));
    assert.match(result, /Printer kept/);
    assert.equal(await getvar(cfg.ip, full('test_string')), before);
    assert.equal(await editorOf('test_string').inputValue(), before);
  });

  s.test('changed settings are marked, and "not default" puts one back', async () => {
    const meta = await row('test_integer').getAttribute('data-modified');
    if (!(await row('test_integer').getByRole('button', { name: 'not default' }).count())) {
      skip('the printer does not say a user variable’s default');
    }
    assert.equal(meta, 'true', 'test_integer differs from its default');
    await page.getByRole('checkbox', { name: 'changed from default' }).check();
    await page.waitForTimeout(300);
    assert.equal(await row('test_integer').isVisible(), true);
    await row('test_integer').getByRole('button', { name: 'not default' }).click();
    await waitFor(async () => (await getvar(cfg.ip, full('test_integer'))) === '5', {
      what: 'test_integer back at its default',
    });
    await waitFor(
      async () => (await row('test_integer').getAttribute('data-modified')) === 'false',
    );
    await page.getByRole('checkbox', { name: 'changed from default' }).uncheck();
  });

  s.test('Refresh values shows a change made behind the page’s back', async () => {
    const outside = `ext-${ctx.runId}`.toLowerCase();
    await setvar(cfg.ip, full('test_string'), outside);
    await ui.button(ui.panel('settings'), 'Refresh values').click();
    await waitFor(async () => (await editorOf('test_string').inputValue()) === outside, {
      timeout: 90000,
      what: 'the refreshed value',
    });
  });

  s.test('the filter matches values as well as names', async () => {
    const filter = page.getByPlaceholder('Filter by name or value…');
    await filter.fill(`ext-${ctx.runId}`.toLowerCase());
    await page.waitForTimeout(400);
    const shown = await page
      .locator('[data-name]:visible')
      .evaluateAll((n) => n.map((r) => r.dataset.name));
    assert.deepEqual(shown, [full('test_string')]);
    await filter.fill('');
  });

  s.test('sorting reorders a branch, alphabetically', async () => {
    await page.locator('select[title^="How the settings are ordered"]').selectOption('alpha');
    await page.waitForTimeout(300);
    const names = await page
      .locator(`[data-name^="${BRANCH}."]`)
      .evaluateAll((n) => n.map((r) => r.dataset.name));
    assert.deepEqual(names, [...names].sort(), 'device.user_vars in alphabetical order');
    await page.locator('select[title^="How the settings are ordered"]').selectOption('default');
  });

  s.test('clicking a setting’s name explains it; clicking again closes it', async () => {
    const filter = page.getByPlaceholder('Filter by name or value…');
    await filter.fill('media.speed');
    await page.waitForTimeout(400);
    const name = page.locator('[data-name="media.speed"] code').first();
    await name.click();
    const explain = page.locator('[data-explain="media.speed"]');
    await explain.getByText(/Print speed, in inches a second/).waitFor({ timeout: 30000 });
    assert.match(await explain.textContent(), /Range: /, 'with the catalogue’s range');
    await name.click();
    assert.equal(await explain.count(), 0);

    // One the guide does not describe: a user's own setting.
    await filter.fill('test_choices');
    await page.waitForTimeout(400);
    await row('test_choices').locator('code').first().click();
    await page
      .locator(`[data-explain="${full('test_choices')}"]`)
      .getByText('The ZPL programming guide does not describe this setting.')
      .waitFor();
    await filter.fill('');
    ui.assertNoErrors();
  });

  let userP1 = null;
  s.cleanup(async () => {
    if (userP1 !== null) await setvar(cfg.ip, 'device.user_p1', userP1);
  }, 'put device.user_p1 back');

  s.test('a backup saves changed settings, and restoring puts one back', async () => {
    userP1 = await getvar(cfg.ip, 'device.user_p1');
    const backedUp = `ZTB${ctx.runId}`.slice(0, 20);
    await setvar(cfg.ip, 'device.user_p1', backedUp);
    const refresh = ui.button(ui.panel('settings'), 'Refresh values');
    await refresh.click();
    await waitFor(() => refresh.isEnabled(), { timeout: 90000, what: 'the sweep' });

    await ui.panel('settings').getByRole('button', { name: 'Back up…' }).click();
    const backupDialog = page.locator('#modal-root .card', { hasText: 'Back up settings' });
    assert.match(await backupDialog.textContent(), /\d+ settings? will be saved/);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      backupDialog.getByRole('button', { name: 'Download' }).click(),
    ]);
    const path = await download.path();
    const backup = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(backup.format, 'zebra-console-settings');
    assert.equal(backup.settings['device.user_p1'], backedUp);
    assert.ok(!Object.keys(backup.settings).some((n) => /password|^rtc\.|^odometer\./.test(n)));

    // Changed behind the page's back, then put back from the backup.
    await setvar(cfg.ip, 'device.user_p1', 'changed');
    await refresh.click();
    await waitFor(() => refresh.isEnabled(), { timeout: 90000, what: 'the sweep' });
    await ui.panel('settings').getByRole('button', { name: 'Restore…' }).click();
    const restoreDialog = page.locator('#modal-root .card', { hasText: 'Restore settings' });
    await restoreDialog.locator('input[type="file"]').setInputFiles(path);
    const box = restoreDialog.locator('input[data-name="device.user_p1"]');
    await box.waitFor();
    assert.equal(await box.isChecked(), true, 'the one that differs is ticked');
    await restoreDialog.getByRole('button', { name: /^Restore \d+ settings?$/ }).click();
    await ui.toast(/Restored \d+ setting/, { timeout: 120000 });
    assert.equal(await getvar(cfg.ip, 'device.user_p1'), backedUp);
  });

  s.test('a slow setting is read on request', async () => {
    const filter = page.getByPlaceholder('Filter by name or value…');
    await filter.fill('file.drive_listing');
    await page.waitForTimeout(400);
    const listing = page.locator('[data-name="file.drive_listing"]');
    if (!(await listing.count())) skip('this printer has no file.drive_listing');
    const button = listing.getByRole('button', { name: /Read now|reading/ });
    if (await button.count()) {
      await button.waitFor();
      if (await button.isEnabled()) await button.click();
    }
    await waitFor(async () => /"E"\s*:/.test(await listing.textContent()), {
      timeout: 60000,
      what: 'the drive listing',
    });
    await filter.fill('');
    ui.assertNoErrors();
  });
}
