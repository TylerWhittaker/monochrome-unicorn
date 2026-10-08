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

/* The media sensor card's maths. Run: node test/sensor.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/js/sensor.js', import.meta.url), 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

assert.equal(m.activeSensor('gap'), 'gap');
assert.equal(m.activeSensor('WEB'), 'gap');
assert.equal(m.activeSensor('bar'), 'back_bar');
assert.equal(m.activeSensor('mark'), 'back_bar');
assert.equal(m.activeSensor('continuous'), null);
assert.equal(m.activeSensor(undefined), null);

// As measured on a ZD620 in black-mark mode.
const v = {
  'sensor.back_bar.cur': '218',
  'sensor.back_bar.thold': '175',
  'sensor.back_bar.ppr_out_thold': '10',
  'sensor.gap.cur': '?',
};
const bar = m.gaugeMarks(v, 'back_bar');
assert.ok(Math.abs(bar.reading - (218 / 255) * 100) < 1e-9);
assert.ok(Math.abs(bar.threshold - (175 / 255) * 100) < 1e-9);
assert.ok(Math.abs(bar.paperOut - (10 / 255) * 100) < 1e-9);
assert.deepEqual(m.gaugeMarks(v, 'gap'), { reading: null, threshold: null, paperOut: null });
assert.equal(m.gaugeMarks({ 'sensor.gap.cur': '300' }, 'gap').reading, 100, 'kept on the scale');

console.log('sensor: all passing');
