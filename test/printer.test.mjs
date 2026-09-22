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

/* Parsing of the preprocessor's helper files. Run: node test/printer.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/js/printer.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { parseVarFile, decodeEntities, valuesMatch, extractPrinterError } = mod;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

check('reads framed name=value pairs', () => {
  const v = parseVarFile('@media.status=ok@\n@media.type=label@\n');
  assert.deepEqual(v, { 'media.status': 'ok', 'media.type': 'label' });
});

check('a value may span lines', () => {
  const v = parseVarFile('@device.host_status=412,0,0\n128,0,0\n0000,0@\n@appl.name=V74@\n');
  assert.equal(v['device.host_status'], '412,0,0\n128,0,0\n0000,0');
  assert.equal(v['appl.name'], 'V74');
});

check('the preprocessor’s entity escaping is undone', () => {
  // Exactly what the printer returned for device.location = A&B "q" <t> 'ap'
  const v = parseVarFile('@device.location=A&amp;B &quot;q&quot; &lt;t&gt; &apos;ap&apos;@\n');
  assert.equal(v['device.location'], 'A&B "q" <t> \'ap\'');
});

check('double-escaped text decodes only one level', () => {
  assert.equal(decodeEntities('&amp;quot;'), '&quot;');
});

check('numeric character references decode', () => {
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
});

check('an unknown entity is left alone', () => {
  assert.equal(decodeEntities('100&percnt; &bogus; ok'), '100&percnt; &bogus; ok');
});

check('significant spaces are preserved, line breaks are not', () => {
  // display.text is a fixed-width grid; its padding carries the layout.
  const row = '   PRINTER READY    ';
  const v = parseVarFile(`@display.text=${row}@\n`);
  assert.equal(v['display.text'], row);
  assert.equal(parseVarFile('@x=\nvalue\n@\n').x, 'value');
});

check('an empty value is kept', () => {
  assert.deepEqual(parseVarFile('@device.location=@\n'), { 'device.location': '' });
});

check('write verification tolerates the printer’s normalisation', () => {
  assert.ok(valuesMatch('5.0', '5'));
  assert.ok(valuesMatch('ON', 'on'));
  assert.ok(!valuesMatch('label', 'journal'));
  // The read-back of a value containing & must now compare equal.
  assert.ok(valuesMatch('A&B', 'A&B'));
});

check('printer error pages are recognised', () => {
  assert.equal(extractPrinterError('<P><B>ERROR:</B> Invalid password.</P>'), 'Invalid password.');
  assert.equal(extractPrinterError('<H3>The script save has been queued.</H3>'), null);
});

/* ---- the LCD grid ---- */

const lcdSrc = readFileSync(new URL('../src/js/lcd.js', import.meta.url), 'utf8')
  .replace(/^import [^\n]*$/gm, '');
const lcd = await import('data:text/javascript;base64,' + Buffer.from(lcdSrc).toString('base64'));

check('display.text splits into a 20x6 grid', () => {
  // Exactly what the printer returned for an idle screen.
  const screen =
    '   PRINTER READY    ' +
    '                    ' +
    '    192.168.1.81    ' +
    '                    ' +
    '                    ' +
    ' \u00c2            ABOUT ';
  const rows = lcd.gridRows(screen);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.length === 20), 'every row is 20 columns');
  assert.equal(rows[0], '   PRINTER READY    ');
  assert.equal(rows[2], '    192.168.1.81    ');
  assert.ok(rows[5].endsWith('ABOUT '));
});

check('a short or missing read still yields a full grid', () => {
  assert.deepEqual(lcd.gridRows('HI').length, 6);
  assert.equal(lcd.gridRows('HI')[0], 'HI' + ' '.repeat(18));
  assert.ok(lcd.gridRows(null).every((r) => r === ' '.repeat(20)));
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
