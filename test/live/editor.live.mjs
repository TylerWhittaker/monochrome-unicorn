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
 * The Label Editor, end to end: a new label at the loaded size, one of
 * every element, every property the inspector offers, the ZPL that comes
 * out, the printer's preview of it, saving, reopening, and printing when
 * allowed.
 *
 * What the editor generates is read two ways: from the source view, and
 * from the preview requests it sends the printer (lib/fixtures.mjs),
 * which carry exactly the ZPL in the label at that moment.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openConsole } from './lib/browser.mjs';
import { makePng, watchZpl } from './lib/fixtures.mjs';
import { http, getvar, hasObject, removeFile, waitFor } from './lib/printer.mjs';
import { skip } from './lib/harness.mjs';

export const name = 'Label Editor';

const LABEL = 'ZTESTLABEL';
const IMAGE = 'ZTESTIMG';

/** What each Add button puts in the ZPL, with its defaults. */
const ADDED = {
  text: /\^FO\d+,\d+\^A0N,\d+,\d+\^FH\^FDText\^FS/,
  barcode: /\^BY\d+,3,\d+\^BCN,\d+,Y,N,N\^FH\^FD12345678\^FS/,
  serial: /\^A0N,\d+,\d+\^SN0001,1,Y\^FS/,
  image: new RegExp(`\\^XGE:${IMAGE}\\.GRF,1,1\\^FS`),
  box: /\^GB\d+,\d+,3,B,0\^FS/,
  ellipse: /\^GE\d+,\d+,3,B\^FS/,
  line: /\^GB\d+,3,3,B,0\^FS/,
  field: /\^A0N,\d+,\d+\^FN1\^FS/,
  date: /\^FC%\^FH\^FD%m\/%d\/%Y\^FS/,
};

/** The command each symbology choice must produce. */
const SYMBOLOGY_ZPL = {
  code128: /\^BCN,\d+,Y,N,N\^/,
  gs1_128: /\^BCN,\d+,Y,N,N,D\^/,
  code39: /\^B3N,N,\d+,Y,N\^/,
  code93: /\^BAN,\d+,Y,N,N\^/,
  i2of5: /\^B2N,\d+,Y,N,N\^/,
  codabar: /\^BKN,N,\d+,Y,N,A,A\^/,
  ean13: /\^BEN,\d+,Y,N\^/,
  ean8: /\^B8N,\d+,Y,N\^/,
  upca: /\^BUN,\d+,Y,N\^/,
  upce: /\^B9N,\d+,Y,N\^/,
  databar: /\^BRN,1,\d+,1,\d+,22\^/,
  postnet: /\^BZN,\d+,[YN],N,0\^/,
  planet: /\^BZN,\d+,[YN],N,1\^/,
  imb: /\^BZN,\d+,[YN],N,3\^/,
  qr: /\^BQN,2,\d+\^FH\^FDQA,/,
  datamatrix: /\^BXN,\d+,200\^/,
  pdf417: /\^B7N,\d+,5,,\d+,N\^/,
  micropdf: /\^BY\d+\^BFN,\d+,0\^/,
  aztec: /\^B0N,\d+,N,0,N,1\^/,
  maxicode: /\^BD4,1,1\^/,
};

export default function register(s, ctx) {
  const { cfg } = ctx;
  let con;
  let page;
  let ui;
  let zpl;
  let panel;
  let objectCard;
  let labelCard;

  const dpi = cfg.dpi;
  const nodes = () => panel.locator('.preview-surface > div[data-id]');
  const addButton = (type) =>
    panel.locator('.toolbar', { hasText: 'Add' }).getByRole('button', { name: type, exact: true });
  const fileBar = () => panel.locator('.toolbar').nth(1);
  const viewButton = (label) => panel.locator('#view-toggle button', { hasText: label });

  /** Wait for the editor to settle, then the ZPL of its latest preview. */
  async function generated(action) {
    const since = Date.now();
    if (action) await action();
    await zpl.next('preview', { since });
    // Debounced: a burst of changes previews once, after the last.
    await page.waitForTimeout(900);
    return zpl.last('preview').data;
  }

  /** The text in the source view. */
  async function readSource() {
    await viewButton('Source').click();
    await page.waitForFunction(() => {
      const p = document.querySelector('[data-panel="editor"]');
      const ace = p.querySelector('.ace_editor');
      return (ace && ace.env && ace.env.editor) || p.querySelector('textarea');
    });
    return page.evaluate(() => {
      const p = document.querySelector('[data-panel="editor"]');
      const ace = p.querySelector('.ace_editor');
      return ace && ace.env ? ace.env.editor.getValue() : p.querySelector('textarea').value;
    });
  }

  async function writeSource(text) {
    await page.evaluate((value) => {
      const p = document.querySelector('[data-panel="editor"]');
      const ace = p.querySelector('.ace_editor');
      if (ace && ace.env) {
        ace.env.editor.setValue(value, -1);
      } else {
        const ta = p.querySelector('textarea');
        ta.value = value;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, text);
  }

  async function toVisual() {
    await viewButton('Visual').click();
    await panel
      .locator('#view-toggle button[aria-selected="true"]', { hasText: 'Visual' })
      .waitFor();
  }

  /** Select the n-th element on the canvas, as a click would. */
  async function selectNode(n) {
    await nodes().nth(n).dispatchEvent('pointerdown', { clientX: 0, clientY: 0, button: 0 });
    await nodes().nth(n).dispatchEvent('pointerup');
  }

  const field = (caption) => ui.field(objectCard, caption);

  /** Say yes to "Discard changes?" if the editor asks it. */
  async function discardIfAsked() {
    const dialog = page.locator('#modal-root .card', { hasText: 'Discard changes?' });
    await page.waitForTimeout(400);
    if (await dialog.count()) await dialog.getByRole('button', { name: 'Discard' }).click();
  }
  const labelField = (caption) => ui.field(labelCard, caption);
  const check = (scope, text) => scope.locator('label', { hasText: text }).locator('input');

  async function previewIsDrawn() {
    const status = panel.getByText('up to date');
    await status.waitFor({ timeout: 30000 });
    const img = panel.locator('img[alt="Rendered label"]');
    await img.waitFor();
    await waitFor(() => img.evaluate((n) => n.complete && n.naturalWidth > 0), {
      what: 'the preview image to load',
    });
    return img.evaluate((n) => ({ w: n.naturalWidth, h: n.naturalHeight }));
  }

  s.cleanup(() => removeFile(cfg.ip, `E:${LABEL}.ZPL`), `remove E:${LABEL}.ZPL`);
  s.cleanup(() => removeFile(cfg.ip, `E:${IMAGE}.GRF`), `remove E:${IMAGE}.GRF`);
  s.cleanup(() => con && con.close());

  s.test('a new label takes the loaded label’s size', async () => {
    con = await openConsole(ctx.browser, cfg, 'editor');
    ({ page, ui } = con);
    zpl = watchZpl(page);
    panel = ui.panel('editor');
    objectCard = page.locator('.card', { has: page.locator('h2', { hasText: 'Object options' }) });
    labelCard = page.locator('.card', { has: page.locator('h2', { hasText: 'Label options' }) });
    await labelCard.waitFor();

    const source = await readSource();
    const pw = Number(/\^PW(\d+)/.exec(source)[1]);
    const ll = Number(/\^LL(\d+)/.exec(source)[1]);
    if (cfg.reported.width)
      assert.equal(pw, cfg.reported.width, '^PW is the printer’s print width');
    if (cfg.reported.height)
      assert.equal(ll, cfg.reported.height, '^LL is the printer’s label length');
    if (pw !== cfg.label.width || ll !== cfg.label.height) {
      console.log(
        `      note: the printer is set for ${pw} x ${ll} dots but you said ${cfg.label.width} x ` +
          `${cfg.label.height} is loaded -- its media settings may want checking`,
      );
    }
    await toVisual();
    assert.match(await labelCard.textContent(), new RegExp(`${pw} × ${ll} dots at ${dpi} dpi`));
  });

  s.test('the Add bar has every element type', async () => {
    const labels = await panel
      .locator('.toolbar', { hasText: 'Add' })
      .getByRole('button')
      .allTextContents();
    assert.deepEqual(
      labels.map((t) => t.trim()),
      Object.keys(ADDED),
    );
  });

  s.test('each Add button puts its element on the canvas and its ZPL in the label', async () => {
    for (const type of Object.keys(ADDED)) {
      const before = await nodes().count();
      if (type === 'image') continue; // next test: it needs an upload
      const out = await generated(() => addButton(type).click());
      assert.equal(await nodes().count(), before + 1, `${type} on the canvas`);
      assert.match(out, ADDED[type], `${type} in the ZPL`);
    }
    ui.assertNoErrors();
  });

  s.test('an image is uploaded as a one-bit .GRF and placed with ^XG', async () => {
    await addButton('image').click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Add an image' });
    await page.waitForTimeout(800);
    if (!(await dialog.count())) {
      // The printer had images already, so the element took the first.
      await objectCard.getByRole('button', { name: 'Upload an image…' }).click();
    }
    await dialog.waitFor();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'ztestimg.png',
      mimeType: 'image/png',
      buffer: makePng(),
    });
    await dialog.locator('img[alt="One-bit preview"]:visible').waitFor();
    await dialog.locator('input[type="text"]').fill(IMAGE);
    const out = await generated(async () => {
      await dialog.getByRole('button', { name: 'Upload to printer' }).click();
      await dialog.waitFor({ state: 'detached', timeout: 120000 });
    });
    assert.match(out, ADDED.image);
    assert.ok(await hasObject(cfg.ip, 'E', IMAGE), `E:${IMAGE}.GRF on the printer`);
    // The canvas draws it from the printer, at its own size.
    const img = panel.locator(`.preview-surface img[alt="E:${IMAGE}.GRF"]`);
    await waitFor(() => img.evaluate((n) => n.complete && n.naturalWidth > 0), {
      what: 'the image on the canvas',
    });
  });

  s.test('the source view holds the same label, every element in it', async () => {
    const source = await readSource();
    for (const [type, re] of Object.entries(ADDED)) assert.match(source, re, type);
    assert.match(source, /^\^XA/);
    assert.match(source, /\^CI28/);
    assert.match(source, /\^XZ\s*$/);
    await toVisual();
    assert.equal(await nodes().count(), Object.keys(ADDED).length, 'all back on the canvas');
  });

  s.test('the printer renders the label in the preview', async () => {
    const size = await previewIsDrawn();
    assert.ok(size.w > 50 && size.h > 50, `preview is ${size.w} x ${size.h}`);
    assert.equal(await panel.getByText('rejected').count(), 0);
  });

  s.test('text properties: content, height, width, reverse, direction, wrap', async () => {
    await selectNode(0);
    await objectCard.locator('h3', { hasText: 'Text' }).waitFor();
    let out = await generated(() => ui.setField(field('Content'), 'Hello ZTEST'));
    assert.match(out, /\^FDHello ZTEST\^FS/);

    await labelCard.locator('input[type="radio"][value="dots"]').check();
    out = await generated(() => ui.setField(field('Height'), '50'));
    assert.match(out, /\^A0N,50,50\^FH\^FDHello ZTEST/);
    out = await generated(() => ui.setField(field('Char width (= height)'), '30'));
    assert.match(out, /\^A0N,50,30\^/);
    out = await generated(() => check(objectCard, 'Reverse').check());
    assert.match(out, /\^FR\^FH\^FDHello ZTEST/);
    // ^FR inverts what is under it, so the canvas blends the text by
    // difference rather than painting a black background of its own.
    const node = nodes().first();
    assert.equal(await node.evaluate((n) => getComputedStyle(n).mixBlendMode), 'difference');
    assert.equal(
      await node.evaluate((n) => getComputedStyle(n.firstElementChild).backgroundColor),
      'rgba(0, 0, 0, 0)',
      'no black box of its own',
    );
    assert.match(await objectCard.textContent(), /white across anything black/);
    out = await generated(() => ui.setField(field('Direction'), 'V'));
    assert.match(out, /\^FPV,0\^/);
    out = await generated(() => ui.setField(field('Direction'), 'H'));
    assert.doesNotMatch(out, /\^FP/);
    out = await generated(() => ui.setField(field('Wrap width'), '400'));
    assert.match(out, /\^FB400,\d+,0,L,0\^/);
    out = await generated(() => ui.setField(field('Justify'), 'C'));
    assert.match(out, /\^FB400,\d+,0,C,0\^/);
    out = await generated(() => ui.setField(field('Rotation'), 'R'));
    assert.match(out, /\^A0R,50,30\^/);
  });

  s.test('position: X and Y in dots, then in inches', async () => {
    let out = await generated(() => ui.setField(field('X'), '123'));
    assert.match(out, /\^FO123,\d+\^A0R/);
    out = await generated(() => ui.setField(field('Y'), '45'));
    assert.match(out, /\^FO123,45\^A0R/);
    await labelCard.locator('input[type="radio"][value="in"]').check();
    out = await generated(() => ui.setField(field('X'), '1'));
    assert.match(out, new RegExp(`\\^FO${dpi},45\\^A0R`), 'one inch is the printer’s dpi in dots');
    await labelCard.locator('input[type="radio"][value="dots"]').check();
    assert.equal(await field('X').inputValue(), String(dpi));
  });

  s.test('the font list offers the printer’s TrueType fonts, used with ^A@', async () => {
    const options = await field('Font')
      .locator('option')
      .evaluateAll((o) => o.map((x) => x.value));
    assert.ok(options.includes('0'), 'font 0');
    const ttf = options.find((v) => /\.TT[FE]$/i.test(v));
    if (!ttf) skip('no TrueType font stored on this printer');
    const out = await generated(() => ui.setField(field('Font'), ttf));
    assert.match(out, new RegExp(`\\^A@R,50,30,${ttf.replace('.', '\\.')}\\^`));
    await previewIsDrawn();
    await ui.setField(field('Font'), '0');
  });

  s.test('every symbology produces its command, and the printer draws each one', async () => {
    await selectNode(1);
    await objectCard.locator('h3', { hasText: 'Barcode' }).waitFor();
    const offered = await field('Symbology')
      .locator('option')
      .evaluateAll((o) => o.map((x) => x.value));
    assert.deepEqual(offered.sort(), Object.keys(SYMBOLOGY_ZPL).sort());
    for (const key of Object.keys(SYMBOLOGY_ZPL)) {
      const since = Date.now();
      const out = await generated(() => ui.setField(field('Symbology'), key));
      assert.match(out, SYMBOLOGY_ZPL[key], key);
      // The printer rejects nothing it was sent.
      await waitFor(
        async () => {
          const text = await panel.locator('.card', { hasText: 'Preview' }).first().textContent();
          return /up to date|nothing to render/.test(text) ? text : null;
        },
        { what: `${key} to render` },
      );
      assert.equal(await panel.getByText('rejected').count(), 0, `${key} rejected`);
      assert.ok(zpl.posts.some((p) => p.at >= since));
    }
    await ui.setField(field('Symbology'), 'code128');
  });

  s.test('a barcode can be a serial number, counting by any step', async () => {
    let out = await generated(() => check(objectCard, 'Serial number').check());
    assert.match(out, /\^BCN,\d+,Y,N,N\^SN12345678,1,Y\^FS/);
    out = await generated(() => ui.setField(field('Step'), '-5'));
    assert.match(out, /\^SN12345678,-5,Y\^FS/);
    out = await generated(() => check(objectCard, 'Keep leading zeros').uncheck());
    assert.match(out, /\^SN12345678,-5,N\^FS/);
    out = await generated(() => check(objectCard, 'Serial number').uncheck());
    assert.match(out, /\^FH\^FD12345678\^FS/);
  });

  s.test('barcode sizes: bar height, module width, interpretation line', async () => {
    let out = await generated(() => ui.setField(field('Bar height'), '77'));
    assert.match(out, /\^BY\d+,3,77\^BCN,77,/);
    out = await generated(() => ui.setField(field('Module width'), '4'));
    assert.match(out, /\^BY4,3,77\^/);
    out = await generated(() => check(objectCard, 'Print interpretation line').uncheck());
    assert.match(out, /\^BCN,77,N,N,N\^/);
  });

  s.test('barcode data is checked before it is sent', async () => {
    await selectNode(1);
    await objectCard.locator('h3', { hasText: 'Barcode' }).waitFor();
    await ui.setField(field('Symbology'), 'ean13');
    await ui.setField(field('Data'), '12345A');
    assert.match(await objectCard.locator('[data-check="warn"]').textContent(), /Digits only/);
    await ui.setField(field('Data'), '123456789012');
    assert.match(
      await objectCard.locator('[data-check="ok"]').textContent(),
      /The printer adds check digit 8\./,
    );
    await ui.setField(field('Data'), '1234567890125');
    assert.match(await objectCard.locator('[data-check="warn"]').textContent(), /should be 8/);
    await ui.setField(field('Symbology'), 'code128');
    await ui.setField(field('Data'), '12345678');
    assert.equal(await objectCard.locator('[data-check]').count(), 0, 'nothing to say');
  });

  s.test('the serial element counts, and its step can be set', async () => {
    await selectNode(2);
    await objectCard.locator('h3', { hasText: 'Text' }).waitFor();
    assert.equal(await field('Starting value').inputValue(), '0001');
    let out = await generated(() => ui.setField(field('Starting value'), 'LOT-0100'));
    assert.match(out, /\^SNLOT-0100,1,Y\^FS/);
    out = await generated(() => ui.setField(field('Step'), '10'));
    assert.match(out, /\^SNLOT-0100,10,Y\^FS/);
  });

  s.test('box: size, thickness, rounding, knock-out', async () => {
    await selectNode(3);
    await objectCard.locator('h3', { hasText: 'Box' }).waitFor();
    let out = await generated(() => ui.setField(field('Width'), '200'));
    out = await generated(() => ui.setField(field('Height'), '100'));
    assert.match(out, /\^GB200,100,3,B,0\^FS/);
    out = await generated(() => ui.setField(field('Line thickness'), '6'));
    out = await generated(() => ui.setField(field('Corner rounding'), '4'));
    assert.match(out, /\^GB200,100,6,B,4\^FS/);
    out = await generated(() => check(objectCard, 'White').check());
    assert.match(out, /\^GB200,100,6,W,4\^FS/);
  });

  s.test('ellipse: ^GE, and ^GC once it is a circle', async () => {
    await selectNode(4);
    await objectCard.locator('h3', { hasText: 'Ellipse' }).waitFor();
    let out = await generated(() => ui.setField(field('Width'), '150'));
    out = await generated(() => ui.setField(field('Height'), '90'));
    assert.match(out, /\^GE150,90,3,B\^FS/);
    out = await generated(() => ui.setField(field('Height'), '150'));
    assert.match(out, /\^GC150,3,B\^FS/);
  });

  s.test('line: horizontal, vertical, and diagonal both ways', async () => {
    await selectNode(5);
    await objectCard.locator('h3', { hasText: 'Line' }).waitFor();
    let out = await generated(() => ui.setField(field('Length'), '250'));
    assert.match(out, /\^GB250,3,3,B,0\^FS/);
    out = await generated(() => ui.setField(field('Direction'), 'v'));
    assert.match(out, /\^GB3,250,3,B,0\^FS/);
    out = await generated(() => ui.setField(field('Direction'), 'dR'));
    assert.match(out, /\^GD250,\d+,3,B,R\^FS/);
    out = await generated(() => ui.setField(field('Direction'), 'dL'));
    assert.match(out, /\^GD250,\d+,3,B,L\^FS/);
    out = await generated(() => ui.setField(field('Height'), '80'));
    assert.match(out, /\^GD250,80,3,B,L\^FS/);
  });

  s.test('field: number, name and fixed value', async () => {
    await selectNode(6);
    await objectCard.locator('h3', { hasText: 'Variable field' }).waitFor();
    let out = await generated(() => ui.setField(field('Field number'), '7'));
    out = await generated(() => ui.setField(field('Name'), 'ZNAME'));
    assert.match(out, /\^FN7"ZNAME"\^FS/);
    out = await generated(() => ui.setField(field('Fixed value'), 'fallback'));
    assert.match(out, /\^FN7"ZNAME"\^FH\^FDfallback\^FS/);
  });

  s.test('date: a common format, and a clock indicator of its own', async () => {
    await selectNode(7);
    await objectCard.locator('h3', { hasText: 'Date / time' }).waitFor();
    let out = await generated(() => ui.setField(field('Common formats'), '%Y-%m-%d'));
    assert.match(out, /\^FC%\^FH\^FD%Y-%m-%d\^FS/);
    out = await generated(() => ui.setField(field('Clock indicator'), '#'));
    assert.match(out, /\^FC#\^FH\^FD#Y-#m-#d\^FS/);
  });

  s.test('the label’s own settings: size, orientation, darkness, speed, media, count', async () => {
    let out = await generated(() => ui.setField(labelField('Width'), '600'));
    assert.match(out, /\^PW600\n/);
    out = await generated(() => ui.setField(labelField('Height'), '400'));
    assert.match(out, /\^LL400\n/);
    assert.match(await labelCard.textContent(), /600 × 400 dots/);
    out = await generated(() => ui.setField(labelField('Orientation'), 'I'));
    assert.match(out, /\^POI\n/);
    out = await generated(() => ui.setField(labelField('Darkness adj.'), '5'));
    assert.match(out, /\^MD5\n/);
    out = await generated(() => ui.setField(labelField('Speed'), '3'));
    assert.match(out, /\^PR3\n/);
    out = await generated(() => ui.setField(labelField('Media'), 'M'));
    assert.match(out, /\^MNM\n/);
    const count = fileBar().locator('label', { hasText: 'Count' }).locator('input');
    out = await generated(async () => {
      await count.fill('3');
      await count.dispatchEvent('change');
    });
    assert.match(out, /\^PQ3\n\^XZ/);
    await count.fill('1');
    await count.dispatchEvent('change');
    await ui.setField(labelField('Orientation'), 'N');
  });

  s.test('the preview shows the label at its own size, with even margins', async () => {
    // The printer draws on the whole media it is set for; the pane crops
    // that to the label's ^PW x ^LL (600 x 400 dots by now).
    await previewIsDrawn();
    const m = await panel.locator('img[alt="Rendered label"]').evaluate((img) => {
      const frame = img.parentElement;
      const host = frame.parentElement.getBoundingClientRect();
      const r = frame.getBoundingClientRect();
      // Clipped to what the printer drew, if that was smaller.
      const w = Math.min(600, img.naturalWidth);
      const h = Math.min(400, img.naturalHeight);
      return {
        expected: w / h,
        ratio: r.width / r.height,
        left: r.left - host.left,
        right: host.right - r.right,
        top: r.top - host.top,
        bottom: host.bottom - r.bottom,
      };
    });
    assert.ok(
      Math.abs(m.ratio - m.expected) < 0.02,
      `framed at ${m.ratio.toFixed(3)}, not ${m.expected.toFixed(3)}`,
    );
    for (const side of ['right', 'top', 'bottom']) {
      assert.ok(Math.abs(m[side] - m.left) <= 1, `margins ${JSON.stringify(m)}`);
    }
  });

  s.test('elements move by drag and by arrow key, and are duplicated and deleted', async () => {
    await selectNode(3); // the box
    const x0 = Number(await field('X').inputValue());
    // Pointer events on the box itself: by now other elements overlap
    // it, and a real mouse would pick up whichever is on top.
    const box = nodes().nth(3);
    await box.dispatchEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    for (const dx of [10, 20, 30, 40]) {
      await box.dispatchEvent('pointermove', { clientX: 100 + dx, clientY: 100, pointerId: 1 });
    }
    await box.dispatchEvent('pointerup', { clientX: 140, clientY: 100, pointerId: 1 });
    await page.waitForTimeout(300);
    const x1 = Number(await field('X').inputValue());
    assert.ok(x1 > x0, `dragged right: X ${x0} -> ${x1}`);

    await selectNode(3);
    // Arrow keys typed into the inspector are the inspector's.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await page.waitForTimeout(300);
    assert.equal(Number(await field('X').inputValue()), x1 + 1);

    const count = await nodes().count();
    await objectCard.getByRole('button', { name: 'Duplicate' }).click();
    assert.equal(await nodes().count(), count + 1);
    await objectCard.getByRole('button', { name: 'Delete' }).click();
    assert.equal(await nodes().count(), count);
  });

  s.test('with the grid on, a drag snaps to it; Alt drags freely', async () => {
    await check(panel, 'Grid').check();
    // The units are dots by now, so the grid box reads in dots.
    const pitch = Number(await panel.locator('input[title="Grid spacing"]').inputValue());
    assert.ok(pitch > 0, 'a grid pitch');
    const drag = async (dx, altKey = false) => {
      await selectNode(3); // the box
      const box = nodes().nth(3);
      const opts = { button: 0, pointerId: 1, altKey };
      await box.dispatchEvent('pointerdown', { ...opts, clientX: 200, clientY: 200 });
      await box.dispatchEvent('pointermove', { ...opts, clientX: 200 + dx, clientY: 200 + dx });
      await box.dispatchEvent('pointerup', { ...opts, clientX: 200 + dx, clientY: 200 + dx });
      await page.waitForTimeout(300);
      return [Number(await field('X').inputValue()), Number(await field('Y').inputValue())];
    };
    const [x, y] = await drag(37);
    assert.equal(x % pitch, 0, `X ${x} is on the ${pitch}-dot grid`);
    assert.equal(y % pitch, 0, `Y ${y} is on the ${pitch}-dot grid`);
    // Alt: wherever the pointer goes (a third of the pitch off, in pixels).
    const scaleNow = await panel
      .locator('.preview-surface')
      .first()
      .evaluate((n, w) => parseFloat(n.style.width) / w, 600);
    const [freeX] = await drag(Math.round((pitch / 3) * scaleNow), true);
    assert.notEqual(freeX % pitch, 0, `Alt-drag left X at ${freeX}`);
    await check(panel, 'Grid').uncheck();
  });

  s.test('undo steps back through changes, and redo forward again', async () => {
    const undo = fileBar().getByRole('button', { name: 'Undo', exact: true });
    const redo = fileBar().getByRole('button', { name: 'Redo', exact: true });
    const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
    const before = await generated(async () => {
      await selectNode(3);
      await ui.setField(field('Line thickness'), '5');
    });
    await page.waitForTimeout(500); // a new step, not part of that one

    // Three separate changes: a property, a drag, a delete.
    await ui.setField(field('Corner rounding'), '7');
    await page.waitForTimeout(500);
    const box = nodes().nth(3);
    const opts = { button: 0, pointerId: 1 };
    await box.dispatchEvent('pointerdown', { ...opts, clientX: 100, clientY: 100 });
    await box.dispatchEvent('pointermove', { ...opts, clientX: 160, clientY: 100 });
    await box.dispatchEvent('pointerup', { ...opts, clientX: 160, clientY: 100 });
    await page.waitForTimeout(500);
    const count = await nodes().count();
    await objectCard.getByRole('button', { name: 'Delete' }).click();
    assert.equal(await nodes().count(), count - 1);
    const after = await generated(() => page.waitForTimeout(100));
    assert.equal(await undo.isEnabled(), true);

    await blur();
    const back = await generated(async () => {
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(150);
      }
    });
    const differing = (x, y) => {
      const a = x.split('\n');
      const b = y.split('\n');
      return a
        .map((line, i) => (line === b[i] ? null : `${line}  ≠  ${b[i]}`))
        .filter(Boolean)
        .join('\n');
    };
    assert.equal(
      back,
      before,
      `three undos give the label before the three changes:\n${differing(back, before)}`,
    );
    assert.equal(await nodes().count(), count);
    assert.equal(await redo.isEnabled(), true);

    const forward = await generated(async () => {
      await redo.click();
      await blur();
      await page.keyboard.press('Control+Shift+z');
      await page.keyboard.press('Control+y');
    });
    assert.equal(forward, after, 'and three redos give it back');
    assert.equal(await redo.isDisabled(), true, 'nothing left to redo');
  });

  s.test('rulers, grid and zoom change only how the label is drawn', async () => {
    const top = panel.locator('canvas').first();
    const rulers = check(panel, 'Rulers');
    await rulers.check();
    assert.equal(await top.isVisible(), true, 'rulers shown');
    await rulers.uncheck();
    assert.equal(await top.isVisible(), false, 'rulers hidden');

    await check(panel, 'Grid').check();
    assert.equal(await panel.locator('.preview-surface > div.pointer-events-none').count(), 1);
    await check(panel, 'Grid').uncheck();

    await panel.locator('select', { has: page.locator('option[value="fit"]') }).selectOption('1');
    const width = await panel
      .locator('.preview-surface')
      .first()
      .evaluate((n) => n.style.width);
    assert.equal(width, '600px', 'at 100% a dot is a pixel');
    await panel.locator('select', { has: page.locator('option[value="fit"]') }).selectOption('fit');
  });

  s.test('the canvas sits centred in grey, wide window or narrow', async () => {
    const zoom = panel.locator('select', { has: page.locator('option[value="fit"]') });
    // A quarter size, so the label is narrower than its column either way.
    await zoom.selectOption('0.25');
    for (const width of [1400, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(400);
      const layout = await panel
        .locator('.preview-surface')
        .first()
        .evaluate((surface) => {
          const scroller = surface.parentElement.parentElement;
          const host = scroller.parentElement;
          const s = scroller.getBoundingClientRect();
          const h = host.getBoundingClientRect();
          return {
            left: s.left - h.left,
            right: h.right - s.right,
            hostBg: getComputedStyle(host).backgroundColor,
            scrollerBg: getComputedStyle(scroller).backgroundColor,
          };
        });
      assert.ok(layout.left > 16, `at ${width}px the label is narrower than its column`);
      assert.ok(
        Math.abs(layout.left - layout.right) <= 1,
        `centred at ${width}px: ${JSON.stringify(layout)}`,
      );
      assert.equal(layout.hostBg, layout.scrollerBg, `grey either side at ${width}px`);
    }
    await page.setViewportSize({ width: 1400, height: 1000 });
    await zoom.selectOption('fit');
  });

  let saved = '';

  s.test('Save as stores the label on the printer', async () => {
    await fileBar().getByRole('button', { name: 'Save as…' }).click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Save label as' });
    await dialog.locator('input').fill(`${LABEL}.ZPL`);
    const since = Date.now();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await ui.toast(new RegExp(`Saved E:${LABEL}\\.ZPL`), { timeout: 60000 });
    saved = (await zpl.next('save', { since })).data;
    assert.ok(await hasObject(cfg.ip, 'E', LABEL), `E:${LABEL}.ZPL on the printer`);
    const form = Buffer.from(
      (await http(cfg.ip, `/zpl?dev=E&oname=${LABEL}&otype=ZPL`)).bytes,
    ).toString('latin1');
    assert.match(form, /Hello ZTEST/, 'the stored label has the text');
    assert.equal(await panel.locator('select').first().inputValue(), `E:${LABEL}`);
  });

  s.test('New clears the canvas; opening the label brings every element back', async () => {
    const count = await nodes().count();
    await fileBar().getByRole('button', { name: 'New' }).click();
    assert.equal(await nodes().count(), 0);
    await panel.locator('select').first().selectOption(`E:${LABEL}`);
    await waitFor(async () => (await nodes().count()) === count, {
      what: `${count} elements on the reopened label`,
    });
    const source = await readSource();
    const squash = (t) => t.replace(/\s+/g, '');
    assert.equal(squash(source), squash(saved), 'reopened ZPL is what was saved');
    await toVisual();
  });

  s.test('a changed label asks before it is discarded', async () => {
    await selectNode(0);
    await ui.setField(field('Content'), 'Changed');
    await fileBar().getByRole('button', { name: 'New' }).click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Discard changes?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    assert.ok((await nodes().count()) > 0, 'kept');
    await fileBar().getByRole('button', { name: 'Save', exact: true }).click();
    await ui.toast(new RegExp(`Saved E:${LABEL}\\.ZPL`), { timeout: 60000 });
    const form = Buffer.from(
      (await http(cfg.ip, `/zpl?dev=E&oname=${LABEL}&otype=ZPL`)).bytes,
    ).toString('latin1');
    assert.match(form, /\^FDChanged/, 'Save overwrote the stored label');
  });

  /** Put the source view's cursor just inside `marker`, as a click would. */
  async function cursorInto(marker, into = 1) {
    await page.evaluate(
      ({ marker, into }) => {
        const p = document.querySelector('[data-panel="editor"]');
        const ace = p.querySelector('.ace_editor');
        if (ace && ace.env) {
          const editor = ace.env.editor;
          const at = editor.getValue().indexOf(marker) + into;
          editor.moveCursorToPosition(editor.session.doc.indexToPosition(at));
          editor.clearSelection();
        } else {
          const ta = p.querySelector('textarea');
          const at = ta.value.indexOf(marker) + into;
          ta.focus();
          ta.setSelectionRange(at, at);
          ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        }
      },
      { marker, into },
    );
  }

  s.test(
    'in the source view, the properties panel explains the command under the cursor',
    async () => {
      const heading = () => page.locator('h2', { hasText: /Object options|ZPL command/ }).first();
      assert.equal((await heading().textContent()).trim(), 'Object options');
      await readSource();
      await writeSource('^XA\n^FO10,20^A0N,30,40^FDhi^FS\n^XGE:ZLOGO.GRF,2,3^FS\n^ZQ1^XZ\n');
      assert.equal((await heading().textContent()).trim(), 'ZPL command');
      const help = page.locator('.card', { has: page.locator('h2', { hasText: 'ZPL command' }) });
      await cursorInto('^FO10,2', 7); // in y
      await help.locator('code', { hasText: /^\^FO$/ }).waitFor({ timeout: 30000 });
      assert.match(await help.textContent(), /Field Origin/);
      const active = help.locator('[data-param].bg-sky-50\\/70');
      assert.equal(await active.getAttribute('data-param'), 'y', 'the parameter under the cursor');
      assert.match(await help.locator('[data-param="x"]').textContent(), /10/);
      assert.match(await help.locator('[data-param="z"]').textContent(), /default/);

      // The highlight's blue edge, on a parameter that is not the first.
      assert.equal(
        await active.evaluate((n) => getComputedStyle(n).borderLeftColor),
        'rgb(14, 165, 233)',
      );

      await cursorInto('^A0N', 2);
      await help.locator('code', { hasText: /^\^A$/ }).waitFor();
      assert.match(await help.locator('[data-param="o"]').textContent(), /N/);
      assert.match(await help.locator('[data-param="w"]').textContent(), /40/);

      await cursorInto('^XGE', 5);
      await help.locator('code', { hasText: /^\^XG$/ }).waitFor();
      assert.match(await help.locator('[data-param="o"]').textContent(), /ZLOGO/);
      assert.match(await help.locator('[data-param="my"]').textContent(), /3/);

      await cursorInto('^ZQ', 2);
      await help.getByText('Not a command the ZPL II programming guide describes').waitFor();

      await viewButton('Visual').click();
      await page.waitForTimeout(500);
      const warn = page.locator('#modal-root .card', { hasText: 'Switch to the visual editor?' });
      if (await warn.count()) await warn.getByRole('button', { name: 'Switch anyway' }).click();
      await toVisual();
      assert.equal((await heading().textContent()).trim(), 'Object options');
    },
  );

  s.test('ZPL typed in the source view comes back to the canvas', async () => {
    await readSource();
    await writeSource('^XA\n^PW400\n^LL200\n^FO20,20^A0N,40,40^FDFrom source^FS\n^XZ\n');
    await toVisual();
    assert.equal(await nodes().count(), 1);
    assert.match(await labelCard.textContent(), /400 × 200 dots/, 'Label options follow');
  });

  s.test('switching to Visual warns about commands it cannot draw, and keeps them', async () => {
    await readSource();
    await writeSource('^XA\n^FWR\n^FO20,20^A0N,40,40^FDKeep^FS\n^XZ\n');
    const dialog = page.locator('#modal-root .card', { hasText: 'Switch to the visual editor?' });
    await viewButton('Visual').click();
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /\^FW/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(
      (await panel.locator('#view-toggle button[aria-selected="true"]').textContent()).trim(),
      'Source',
    );
    await viewButton('Visual').click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Switch anyway' }).click();
    await dialog.waitFor({ state: 'detached' });
    await toVisual();
    const out = await readSource();
    assert.match(out, /\^FWR/, 'the unmodelled command survived');
    // It is still there, so going back asks again.
    await viewButton('Visual').click();
    await dialog.getByRole('button', { name: 'Switch anyway' }).click();
    await toVisual();
  });

  s.test('a big run asks first, and Cancel prints nothing', async () => {
    const count = fileBar().locator('label', { hasText: 'Count' }).locator('input');
    await count.fill('30');
    await count.dispatchEvent('change');
    const since = Date.now();
    await fileBar().getByRole('button', { name: 'Print', exact: true }).click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Print 30 labels?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(1000);
    assert.ok(!zpl.posts.some((p) => p.action === 'print' && p.at >= since), 'nothing printed');
    await count.fill('1');
    await count.dispatchEvent('change');
  });

  s.test('Print sends the label to the printer', async () => {
    if (!cfg.print) skip('printing not enabled');
    await fileBar().getByRole('button', { name: 'New' }).click();
    await discardIfAsked();
    await labelCard.locator('input[type="radio"][value="dots"]').check();
    await ui.setField(labelField('Width'), String(cfg.label.width));
    await ui.setField(labelField('Height'), String(cfg.label.height));
    await addButton('text').click();
    await ui.setField(field('Content'), `ZTEST editor ${ctx.runId}`);
    await addButton('barcode').click();
    const odometer = Number(await getvar(cfg.ip, 'odometer.total_label_count')) || null;

    const since = Date.now();
    await fileBar().getByRole('button', { name: 'Print', exact: true }).click();
    const sent = await zpl.next('print', { since });
    assert.match(sent.data, new RegExp(`\\^PW${cfg.label.width}\\b`));
    assert.match(sent.data, new RegExp(`ZTEST editor ${ctx.runId}`));
    await panel.getByText('sent to printer').waitFor();
    await ui.toast(/Label sent to the printer/);
    if (odometer !== null) {
      await waitFor(
        async () => Number(await getvar(cfg.ip, 'odometer.total_label_count')) > odometer,
        { timeout: 30000, what: 'the label counter to go up' },
      );
    }
  });

  s.test('the unit choice is remembered across a reload', async () => {
    await labelCard.locator('input[type="radio"][value="mm"]').check();
    await page.reload();
    await labelCard.waitFor();
    assert.equal(await labelCard.locator('input[type="radio"][value="mm"]').isChecked(), true);
    await labelCard.locator('input[type="radio"][value="in"]').check();
  });

  s.test('Delete removes the stored label', async () => {
    await panel.locator('select').first().selectOption(`E:${LABEL}`);
    await discardIfAsked();
    await waitFor(async () => (await nodes().count()) > 0, { what: 'the label to open' });
    await fileBar().getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Delete label?' });
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await ui.toast(new RegExp(`Deleted E:${LABEL}\\.ZPL`));
    assert.equal(await hasObject(cfg.ip, 'E', LABEL), false);
    ui.assertNoErrors();
  });

  s.test('a .zpl from this computer opens unsaved; Download saves the label as ZPL', async () => {
    const local =
      '^XA\n^PW500\n^LL300\n^FO40,40^A0N,50,50^FDFrom disk^FS\n^FO40,120^GB200,80,4^FS\n^XZ\n';
    await panel.locator('input[data-local="open"]').setInputFiles({
      name: 'ztestlocal.zpl',
      mimeType: 'text/plain',
      buffer: Buffer.from(local),
    });
    await ui.toast(/Opened ztestlocal\.zpl/);
    assert.equal(await nodes().count(), 2);
    assert.equal(await panel.locator('select').first().inputValue(), '', 'not a stored label');
    assert.match(await labelCard.textContent(), /500 × 300 dots/);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      fileBar().getByRole('button', { name: 'Download', exact: true }).click(),
    ]);
    assert.equal(download.suggestedFilename(), 'ZTESTLOCAL.ZPL');
    const text = readFileSync(await download.path(), 'utf8');
    assert.match(text, /\^FO40,40\^A0N,50,50\^FH\^FDFrom disk\^FS/);
    assert.match(text, /\^GB200,80,4,B,0\^FS/);

    // Save suggests the file's name, as it is not on the printer yet.
    await fileBar().getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.locator('#modal-root .card', { hasText: 'Save label' });
    assert.equal(await dialog.locator('input').inputValue(), 'ZTESTLOCAL.ZPL');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  // Runs on the two-element label the test before opened from disk.
  s.test('several elements: select, align, nudge, copy, paste, undo', async () => {
    const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
    const selected = () => panel.locator('.preview-surface > div[data-id].outline-sky-500');
    assert.equal(await nodes().count(), 2);

    // Shift-click adds the second to the first.
    await selectNode(0);
    await nodes().nth(1).dispatchEvent('pointerdown', { button: 0, shiftKey: true });
    await nodes().nth(1).dispatchEvent('pointerup', { button: 0 });
    assert.equal(await selected().count(), 2);
    assert.match(await objectCard.textContent(), /2 elements selected/);
    assert.equal(await field('X').count(), 0, 'no single element’s properties');

    // Lined up along their tops: the box rises to the text's 40.
    let zplNow = await generated(() =>
      objectCard.getByRole('button', { name: 'Top', exact: true }).click(),
    );
    assert.match(zplNow, /\^FO40,40\^GB200,80,4/);
    assert.equal(await selected().count(), 2, 'still both selected');

    // An arrow moves both.
    await blur();
    zplNow = await generated(() => page.keyboard.press('ArrowRight'));
    assert.match(zplNow, /\^FO41,40\^A0N/);
    assert.match(zplNow, /\^FO41,40\^GB200,80,4/);

    // Ctrl+A, copy and paste: two more, 20 dots down and right, selected.
    await selectNode(0);
    await blur();
    await page.keyboard.press('Control+a');
    assert.equal(await selected().count(), 2);
    await page.keyboard.press('Control+c');
    await ui.toast(/Copied 2 elements/);
    zplNow = await generated(() => page.keyboard.press('Control+v'));
    assert.equal(await nodes().count(), 4);
    assert.match(zplNow, /\^FO61,60\^GB200,80,4/);
    assert.equal(await selected().count(), 2, 'the pasted pair is selected');

    // One undo takes the whole paste away.
    await blur();
    await page.keyboard.press('Control+z');
    await waitFor(async () => (await nodes().count()) === 2, { what: 'the paste undone' });

    // ZPL from anywhere else pastes as the elements it draws.
    zplNow = await generated(() =>
      page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', '^XA^FO300,200^GB50,50,50^FS^XZ');
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data }));
      }),
    );
    assert.equal(await nodes().count(), 3);
    assert.match(zplNow, /\^FO300,200\^GB50,50,50/);

    // A band dragged across the whole label selects all three.
    const surface = nodes().first().locator('..');
    const r = await surface.boundingBox();
    const at = (x, y) => ({ button: 0, pointerId: 7, clientX: x, clientY: y });
    await surface.dispatchEvent('pointerdown', at(r.x + 1, r.y + 1));
    await surface.dispatchEvent('pointermove', at(r.x + r.width / 2, r.y + r.height / 2));
    await surface.dispatchEvent('pointermove', at(r.x + r.width - 1, r.y + r.height - 1));
    await surface.dispatchEvent('pointerup', at(r.x + r.width - 1, r.y + r.height - 1));
    assert.equal(await selected().count(), 3);
    assert.match(await objectCard.textContent(), /3 elements selected/);
  });
}
