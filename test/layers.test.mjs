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

/* The Layers panel's ordering. Run: node test/layers.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// zpl.js imports nothing, so it can be imported as it is; ui.js wants a
// browser, and is left out.
const src = readFileSync(new URL('../src/js/layers.js', import.meta.url), 'utf8')
  .replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/ui\.js';?$/m, '')
  .replace("'./zpl.js'", `'${new URL('../src/js/zpl.js', import.meta.url)}'`);
const l = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const doc = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
const ids = (list) => list.map((e) => e.id).join('');

assert.equal(ids(l.reorder(doc, ['b'], 'front')), 'acdb');
assert.equal(ids(l.reorder(doc, ['c'], 'back')), 'cabd');
assert.equal(ids(l.reorder(doc, ['a', 'c'], 'front')), 'bdac', 'keeping their own order');
assert.equal(ids(l.reorder(doc, ['b'], 'forward')), 'acbd');
assert.equal(ids(l.reorder(doc, ['d'], 'forward')), 'abcd', 'already on top');
assert.equal(ids(l.reorder(doc, ['c', 'd'], 'backward')), 'acdb');
assert.equal(ids(l.reorder(doc, ['a'], 'backward')), 'abcd', 'already at the bottom');
assert.equal(ids(l.reorder(doc, [], 'front')), 'abcd');
assert.throws(() => l.reorder(doc, ['a'], 'sideways'));
assert.equal(ids(doc), 'abcd', 'the original is left alone');

// Dropped on a row: just above it in the list, so just after it in the ZPL.
assert.equal(ids(l.moveAbove(doc, 'a', 'c')), 'bcad');
assert.equal(ids(l.moveAbove(doc, 'd', 'a')), 'adbc');
assert.equal(ids(l.moveAbove(doc, 'c', null)), 'cabd');
assert.equal(ids(l.moveAbove(doc, 'b', 'b')), 'abcd');

assert.equal(l.describeElement({ type: 'text', text: 'Hello\nworld' }), 'Text “Hello world”');
assert.equal(l.describeElement({ type: 'text', text: '0001', serial: {} }), 'Serial 0001');
assert.equal(
  l.describeElement({ type: 'barcode', symbology: 'qr', data: 'https://example.com/a/long/path' }),
  'QR Code https://example.com…',
);
assert.equal(l.describeElement({ type: 'field', number: 3, name: 'SKU' }), 'Field SKU (^FN3)');
assert.equal(l.describeElement({ type: 'ellipse', w: 40, h: 40 }), 'Circle 40 × 40');
assert.equal(l.describeElement({ type: 'line', vertical: true, length: 120 }), 'Vertical line 120');

console.log('layers: all passing');
