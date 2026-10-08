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

/* Things the live tests hand to the page, made rather than checked in. */

import { deflateSync } from 'node:zlib';
import { waitFor } from './printer.mjs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A greyscale PNG, `ink(x, y)` true for black. The default is a black
 * frame round a checkerboard: plain enough to see survive one-bit
 * conversion, busy enough to tell from a blank.
 */
export function makePng(width = 96, height = 48, ink = null) {
  const draw =
    ink ||
    ((x, y) =>
      x < 3 || y < 3 || x >= width - 3 || y >= height - 3 || (((x >> 3) + (y >> 3)) & 1) === 0);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // no filter
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = draw(x, y) ? 0 : 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Record what the page posts to /zpl: every preview and print carries
 * the label's ZPL as `data`, which is exactly what the editor or Stored
 * Formats generated -- so this reads it without opening the source view.
 */
export function watchZpl(page) {
  const posts = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !/\/zpl$/.test(new URL(req.url()).pathname)) return;
    const form = new URLSearchParams(req.postData() || '');
    const data = form.get('data') || '';
    posts.push({
      at: Date.now(),
      data,
      // A graphic is stored by "previewing" its ~DY, which is not a label.
      action: /^~DY/.test(data)
        ? 'upload'
        : form.has('print')
          ? 'print'
          : form.has('save')
            ? 'save'
            : form.has('prev')
              ? 'preview'
              : '?',
      oname: form.get('oname'),
    });
  });
  return {
    posts,
    /** The next post of a kind after now (or after `since`). */
    async next(action = 'preview', { since = Date.now(), timeout = 20000 } = {}) {
      return waitFor(() => posts.find((p) => p.action === action && p.at >= since), {
        timeout,
        what: `a ${action} request to /zpl`,
      });
    },
    last(action = 'preview') {
      return posts.filter((p) => p.action === action).at(-1) || null;
    },
  };
}
