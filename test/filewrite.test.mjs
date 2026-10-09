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

/* Storing a file of any type through file.append. Run: node test/filewrite.test.mjs */
import assert from 'node:assert/strict';
import {
  APPEND_CHUNK,
  appendBodies,
  decodeForEditing,
  encodeFromEditing,
  firstNul,
  percentEncodeBytes,
  sameBytes,
} from '../src/js/filewrite.js';

const bytes = (s) => new TextEncoder().encode(s);
const decodeBody = (body) => {
  // Back to the bytes the printer receives, as a form decoder would.
  const value = body.replace(/^file\.append=/, '');
  return Uint8Array.from(
    value
      .match(/%[0-9A-F]{2}|./gs)
      .map((t) => (t[0] === '%' ? parseInt(t.slice(1), 16) : t.charCodeAt(0))),
  );
};

// Every byte but NUL survives the encoding, one byte for one byte.
const all = Uint8Array.from({ length: 255 }, (_, i) => i + 1);
assert.ok(sameBytes(decodeBody(`file.append=${percentEncodeBytes(all)}`), all));
assert.equal(percentEncodeBytes(bytes('a b+c&é')), 'a%20b%2Bc%26%C3%A9');

// One write for a small file; the name, one space, the bytes.
let bodies = appendBodies('E:NOTE.TXT', bytes('hello\r\n'));
assert.equal(bodies.length, 1);
assert.ok(sameBytes(decodeBody(bodies[0]), bytes('E:NOTE.TXT hello\r\n')));

// An empty file is still one write: the name and a space.
bodies = appendBodies('E:EMPTY.TXT', new Uint8Array(0));
assert.deepEqual(bodies, ['file.append=E%3AEMPTY.TXT%20']);

// A big one in chunks that join up exactly.
const big = Uint8Array.from({ length: APPEND_CHUNK * 2 + 5 }, (_, i) => (i % 254) + 1);
bodies = appendBodies('E:BIG.TXT', big);
assert.equal(bodies.length, 3);
const joined = bodies.map((b) => decodeBody(b).subarray('E:BIG.TXT '.length));
assert.ok(sameBytes(Uint8Array.from(joined.flatMap((p) => [...p])), big));
assert.ok(joined.every((p) => p.length <= APPEND_CHUNK));

assert.equal(firstNul(bytes('abc')), -1);
assert.equal(firstNul(Uint8Array.from([65, 0, 66])), 1);

// Editing: UTF-8 stays UTF-8; anything else keeps one byte to a character.
let d = decodeForEditing(bytes('café ✓'));
assert.deepEqual(d, { text: 'café ✓', encoding: 'utf-8' });
assert.ok(sameBytes(encodeFromEditing(d.text, d.encoding), bytes('café ✓')));
const bat = Uint8Array.from([0x1b, 0x4a, 0xe9, 0x0d, 0x0a]);
d = decodeForEditing(bat);
assert.equal(d.encoding, 'latin1');
assert.ok(sameBytes(encodeFromEditing(d.text, d.encoding), bat), 'a .BAT round-trips exactly');
assert.throws(() => encodeFromEditing('✓', 'latin1'), /one byte to a character/);

console.log('filewrite: all passing');
