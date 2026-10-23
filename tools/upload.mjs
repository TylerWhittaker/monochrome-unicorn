#!/usr/bin/env node
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
 * upload.mjs -- write files into the printer's E: flash over port 9100.
 *
 * Uses the CISDFCRC16 download header (ZPL manual p. 652), which drops the
 * payload straight onto the filesystem without the ZPL formatter touching
 * it -- the only way to get an .SHTML file onto the printer:
 *
 *     ! CISDFCRC16
 *     <crc>        4 hex digits, 0000 disables the check
 *     <filename>   e.g. E:INDEX.SHTML
 *     <size>       8 hex digits, byte count of <data>
 *     <checksum>   4 hex digits, 0000 disables the check
 *     <data>
 *
 * The payload is normalized to CRLF before <size> is computed: the files
 * are stored with CRLF line ends, as they always have been, and <size>
 * must count exactly the bytes sent -- a size that disagrees with them
 * leaves a truncated file on the printer.
 *
 * Sent over a plain socket (node:net), not netcat: no tool to install,
 * and nothing rewrites the bytes on the way.
 *
 *   node tools/upload.mjs <printer-ip> <local-file> <E:NAME.EXT> [...more pairs]
 *   node tools/upload.mjs <printer-ip> --delete <E:NAME.EXT> [...]   (^ID; wildcards work)
 */

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { traceConnection } from './diag.mjs';

/** CRLF-normalize and wrap a payload in a CISDFCRC16 header. */
export function buildPayload(contents, destName) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  const normalized = Buffer.from(
    data.toString('binary').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'),
    'binary',
  );
  const size = normalized.length.toString(16).toUpperCase().padStart(8, '0');
  const header = Buffer.from(
    `! CISDFCRC16\r\n0000\r\n${destName}\r\n${size}\r\n0000\r\n`,
    'binary',
  );
  return {
    payload: Buffer.concat([header, normalized]),
    bytes: normalized.length,
    header: header.toString('binary'),
  };
}

/**
 * Send a buffer to the printer's raw port, then close our side and wait:
 * until the printer closes its own, or `quiet` seconds pass -- it keeps
 * the connection open after it has taken what it was sent, so the wait
 * is what gives it time to finish reading (as `nc -q` used to).
 *
 * `describe` is what the diagnostic log shows as sent, for a payload too
 * big to show (an upload's header, and its size).
 */
export function sendRaw(ip, buffer, { timeout = 120000, quiet = 3, port = 9100, describe } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: ip, port });
    const traced = traceConnection(`${ip}:${port}`, describe ?? buffer.toString('binary'));
    let done = false;
    let quietTimer = null;
    const finish = (err, how) => {
      if (done) return;
      done = true;
      traced.end(err ? `error: ${err.message}` : how);
      clearTimeout(overall);
      clearTimeout(quietTimer);
      socket.destroy();
      if (err) rejectPromise(err);
      else resolvePromise();
    };
    const overall = setTimeout(
      () => finish(new Error(`Timed out sending to ${ip}:${port}`)),
      timeout,
    );
    socket.on('connect', () => {
      traced.connected();
      socket.end(buffer, () => {
        quietTimer = setTimeout(() => finish(null, `quiet for ${quiet} s`), quiet * 1000);
      });
    });
    // Whatever the printer says back is not wanted, but must be read --
    // and goes in the diagnostic log, where an error message would help.
    socket.on('data', (chunk) => traced.data(chunk));
    socket.on('end', () => finish(null, 'closed by the printer'));
    socket.on('close', () => finish(null, 'closed'));
    socket.on('error', (err) => finish(new Error(`${ip}:${port}: ${err.message}`)));
  });
}

/** Upload one file and report the byte count actually sent. */
export async function uploadFile(ip, contents, destName, opts) {
  const { payload, bytes, header } = buildPayload(contents, destName);
  await sendRaw(ip, payload, { ...opts, describe: `${header}<${bytes} bytes of ${destName}>` });
  return bytes;
}

/** The ZPL that removes stored objects: one ^ID each; wildcards work. */
export function deletePayload(names) {
  return Buffer.from(names.map((name) => `^XA^ID${name}^FS^XZ\r\n`).join(''), 'binary');
}

/** Remove a stored object with the ZPL ^ID command. */
export async function deleteObject(ip, destName, opts) {
  await sendRaw(ip, deletePayload([destName]), opts);
}

async function main() {
  const [ip, ...rest] = process.argv.slice(2);
  if (ip && rest[0] === '--delete' && rest.length > 1) {
    // One connection for the lot, as deploy.sh's clean step wants.
    await sendRaw(ip, deletePayload(rest.slice(1)));
    console.log(`  removed ${rest.slice(1).join(' ')}`);
    return;
  }
  if (!ip || rest.length === 0 || rest.length % 2 !== 0) {
    console.error(
      'usage: node tools/upload.mjs <printer-ip> <local-file> <E:NAME.EXT> [...]\n' +
        '       node tools/upload.mjs <printer-ip> --delete <E:NAME.EXT> [...]',
    );
    process.exit(2);
  }
  for (let i = 0; i < rest.length; i += 2) {
    const [local, dest] = [rest[i], rest[i + 1]];
    const bytes = await uploadFile(ip, readFileSync(local), dest);
    console.log(`  ${dest.padEnd(22)} ${bytes} bytes`);
  }
}

// import.meta.main where the runtime has it: bundled into the installer,
// every module shares the entry's URL, and only main.mjs is the entry.
if (import.meta.main ?? import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('upload failed:', err.message);
    process.exit(1);
  });
}
