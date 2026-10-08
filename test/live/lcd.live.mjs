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
 * The LCD Viewer, both ways it draws the screen.
 *
 * display.text: a WML menu per font is stored on E: and put on the
 * printer's screen with display.load_card; the viewer must find the
 * <font> tag in the file on screen and lay the text out in that font's
 * columns, at that font's size. The soft keys are pressed from the page
 * to step from one menu to the next.
 *
 * lcd_display_helper.sh: run for real, it puts the panel's pixels on
 * the printer's RAM drive, and the viewer must switch to them -- and
 * back to display.text once it is stopped.
 *
 * The screen is put back on whatever it showed before.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConsole } from './lib/browser.mjs';
import { getvar, setvar, storeFile, removeFile, hasObject, waitFor } from './lib/printer.mjs';
import { skip } from './lib/harness.mjs';

export const name = 'LCD Viewer';

/*
 * The fonts tried, and the grid the viewer should lay display.text out
 * in: columns across the 240-pixel panel (docs/printer-notes.md). null
 * is a menu with no <font> tag; C.FNT does not exist, and the panel
 * falls back to A for it.
 */
const FONTS = [
  { key: 'NONE', font: null, columns: 40 },
  { key: 'A', font: 'A.FNT', columns: 40 },
  { key: 'B', font: 'B.FNT', columns: 26, capitals: true },
  { key: 'D', font: 'D.FNT', columns: 20 },
  { key: 'E6', font: 'E6.FNT', columns: 18 },
  { key: 'F', font: 'F.FNT', columns: 15 },
  { key: 'H6', font: 'H6.FNT', columns: 16 },
  { key: 'MONO', font: 'MONOBD15.FNT', columns: 26 },
  { key: 'C', font: 'C.FNT', columns: 40, unknown: true },
];

const fileOf = (f) => `ZTESTLCD${f.key}.WML`;

/** A one-card menu in a font, whose soft keys step to its neighbours. */
function wml(f, prev, next) {
  return [
    '<wml>',
    '<display>',
    '<card id="main" title="" alerts="on">',
    f.font ? `  <font name="${f.font}" vspace="0"></font>` : '',
    `  <p>ZTEST ${f.font || 'no font'}</p><br/>`,
    '  <p>abcdefghijklmnopqrstuvwxyz</p><br/>',
    '  <nav_bar>',
    `    <p1 href="${fileOf(prev)}">Prev</p1>`,
    `    <p2 href="${fileOf(next)}">Next</p2>`,
    '  </nav_bar>',
    '</card>',
    '</display>',
    '</wml>',
    '',
  ].join('\r\n');
}

/**
 * Put a menu back on the screen. The printer ignores a display.load_card
 * naming a file the drive does not have -- display.root_wml defaults to
 * E:INDEX.WML, which is usually not on E: at all -- but finds a bare name
 * on any drive, which is how it reaches the built-in Z:INDEX.WML.
 */
async function restoreScreen(ip, card) {
  const file = (name) =>
    String(name)
      .split('#')[0]
      .replace(/^[A-Z]:/i, '')
      .toUpperCase();
  await setvar(ip, 'display.load_card', card);
  if (file(await getvar(ip, 'display.load_card')) === file(card)) return;
  await setvar(ip, 'display.load_card', file(card));
  await waitFor(async () => file(await getvar(ip, 'display.load_card')) === file(card), {
    what: `the screen to go back to ${card}`,
  });
}

export default function register(s, ctx) {
  const { cfg } = ctx;
  let con;
  let page;
  let ui;
  let panel;
  let original = null;
  let helper = null;
  let helperDir = null;

  const caption = () =>
    panel
      .locator('.text-\\[11px\\].text-ink-400')
      .filter({ hasText: /display\.text|lcd_display_helper/ });
  const screen = () => panel.locator('.lcd-screen');
  /** The screen's text, with the grid's non-breaking spaces made plain. */
  const screenText = async () => (await screen().textContent()).replace(/\u00a0/g, ' ');

  async function show(f) {
    await setvar(cfg.ip, 'display.load_card', fileOf(f));
    await waitFor(async () => (await getvar(cfg.ip, 'display.text')).includes('ZTEST'), {
      what: `${fileOf(f)} on the printer's screen`,
    });
  }

  s.cleanup(async () => {
    if (helper && helper.exitCode === null) helper.kill('SIGINT');
    if (helperDir) rmSync(helperDir, { recursive: true, force: true });
  }, 'stop the helper');
  s.cleanup(async () => {
    if (original) await restoreScreen(cfg.ip, original);
    await removeFile(cfg.ip, 'E:ZTESTLCD*.WML');
  }, 'put the screen back and remove the test menus');
  s.cleanup(() => con && con.close());

  s.test('store a test menu in each font', async () => {
    if ((await getvar(cfg.ip, 'display.text')) === '?') skip('this printer has no display');
    original = await getvar(cfg.ip, 'display.load_card');
    // A test menu left on screen by a run that was cut short is not
    // what to go back to.
    if (!original || /ZTEST/i.test(original)) original = await getvar(cfg.ip, 'display.root_wml');
    for (let i = 0; i < FONTS.length; i++) {
      const prev = FONTS[(i + FONTS.length - 1) % FONTS.length];
      const next = FONTS[(i + 1) % FONTS.length];
      await storeFile(cfg.ip, wml(FONTS[i], prev, next), `E:${fileOf(FONTS[i])}`);
    }
    for (const f of FONTS) assert.ok(await hasObject(cfg.ip, 'E', fileOf(f).replace('.WML', '')));
  });

  s.test('the viewer polls display.text and says that is what it shows', async () => {
    if (!original) skip('no display');
    await show(FONTS[1]);
    con = await openConsole(ctx.browser, cfg, 'lcd');
    ({ page, ui } = con);
    panel = ui.panel('lcd');
    await panel.getByText(/updated \d+\.\d+s ago/).waitFor({ timeout: 30000 });
    await waitFor(async () => /generated via display\.text/.test(await caption().textContent()), {
      what: 'the display.text caption',
      timeout: 30000,
    });
    assert.match(await screenText(), /ZTEST A\.FNT/);
  });

  for (const f of FONTS) {
    s.test(`${f.font || 'no <font> tag'}: laid out ${f.columns} columns wide`, async () => {
      if (!original) skip('no display');
      await show(f);
      const expected = `${fileOf(f)} in ${f.font || 'A.FNT'}`;
      await waitFor(async () => (await caption().textContent()).includes(expected), {
        what: `the caption to say ${expected}`,
        timeout: 20000,
      });
      // Every row of the grid is the font's width in characters.
      const rows = await screen()
        .locator('.whitespace-pre')
        .evaluateAll((n) => n.map((r) => [...r.textContent].length));
      assert.ok(rows.length > 0);
      assert.ok(
        rows.every((n) => n === f.columns),
        `rows ${JSON.stringify(rows)} should all be ${f.columns}`,
      );
      assert.match(await screenText(), /ZTEST/);
      // The printer's own text agrees: the alphabet, which starts a line
      // of its own, starts at a multiple of this many columns.
      const text = await getvar(cfg.ip, 'display.text');
      const at = text.indexOf('abc');
      if (at >= 0)
        assert.ok(at % f.columns < 3, `"abc" at ${at}, not a row start for ${f.columns}`);
      if (f.capitals) {
        const transform = await screen()
          .locator('div')
          .first()
          .evaluate((n) => getComputedStyle(n).textTransform);
        assert.equal(transform, 'uppercase', 'B.FNT has no lower case');
      }
      if (f.unknown) {
        assert.match(await caption().textContent(), /not a font this panel is known to draw/);
      }
    });
  }

  s.test('a bigger font is drawn bigger', async () => {
    if (!original) skip('no display');
    const sizeIn = async (f) => {
      await show(f);
      await waitFor(async () => (await caption().textContent()).includes(fileOf(f)), {
        what: fileOf(f),
      });
      return screen()
        .locator('div')
        .first()
        .evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
    };
    const a = await sizeIn(FONTS[1]);
    const d = await sizeIn(FONTS[3]);
    const f = await sizeIn(FONTS[5]);
    assert.ok(a < d && d < f, `font sizes A ${a}px, D ${d}px, F ${f}px`);
  });

  s.test('the soft keys press the printer’s own: P2 steps to the next menu', async () => {
    if (!original) skip('no display');
    await show(FONTS[3]); // D, whose P2 goes to E6
    await panel.getByRole('button', { name: 'Right soft key, under the screen' }).click();
    await waitFor(
      async () => (await getvar(cfg.ip, 'display.load_card')).includes(fileOf(FONTS[4])),
      {
        what: 'the printer to load the next menu',
      },
    );
    await waitFor(async () => (await caption().textContent()).includes(fileOf(FONTS[4])), {
      what: 'the viewer to follow',
    });
    await panel.getByRole('button', { name: 'Left soft key, under the screen' }).click();
    await waitFor(
      async () => (await getvar(cfg.ip, 'display.load_card')).includes(fileOf(FONTS[3])),
      {
        what: 'P1 to step back',
      },
    );
  });

  s.test('Pause stops polling; the interval can be changed', async () => {
    if (!original) skip('no display');
    await panel.getByRole('button', { name: 'Pause' }).click();
    await panel.getByText(/paused — updated/).waitFor();
    await panel.getByRole('button', { name: 'Resume' }).click();
    const every = panel.locator('label', { hasText: 'Every' }).locator('input');
    await every.fill('0.1');
    await every.dispatchEvent('change');
    assert.equal(await every.inputValue(), '0.5', 'clamped to half a second');
    await every.fill('1');
    await every.dispatchEvent('change');
  });

  s.test('with lcd_display_helper.sh running, it shows the real pixels', async () => {
    if (!original) skip('no display');
    helperDir = mkdtempSync(join(tmpdir(), 'zebra-lcd-'));
    const out = join(helperDir, 'lcd.bmp');
    helper = spawn('bash', ['lcd_display_helper.sh', cfg.ip, '--out', out], {
      cwd: ctx.root,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    helper.stderr.on('data', (d) => (stderr += d));

    await waitFor(async () => /via lcd_display_helper\.sh/.test(await caption().textContent()), {
      timeout: 45000,
      what: `the viewer to switch to the helper's frames${stderr ? ` (${stderr.trim()})` : ''}`,
    });
    const canvas = screen().locator('canvas');
    assert.equal(await canvas.getAttribute('width'), '240');
    assert.equal(await canvas.getAttribute('height'), '110');
    assert.ok(existsSync(out), 'lcd.bmp saved');
    assert.equal(readFileSync(out).subarray(0, 2).toString('latin1'), 'BM');
    // Some pixels lit: the screen has the test menu on it.
    const lit = await canvas.evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const first = [d[0], d[1], d[2]].join();
      for (let i = 0; i < d.length; i += 4)
        if ([d[i], d[i + 1], d[i + 2]].join() !== first) return true;
      return false;
    });
    assert.ok(lit, 'the frame is not blank');
  });

  s.test('stopping the helper takes its frame away, and the viewer falls back', async () => {
    if (!helper) skip('the helper did not run');
    helper.kill('SIGINT');
    await waitFor(() => helper.exitCode !== null || helper.signalCode !== null, {
      what: 'the helper to exit',
    });
    await waitFor(async () => !(await hasObject(cfg.ip, 'R', 'LCD')), {
      what: 'R:LCD.GRF to be removed',
    });
    await waitFor(async () => /display\.text/.test(await caption().textContent()), {
      timeout: 45000,
      what: 'the viewer to go back to display.text',
    });
    ui.assertNoErrors();
  });
}
