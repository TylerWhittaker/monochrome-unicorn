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

/* The shortcut sheet's list. Run: node test/shortcuts.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// The list is plain data; the rest of the module wants a document.
const src = readFileSync(new URL('../src/js/shortcuts.js', import.meta.url), 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm,
  '',
);
const { SHORTCUTS } = await import(
  'data:text/javascript;base64,' + Buffer.from(src).toString('base64')
);

assert.ok(SHORTCUTS.length >= 2);
const seen = new Set();
for (const [where, rows] of SHORTCUTS) {
  assert.ok(where && rows.length, `${where} has entries`);
  for (const [keys, what] of rows) {
    assert.ok(keys.trim() && what.trim(), `${where}: ${keys}`);
    assert.ok(!/ \/ $|^ \/ /.test(keys), `${keys}: no empty alternative`);
    assert.ok(!seen.has(`${where}|${keys}`), `${where}: ${keys} listed once`);
    seen.add(`${where}|${keys}`);
  }
}
// What the editor does is listed.
const editor = new Map(SHORTCUTS.find(([w]) => w === 'Label Editor')[1]);
for (const keys of ['Ctrl+Z', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Arrow keys']) {
  assert.ok(editor.has(keys), `Label Editor lists ${keys}`);
}

console.log('shortcuts: all passing');
