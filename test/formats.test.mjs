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
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
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
  assert.deepEqual(
    fields.map((x) => x.key),
    [0, 1, 2, 3],
  );
  assert.ok(fields[2].label.includes('BARCODE UPCA'), fields[2].label);
});

check('a CPCL recall is ! UF plus one line per placeholder', () => {
  const lang = f.LANGUAGES.cpcl;
  const fields = f.blankFields(lang, 4);
  const values = new Map([
    [0, '$22.99'],
    [1, 'SWEATSHIRT'],
    [2, '40123456784'],
    [3, '40123456784'],
  ]);
  const out = f.buildRecall(lang, { dev: 'E', oname: 'SHELF', otype: 'FMT' }, fields, values);
  assert.equal(out, '! UF SHELF.FMT\r\n$22.99\r\nSWEATSHIRT\r\n40123456784\r\n40123456784\r\n');
});

check('EPL variables carry their prompts as labels', () => {
  const src = [
    'FK"TESTFORM"',
    'FS"TESTFORM"',
    'V00,15,N,"Enter Product Name:"',
    'V01,8,N,"-Enter Lot:"',
    'A50,200,0,3,1,1,N,V00',
    'FE',
  ].join('\r\n');
  const fields = f.parseFields(f.LANGUAGES.epl, src);
  assert.equal(fields.length, 2);
  assert.ok(fields[0].label.startsWith('Enter Product Name:'), fields[0].label);
  assert.ok(
    fields[1].label.startsWith('Enter Lot:'),
    'the KDU minus flag is not part of the prompt',
  );
  assert.equal(fields[0].maxLength, 15);
});

check('an EPL recall is FR, ?, the values, then P', () => {
  const lang = f.LANGUAGES.epl;
  const fields = f.blankFields(lang, 2);
  const values = new Map([
    [0, 'WIDGET'],
    [1, 'LOT42'],
  ]);
  const out = f.buildRecall(lang, { dev: 'E', oname: 'TESTFORM', otype: 'EPL' }, fields, values, {
    copies: 3,
  });
  assert.equal(out, 'FR"TESTFORM"\r\n?\r\nWIDGET\r\nLOT42\r\nP3\r\n');
});

check('a ZPL recall still uses ^XF and ^FN', () => {
  const lang = f.LANGUAGES.zpl;
  const fields = [
    { key: 1, label: '' },
    { key: 2, label: '' },
  ];
  const values = new Map([
    [1, 'ACME'],
    [2, 'A^B'],
  ]);
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

check('copies must be a whole number from 1 to the limit', () => {
  assert.equal(f.parseCopies('3'), 3);
  assert.equal(f.parseCopies(' 12 '), 12);
  assert.equal(f.parseCopies('0'), 1);
  assert.equal(f.parseCopies('5000'), f.MAX_COPIES);
  for (const bad of ['', '2.5', '2e1', '-3', 'abc']) {
    assert.equal(f.parseCopies(bad, 7), 7, `${JSON.stringify(bad)} keeps the last count`);
  }
});

check('CSV: quoted fields, doubled quotes, line breaks inside quotes, CRLF', () => {
  const { headers, rows } = f.parseCsv(
    'NAME,CITY,SKU\r\n"Lovelace, Ada","London ""UK""",1\r\n"two\nlines",Paris,2\r\n\r\n',
  );
  assert.deepEqual(headers, ['NAME', 'CITY', 'SKU']);
  assert.deepEqual(rows, [
    ['Lovelace, Ada', 'London "UK"', '1'],
    ['two\nlines', 'Paris', '2'],
  ]);
});

check('CSV: semicolons or tabs, whichever the header line uses', () => {
  assert.deepEqual(f.parseCsv('a;b\n1;2').rows, [['1', '2']]);
  assert.deepEqual(f.parseCsv('a\tb\n1,5\t2').rows, [['1,5', '2']]);
});

check('columns match fields by ^FN name, by FN number, or else in order', () => {
  const zpl = '^XA^FO1,1^FN1"NAME"^FS^FO1,1^FN2"CITY"^FS^FO1,1^FN3^FS^XZ';
  const fields = f.parseFields(f.LANGUAGES.zpl, zpl);
  assert.deepEqual(f.matchColumns(['sku', 'City', 'name', 'FN3'], fields), { 1: 2, 2: 1, 3: 3 });
  assert.deepEqual(f.matchColumns(['x', 'y'], fields), { 1: 0, 2: 1, 3: -1 }, 'by position');
  const values = f.rowValues(['Ada', 'London'], fields, { 1: 0, 2: 1, 3: -1 });
  assert.deepEqual(
    [...values],
    [
      [1, 'Ada'],
      [2, 'London'],
      [3, ''],
    ],
  );
});

check('a field the stored format fills in is fixed, and never sent in a recall', () => {
  const zpl = '^XA^FO1,1^FN1"NAME"^FS^FO1,1^FN2"SKU"^FD12345^FS^XZ';
  const fields = f.parseFields(f.LANGUAGES.zpl, zpl);
  assert.deepEqual(
    fields.map((x) => [x.key, x.fixed]),
    [
      [1, false],
      [2, true],
    ],
  );
  const recall = f.buildRecall(
    f.LANGUAGES.zpl,
    { dev: 'E', oname: 'F', otype: 'ZPL' },
    fields,
    new Map([
      [1, 'Ada'],
      [2, 'ignored'],
    ]),
  );
  assert.match(recall, /\^FN1\^FH\^FDAda\^FS/);
  assert.doesNotMatch(recall, /\^FN2/);
  assert.deepEqual(f.matchColumns(['NAME', 'SKU'], fields), { 1: 0, 2: -1 });
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
