#!/usr/bin/env node
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

/*
 * lcd-shot.mjs -- save a picture of the printer's front panel.
 *
 * The undocumented `display.image` SGD returns the LCD framebuffer as a
 * 240x110 1-bit BMP. Three ways to ask, only one of which is any use:
 *
 *   ! U1 getvar "display.image"   the BMP wrapped in the usual quote
 *                                 delimiters -- drop the first and last
 *                                 byte and you have the file
 *   {}{"display.image":null}      the same bytes escaped into JSON
 *   getvar.cgi via the web server truncated at the BMP's first NUL byte,
 *                                 four bytes in -- unusable
 *
 * So this runs over the raw port, which is why it is a command-line tool
 * and not part of the console the printer serves.
 *
 *   node tools/lcd-shot.mjs <printer-ip> [--out lcd.png] [--bmp lcd.bmp]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/** Ask the raw port for one SGD and return every byte it sends back. */
export function getvarRaw(ip, name, { timeout = 20000, quiet = 2 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const nc = spawn('nc', ['-C', '-q', String(quiet), ip, '9100']);
    const chunks = [];
    const timer = setTimeout(() => {
      nc.kill('SIGKILL');
      rejectPromise(new Error(`Timed out waiting for ${ip}:9100`));
    }, timeout);

    nc.stdout.on('data', (d) => chunks.push(d));
    nc.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Could not run nc: ${err.message}`));
    });
    nc.on('close', () => {
      clearTimeout(timer);
      resolvePromise(Buffer.concat(chunks));
    });

    nc.stdin.end(`! U1 getvar "${name}"\r\n`);
  });
}

/**
 * Strip the quote delimiters the classic getvar wraps every reply in.
 * The BMP's own size field comes back one short of the bytes actually
 * sent -- a printer quirk, harmless, and not worth correcting.
 */
export function unwrapBmp(reply) {
  if (reply.length < 3) throw new Error(`Printer sent ${reply.length} bytes, not a bitmap`);
  const body = reply[0] === 0x22 && reply[reply.length - 1] === 0x22
    ? reply.subarray(1, -1)
    : reply;
  if (body[0] !== 0x42 || body[1] !== 0x4d) {
    throw new Error(`Expected a BMP, got ${JSON.stringify(body.subarray(0, 8).toString('latin1'))}`);
  }
  return body;
}

/** Read the parts of a 1-bit BMP this tool needs. */
export function readBmp(bmp) {
  const pixelOffset = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18);
  const height = bmp.readInt32LE(22);
  const bpp = bmp.readUInt16LE(28);
  if (bpp !== 1) throw new Error(`Expected a 1-bit bitmap, got ${bpp}-bit`);
  return { pixelOffset, width, height: Math.abs(height), topDown: height < 0, bpp };
}

function pngChunk(type, data) {
  const head = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(head) >>> 0);
  return Buffer.concat([len, head, crc]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/**
 * Convert the 1-bit BMP to a greyscale PNG. Rows in a bottom-up BMP are
 * stored last-first and padded to a four-byte boundary; a set bit is the
 * lit pixel, which on this panel is white on black.
 */
export function bmpToPng(bmp) {
  const { pixelOffset, width, height, topDown } = readBmp(bmp);
  const stride = Math.ceil(width / 32) * 4;

  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    const src = pixelOffset + srcRow * stride;
    const dst = y * (width + 1);
    raw[dst] = 0; // PNG filter: none
    for (let x = 0; x < width; x++) {
      const bit = (bmp[src + (x >> 3)] >> (7 - (x & 7))) & 1;
      raw[dst + 1 + x] = bit ? 0xff : 0x00;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // greyscale

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i]] = args[++i];
    else positional.push(args[i]);
  }
  const flag = (name) => flags[name] || null;

  const ip = positional[0];
  if (!ip) {
    console.error('usage: node tools/lcd-shot.mjs <printer-ip> [--out lcd.png] [--bmp lcd.bmp]');
    process.exit(2);
  }

  const reply = await getvarRaw(ip, 'display.image');
  const bmp = unwrapBmp(reply);
  const info = readBmp(bmp);

  const bmpPath = flag('--bmp');
  if (bmpPath) {
    writeFileSync(bmpPath, bmp);
    console.log(`${bmpPath}  ${bmp.length} bytes  ${info.width}x${info.height} 1-bit`);
  }

  const pngPath = flag('--out') || (bmpPath ? null : 'lcd.png');
  if (pngPath) {
    const png = bmpToPng(bmp);
    writeFileSync(pngPath, png);
    console.log(`${pngPath}  ${png.length} bytes  ${info.width}x${info.height}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('lcd-shot failed:', err.message);
    process.exit(1);
  });
}
