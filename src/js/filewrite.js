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
 * filewrite.js -- storing a file of any type from the browser.
 *
 * The printer's web server writes a .ZPL through its label form and
 * nothing else -- but the undocumented file.append setting, written
 * through setvars.cgi like any other, creates a file of any name and
 * appends to it ("NAME.EXT contents": the name, one space, the bytes).
 * Measured on the ZD500R (docs/printer-notes.md): byte-exact for every
 * byte but NUL, which ends the value; at most 10,468 bytes a write,
 * longer ones are cut short without a word; and it appends, so a file is
 * replaced by deleting it first. This module is the arithmetic of that:
 * the request bodies, the chunks, and what text an editor gets to edit.
 */

/** Bytes a single file.append write carries, well under the 10,468 that hold. */
export const APPEND_CHUNK = 8000;

/** Types the web server will not hand back over HTTP, so a write cannot be read back. */
export const UNSERVED_TYPES = ['NRD', 'TTF', 'TTE', 'FNT'];

/** Whether bytes can be stored this way at all: a NUL would end the file there. */
export function firstNul(bytes) {
  return bytes.indexOf(0);
}

/** Form-encode bytes exactly, one %XX per byte that needs it (not UTF-8 of each). */
export function percentEncodeBytes(bytes) {
  let out = '';
  for (const b of bytes) {
    const plain =
      (b >= 0x30 && b <= 0x39) ||
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      b === 0x2d ||
      b === 0x2e ||
      b === 0x5f ||
      b === 0x7e;
    out += plain ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * The setvars.cgi request bodies that write `bytes` to `name`
 * ("E:NAME.EXT"): one per chunk, the first creating the file. An empty
 * file is one write of the name and a space.
 */
export function appendBodies(name, bytes, chunk = APPEND_CHUNK) {
  const prefix = new TextEncoder().encode(`${name} `);
  const bodies = [];
  for (let at = 0; at < bytes.length || at === 0; at += chunk) {
    const part = bytes.subarray(at, at + chunk);
    const value = new Uint8Array(prefix.length + part.length);
    value.set(prefix, 0);
    value.set(part, prefix.length);
    bodies.push(`file.append=${percentEncodeBytes(value)}`);
    if (!bytes.length) break;
  }
  return bodies;
}

/**
 * A stored file as text to edit: UTF-8 when it is valid UTF-8, otherwise
 * one character per byte (latin1), so a .BAT's escape sequences and any
 * byte above 127 come back exactly as they went in.
 */
export function decodeForEditing(bytes) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch (err) {
    let text = '';
    for (const b of bytes) text += String.fromCharCode(b);
    return { text, encoding: 'latin1' };
  }
}

/** The bytes to store for edited text, in the encoding it was read in. */
export function encodeFromEditing(text, encoding = 'utf-8') {
  if (encoding !== 'latin1') return new TextEncoder().encode(text);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 255) {
      throw new Error(
        `“${text[i]}” cannot be stored in this file: it is not UTF-8, and keeps one byte to a character.`,
      );
    }
    bytes[i] = code;
  }
  return bytes;
}

/** Whether two byte arrays hold the same bytes. */
export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
