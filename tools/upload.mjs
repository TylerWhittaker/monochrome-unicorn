#!/usr/bin/env node
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
 * The payload is normalized to CRLF before <size> is computed, because
 * `nc -C` rewrites bare LFs on the wire and a size that disagrees with the
 * bytes actually delivered leaves a truncated file on the printer.
 *
 *   node tools/upload.mjs <printer-ip> <local-file> <E:NAME.EXT> [...more pairs]
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** CRLF-normalize and wrap a payload in a CISDFCRC16 header. */
export function buildPayload(contents, destName) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  const normalized = Buffer.from(
    data.toString('binary').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'),
    'binary'
  );
  const size = normalized.length.toString(16).toUpperCase().padStart(8, '0');
  const header = Buffer.from(`! CISDFCRC16\r\n0000\r\n${destName}\r\n${size}\r\n0000\r\n`, 'binary');
  return { payload: Buffer.concat([header, normalized]), bytes: normalized.length };
}

/** Pipe a buffer to the printer's raw port through `nc -C`. */
export function sendRaw(ip, buffer, { timeout = 120000, quiet = 3 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const nc = spawn('nc', ['-C', '-q', String(quiet), ip, '9100']);
    const errChunks = [];
    const timer = setTimeout(() => {
      nc.kill('SIGKILL');
      rejectPromise(new Error(`Timed out sending to ${ip}:9100`));
    }, timeout);

    nc.stderr.on('data', (d) => errChunks.push(d));
    nc.stdout.resume();
    nc.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Could not run nc: ${err.message}`));
    });
    nc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8').trim();
        rejectPromise(new Error(`nc exited ${code}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      resolvePromise();
    });

    nc.stdin.on('error', () => { /* printer closed early; close() reports it */ });
    nc.stdin.end(buffer);
  });
}

/** Upload one file and report the byte count actually sent. */
export async function uploadFile(ip, contents, destName, opts) {
  const { payload, bytes } = buildPayload(contents, destName);
  await sendRaw(ip, payload, opts);
  return bytes;
}

/** Remove a stored object with the ZPL ^ID command. */
export async function deleteObject(ip, destName, opts) {
  await sendRaw(ip, Buffer.from(`^XA^ID${destName}^FS^XZ\r\n`, 'binary'), opts);
}

async function main() {
  const [ip, ...rest] = process.argv.slice(2);
  if (!ip || rest.length === 0 || rest.length % 2 !== 0) {
    console.error('usage: node tools/upload.mjs <printer-ip> <local-file> <E:NAME.EXT> [...]');
    process.exit(2);
  }
  for (let i = 0; i < rest.length; i += 2) {
    const [local, dest] = [rest[i], rest[i + 1]];
    const bytes = await uploadFile(ip, readFileSync(local), dest);
    console.log(`  ${dest.padEnd(22)} ${bytes} bytes`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('upload failed:', err.message);
    process.exit(1);
  });
}
