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

/* Language handling for stored formats. Run: node test/formats.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

async function load(name, deps = {}) {
  let src = readFileSync(new URL(`../src/js/${name}`, import.meta.url), 'utf8');
  for (const [spec, path] of Object.entries(deps)) src = src.replace(spec, path);
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
}

const zplSrc = readFileSync(new URL('../src/js/zpl.js', import.meta.url), 'utf8');
const zplUrl = 'data:text/javascript;base64,' + Buffer.from(zplSrc).toString('base64');
const f = await load('formats.js', { "'./zpl.js'": `'${zplUrl}'` });

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

check('extensions map to languages', () => {
  assert.equal(f.languageOf('ZPL').id, 'zpl');
  assert.equal(f.languageOf('EPL').id, 'epl');
  assert.equal(f.languageOf('FMT').id, 'cpcl');
  assert.equal(f.languageOf('LBL').id, 'cpcl');
  assert.equal(f.languageOf('fmt').id, 'cpcl', 'case insensitive');
  assert.equal(f.languageOf('PNG'), null);
});

check('CPCL placeholders are found in order, labelled by their command', () => {
  // The manual's SHELF.FMT example, verbatim.
  const src = [
    '! DF SHELF.FMT',
    '! 0 200 200 210 1',
    'CENTER',
    'TEXT 4 3 0 15 \\\\',
    'TEXT 4 0 0 95 \\\\',
    'BARCODE UPCA 1 1 40 0 145 \\\\',
    'TEXT 7 0 0 185 \\\\',
    'FORM',
    'PRINT',
  ].join('\r\n');
  const fields = f.parseFields(f.LANGUAGES.cpcl, src);
  assert.equal(fields.length, 4);
  assert.deepEqual(fields.map((x) => x.key), [0, 1, 2, 3]);
  assert.ok(fields[2].label.includes('BARCODE UPCA'), fields[2].label);
});

check('a CPCL recall is ! UF plus one line per placeholder', () => {
  const lang = f.LANGUAGES.cpcl;
  const fields = f.blankFields(lang, 4);
  const values = new Map([[0, '$22.99'], [1, 'SWEATSHIRT'], [2, '40123456784'], [3, '40123456784']]);
  const out = f.buildRecall(lang, { dev: 'E', oname: 'SHELF', otype: 'FMT' }, fields, values);
  assert.equal(out, '! UF SHELF.FMT\r\n$22.99\r\nSWEATSHIRT\r\n40123456784\r\n40123456784\r\n');
});

check('EPL variables carry their prompts as labels', () => {
  const src = [
    'FK"TESTFORM"', 'FS"TESTFORM"',
    'V00,15,N,"Enter Product Name:"',
    'V01,8,N,"-Enter Lot:"',
    'A50,200,0,3,1,1,N,V00',
    'FE',
  ].join('\r\n');
  const fields = f.parseFields(f.LANGUAGES.epl, src);
  assert.equal(fields.length, 2);
  assert.ok(fields[0].label.startsWith('Enter Product Name:'), fields[0].label);
  assert.ok(fields[1].label.startsWith('Enter Lot:'), 'the KDU minus flag is not part of the prompt');
  assert.equal(fields[0].maxLength, 15);
});

check('an EPL recall is FR, ?, the values, then P', () => {
  const lang = f.LANGUAGES.epl;
  const fields = f.blankFields(lang, 2);
  const values = new Map([[0, 'WIDGET'], [1, 'LOT42']]);
  const out = f.buildRecall(lang, { dev: 'E', oname: 'TESTFORM', otype: 'EPL' }, fields, values, { copies: 3 });
  assert.equal(out, 'FR"TESTFORM"\r\n?\r\nWIDGET\r\nLOT42\r\nP3\r\n');
});

check('a ZPL recall still uses ^XF and ^FN', () => {
  const lang = f.LANGUAGES.zpl;
  const fields = [{ key: 1, label: '' }, { key: 2, label: '' }];
  const values = new Map([[1, 'ACME'], [2, 'A^B']]);
  const out = f.buildRecall(lang, { dev: 'E', oname: 'SHIP', otype: 'ZPL' }, fields, values);
  assert.ok(out.includes('^XFE:SHIP.ZPL^FS'));
  assert.ok(out.includes('^FN1^FH^FDACME^FS'));
  assert.ok(out.includes('^FN2^FH^FDA_5EB^FS'), 'ZPL data is still escaped');
});

check('a format the printer cannot parse is flagged', () => {
  assert.equal(f.printerSpeaks(f.LANGUAGES.zpl, 'hybrid_xml_zpl'), true);
  assert.equal(f.printerSpeaks(f.LANGUAGES.epl, 'epl_zpl'), true);
  assert.equal(f.printerSpeaks(f.LANGUAGES.epl, 'hybrid_xml_zpl'), false);
  assert.equal(f.printerSpeaks(f.LANGUAGES.cpcl, 'hybrid_xml_zpl'), false);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
