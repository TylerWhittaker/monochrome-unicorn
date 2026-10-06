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

/* Stored pictures: what a rename may call them. Run: node test/gallery.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// The pure parts; the module's other imports want a browser.
const src = readFileSync(new URL('../src/js/gallery.js', import.meta.url), 'utf8')
  .replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm, '')
  .replace(
    /^/,
    `import { objectNameFrom } from '${new URL('../src/js/imageprep.js', import.meta.url)}';\n`,
  );
const g = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const logo = { name: 'E:LOGO.GRF', dev: 'E', oname: 'LOGO', otype: 'GRF' };
const existing = [logo, { name: 'E:TAKEN.GRF', dev: 'E', oname: 'TAKEN', otype: 'GRF' }];

assert.deepEqual(g.renameTarget(logo, 'new logo', existing), {
  oname: 'NEW_LOGO',
  name: 'E:NEW_LOGO.GRF',
});
assert.equal(g.renameTarget(logo, 'a-very-long-name-indeed', []).oname.length, 16);
assert.match(g.renameTarget(logo, '  ', existing).error, /Give it a name/);
assert.match(g.renameTarget(logo, 'logo', existing).error, /already/);
assert.match(g.renameTarget(logo, 'taken', existing).error, /E:TAKEN\.GRF is already there/);
// A name on another drive, or of another type, is no clash.
assert.ok(g.renameTarget(logo, 'taken', [{ name: 'R:TAKEN.GRF' }]).name);

assert.equal(g.isPicture({ otype: 'grf' }), true);
assert.equal(g.isPicture({ otype: 'ZPL' }), false);

console.log('gallery: all passing');
