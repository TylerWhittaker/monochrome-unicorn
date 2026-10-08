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
 * The printer, reached the way the console cannot reach it: port 9100
 * for SGD reads and writes, file uploads and deletes. The live tests use
 * this to set up what the page is then asked about, and to check what
 * the page did -- a write the page reports as saved is only believed once
 * the printer, asked directly, agrees.
 */

import net from 'node:net';
import { uploadFile, deleteObject } from '../../../tools/upload.mjs';

/** Send raw bytes and collect the reply until the printer goes quiet. */
export function talk(ip, data, { quietMs = 600, timeout = 15000, until = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(9100, ip);
    const chunks = [];
    let quietTimer = null;
    const done = () => {
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      socket.destroy();
      resolve(Buffer.concat(chunks));
    };
    const hardTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No answer from ${ip}:9100 within ${timeout} ms`));
    }, timeout);
    socket.on('connect', () => {
      socket.write(data);
      quietTimer = setTimeout(done, quietMs * 3);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (until && until(Buffer.concat(chunks))) return done();
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs);
    });
    socket.on('error', (err) => {
      clearTimeout(hardTimer);
      clearTimeout(quietTimer);
      reject(new Error(`${ip}:9100: ${err.message}`));
    });
  });
}

/** One setting's value, as getvar answers it (without the quotes). */
export async function getvar(ip, name) {
  const reply = await talk(ip, `! U1 getvar "${name}"\r\n`, {
    // The answer is one quoted string; stop as soon as it closes.
    until: (buf) => /^[^"]*"[\s\S]*"\s*$/.test(buf.toString('latin1')),
  });
  const text = reply.toString('latin1');
  const match = /"([\s\S]*)"/.exec(text);
  return match ? match[1] : text.trim();
}

/** Write one setting. Nothing comes back; read it to find out. */
export async function setvar(ip, name, value) {
  await talk(ip, `! U1 setvar "${name}" "${value}"\r\n`, { quietMs: 300 });
}

/** Run a setting that is a command ("do"). */
export async function sgdDo(ip, name, value = '') {
  await talk(ip, `! U1 do "${name}" "${value}"\r\n`, { quietMs: 300 });
}

/** Store a file on the printer (CISDFCRC16), e.g. "E:TEST.BAT". */
export function storeFile(ip, contents, dest) {
  return uploadFile(ip, contents, dest);
}

/** Remove a stored object with ^ID; wildcards work ("E:ZT*.WML"). */
export function removeFile(ip, dest) {
  return deleteObject(ip, dest);
}

/** Send ZPL to be executed (not printed unless it says so). */
export async function sendZpl(ip, zpl) {
  await talk(ip, zpl.endsWith('\n') ? zpl : `${zpl}\r\n`, { quietMs: 300 });
}

/** GET a path on the printer's web server. */
export async function http(ip, path, { timeout = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`http://${ip}${path}`, { signal: ctrl.signal, cache: 'no-store' });
    return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
  } finally {
    clearTimeout(timer);
  }
}

/** The names /dir lists on a drive, e.g. ["E:LABEL.ZPL", "E:LOGO.GRF"]. */
export async function dirNames(ip, dev = 'E') {
  const { bytes } = await http(ip, `/dir?dev=${dev}&otype=${encodeURIComponent('*  ')}`);
  const html = Buffer.from(bytes).toString('latin1');
  return [...html.matchAll(/>\s*([A-Z]:[^<\s]+)\s*</g)].map((m) => m[1]);
}

/** Whether an object is on a drive, by name without the type ("E:ZTEST"). */
export async function hasObject(ip, dev, oname) {
  const names = await dirNames(ip, dev);
  return names.some((n) => n.slice(0, n.lastIndexOf('.')) === `${dev}:${oname}`);
}

/** Wait for a condition on the printer, polling. */
export async function waitFor(check, { timeout = 20000, interval = 500, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${what}` + (last instanceof Error ? `: ${last.message}` : ''),
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
