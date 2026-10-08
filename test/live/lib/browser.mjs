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
 * The console, opened in a real browser, served by the real printer.
 *
 * playwright-core drives the Chrome already installed (it downloads no
 * browser of its own). Each suite gets a fresh browser context, so one
 * suite's remembered units or grid do not leak into the next, and every
 * page records its script errors -- the console renders those into the
 * DOM rather than letting them pass, and so do the tests.
 */

import { chromium } from 'playwright-core';

export async function launchBrowser(cfg) {
  return chromium.launch({
    executablePath: cfg.chrome,
    headless: !cfg.headed,
  });
}

/**
 * Open the console on one mode, in a context of its own. The printer
 * caches the page hard, so the URL carries a query string that changes
 * every time (on /INDEX.SHTML -- a query on / itself is a 500).
 */
export async function openConsole(browser, cfg, mode, { viewport, acceptDownloads = true } = {}) {
  const context = await browser.newContext({
    viewport: viewport || { width: 1400, height: 1000 },
    acceptDownloads,
  });
  // The password the console would otherwise ask for, as the session
  // holding it would have it.
  await context.addInitScript((pw) => {
    try {
      sessionStorage.setItem('zebra.pw', pw);
    } catch (err) {
      /* no storage: the page will ask */
    }
  }, cfg.password);

  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) {
      errors.push(`console: ${msg.text()}`);
    }
  });

  await page.goto(`http://${cfg.ip}/INDEX.SHTML?t=${Date.now()}#${mode}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.locator(`.tab-btn[data-tab="${mode}"][aria-selected="true"]`).waitFor();

  const ui = helpers(page, errors);
  return { context, page, errors, ui, close: () => context.close() };
}

/** Small things every suite does with the page. */
function helpers(page, errors) {
  const panel = (mode) => page.locator(`[data-panel="${mode}"]`);
  const modal = page.locator('#modal-root .card').last();

  return {
    panel,
    modal,

    /** Fail if the page has reported a script error. */
    assertNoErrors() {
      if (errors.length) {
        const list = errors.splice(0);
        throw new Error(`The page reported errors:\n  ${list.join('\n  ')}`);
      }
    },

    /** Wait for a toast whose text matches. */
    async toast(pattern, { timeout = 30000 } = {}) {
      const node = page.locator('#toasts > div', { hasText: pattern }).last();
      await node.waitFor({ timeout });
      return (await node.textContent()).trim();
    },

    /** Click a button by its exact label, within a scope. */
    button(scope, label) {
      return scope.getByRole('button', { name: label, exact: true });
    },

    /** The input or select following a label-text caption, in a scope. */
    field(scope, caption) {
      return scope
        .locator('label', {
          has: page.locator('.label-text', { hasText: new RegExp(`^${escapeRe(caption)}$`) }),
        })
        .locator('input, select, textarea')
        .first();
    },

    /** Set a field's value and fire change, as typing then leaving would. */
    async setField(locator, value) {
      const tag = await locator.evaluate((n) => n.tagName);
      if (tag === 'SELECT') {
        await locator.selectOption(String(value));
      } else {
        await locator.fill(String(value));
        await locator.dispatchEvent('change');
      }
    },

    /** Switch tabs through the tab bar. */
    async showTab(mode) {
      await page.locator(`.tab-btn[data-tab="${mode}"]`).click();
      await page.locator(`.tab-btn[data-tab="${mode}"][aria-selected="true"]`).waitFor();
    },
  };
}

export function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
