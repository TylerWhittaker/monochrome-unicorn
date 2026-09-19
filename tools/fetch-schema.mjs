#!/usr/bin/env node
/*
 * fetch-schema.mjs -- capture the printer's SGD catalogue at build time.
 *
 * Asks the printer for {}{"allconfig":null} on port 9100 and writes a
 * compacted schema to data/sgd-schema.json. Only the shape of each setting
 * (type, range, access, factory default) is kept -- live values come from
 * the V_*.SHTML helper files at page load, so baking them in would just
 * make the page bigger and wronger.
 *
 *   node tools/fetch-schema.mjs <printer-ip> [--out data/sgd-schema.json]
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const TYPES = ['string', 'enum', 'integer', 'bool', 'double', 'ipv4-address', 'json'];
export const ACCESS = ['R', 'W', 'RW'];

/**
 * Settings that are ruinously slow to read through the SSI preprocessor:
 * file.drive_listing walks ROM and takes ~9 s, most of the time a full
 * sweep costs. These are left out of the per-branch helper files and get
 * a single-setting file each, so the console reads them only on request.
 *
 * (file.dir is slower still at ~3 s, but the printer does not list it in
 * allconfig, so it never reaches the console and is not named here.)
 */
export const SLOW_SETTINGS = new Set(['file.drive_listing']);

/** Send a JSON config query over the raw print port and collect the reply. */
export function queryPrinter(ip, payload, { timeout = 60000, quiet = 3 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const nc = spawn('nc', ['-C', '-q', String(quiet), ip, '9100']);
    const chunks = [];
    const errChunks = [];
    const timer = setTimeout(() => {
      nc.kill('SIGKILL');
      rejectPromise(new Error(`Timed out waiting for ${ip}:9100`));
    }, timeout);

    nc.stdout.on('data', (d) => chunks.push(d));
    nc.stderr.on('data', (d) => errChunks.push(d));
    nc.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Could not run nc: ${err.message}`));
    });
    nc.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString('utf8');
      if (!out) {
        const stderr = Buffer.concat(errChunks).toString('utf8').trim();
        rejectPromise(new Error(`No response from ${ip}:9100${code ? ` (nc exit ${code})` : ''}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      resolvePromise(out);
    });

    nc.stdin.write(payload);
    nc.stdin.end();
  });
}

/** Turn the printer's allconfig reply into the compact form we inline. */
export function compactSchema(allconfig) {
  const ranges = [];
  const rangeIndex = new Map();
  const rangeId = (range) => {
    const key = range == null ? '' : String(range);
    if (!rangeIndex.has(key)) {
      rangeIndex.set(key, ranges.length);
      ranges.push(key);
    }
    return rangeIndex.get(key);
  };

  const settings = {};
  for (const [name, meta] of Object.entries(allconfig)) {
    const type = TYPES.indexOf(meta.type);
    const access = ACCESS.indexOf(meta.access);
    settings[name] = [
      type === -1 ? 0 : type,
      rangeId(meta.range),
      access === -1 ? 0 : access,
      meta.default == null ? null : String(meta.default),
    ];
  }

  const branches = [...new Set(Object.keys(settings).map((n) => n.split('.')[0]))].sort();

  return {
    captured: new Date().toISOString().slice(0, 19) + 'Z',
    types: TYPES,
    access: ACCESS,
    ranges,
    branches,
    slow: [...SLOW_SETTINGS],
    settings,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const ip = args.find((a) => !a.startsWith('--'));
  if (!ip) {
    console.error('usage: node tools/fetch-schema.mjs <printer-ip> [--out <path>]');
    process.exit(2);
  }
  const outFlag = args.indexOf('--out');
  const outPath = resolve(outFlag !== -1 ? args[outFlag + 1] : 'data/sgd-schema.json');

  process.stderr.write(`Reading SGD catalogue from ${ip} ... `);
  const raw = await queryPrinter(ip, '{}{"allconfig":null}\r\n');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Printer reply was not JSON (${raw.length} bytes). First 200 chars:\n${raw.slice(0, 200)}`);
  }
  if (!parsed.allconfig) throw new Error('Printer reply had no "allconfig" member');

  const schema = compactSchema(parsed.allconfig);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(schema, null, 1));

  const count = Object.keys(schema.settings).length;
  process.stderr.write(`${count} settings, ${schema.branches.length} branches\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('\nfetch-schema failed:', err.message);
    process.exit(1);
  });
}
