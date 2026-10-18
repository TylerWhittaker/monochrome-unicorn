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
 * package.mjs -- compile the standalone installer for every platform.
 *
 * Stages the build (tools/build.mjs), puts it and the installer's page in
 * dist/installer.json, and compiles tools/installer/main.mjs with
 * `bun build --compile` once per target into dist/bin/:
 *
 *   monochrome-unicorn-windows-x64.exe
 *   monochrome-unicorn-macos-arm64(.zip)   Apple silicon
 *   monochrome-unicorn-macos-x64(.zip)     Intel
 *   monochrome-unicorn-linux-x64
 *   monochrome-unicorn-linux-arm64
 *
 * The macOS ones also go in a zip, which keeps the executable bit a
 * browser download would lose; install.sh fetches the bare files, and
 * checks each against SHA256SUMS.
 *
 * Bun is only the packager -- the project is developed and tested on
 * Node -- so it is not a dependency: a `bun` on PATH is used if there is
 * one, otherwise the prebuilt @oven/bun-<platform> package (no install
 * script) is fetched once into dist/.bun.
 *
 *   node tools/installer/package.mjs [--only linux-x64,windows-x64]
 */

import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  chmodSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stage } from '../build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'dist');
const BIN = join(DIST, 'bin');

/** The Bun that compiles, when none is on PATH; a release over a month old. */
const BUN_VERSION = '1.4.2';

/*
 * The x64 builds are Bun's baseline ones, which do not need AVX2: the
 * computer next to a label printer is often an old one, and an installer
 * gains nothing from the newer instructions.
 */
export const TARGETS = [
  {
    name: 'windows-x64',
    bun: 'bun-windows-x64-baseline',
    file: 'monochrome-unicorn-windows-x64.exe',
  },
  {
    name: 'macos-arm64',
    bun: 'bun-darwin-arm64',
    file: 'monochrome-unicorn-macos-arm64',
    zip: true,
  },
  {
    name: 'macos-x64',
    bun: 'bun-darwin-x64-baseline',
    file: 'monochrome-unicorn-macos-x64',
    zip: true,
  },
  { name: 'linux-x64', bun: 'bun-linux-x64-baseline', file: 'monochrome-unicorn-linux-x64' },
  { name: 'linux-arm64', bun: 'bun-linux-arm64', file: 'monochrome-unicorn-linux-arm64' },
];

/** The target this computer runs, for the live tests. */
export function hostTarget() {
  const os = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform];
  return TARGETS.find((t) => t.name === `${os}-${process.arch}`) || null;
}

/** A bun to run: the one on PATH, or one fetched from npm into dist/.bun. */
function findBun() {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    return 'bun';
  } catch {
    // None on PATH; fetch one below.
  }
  const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
  const platform = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
  if (!arch || !platform)
    throw new Error(`No prebuilt Bun for ${process.platform}-${process.arch}`);
  const pkg = `@oven/bun-${platform}-${arch}`;
  const prefix = join(DIST, '.bun');
  const bun = join(prefix, 'node_modules', pkg, 'bin', platform === 'windows' ? 'bun.exe' : 'bun');
  if (!existsSync(bun)) {
    console.log(`Fetching ${pkg}@${BUN_VERSION} to package with ...`);
    mkdirSync(prefix, { recursive: true });
    execFileSync(
      'npm',
      ['install', '--no-save', '--no-package-lock', '--prefix', prefix, `${pkg}@${BUN_VERSION}`],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    );
  }
  return bun;
}

/** CRC-32, as zip wants it. node:zlib has one only from Node 22.2. */
export function crc32(data) {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/**
 * A zip holding one executable, by hand: Node has deflate and CRC-32 but
 * no zip writer, and one file needs only the three records below. The
 * entry is marked as made on Unix with mode 0755, which is what keeps it
 * executable when Finder or unzip unpacks it.
 */
export function zipOne(name, data, mtime = new Date()) {
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');
  const dosTime = (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1);
  const dosDate =
    ((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate();

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 name
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38); // regular file, rwxr-xr-x
  central.writeUInt32LE(0, 42); // offset of the local header

  const centralOffset = local.length + nameBuf.length + compressed.length;
  const centralSize = central.length + nameBuf.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBuf, compressed, central, nameBuf, end]);
}

function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.indexOf('--only');
  const only = onlyArg === -1 ? null : args[onlyArg + 1].split(',');
  const targets = only ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;
  if (targets.length === 0) throw new Error(`No target called ${only.join(', ')}`);

  const staged = stage({ outDir: DIST });
  const page = readFileSync(join(ROOT, 'tools/installer/gui.html'), 'utf8');
  writeFileSync(join(DIST, 'installer.json'), JSON.stringify({ staged, page }));
  console.log(`Staged version ${staged.version} into dist/installer.json`);

  const bun = findBun();
  if (existsSync(BIN)) rmSync(BIN, { recursive: true });
  mkdirSync(BIN, { recursive: true });

  for (const target of targets) {
    const out = join(BIN, target.file);
    execFileSync(
      bun,
      [
        'build',
        '--compile',
        `--target=${target.bun}`,
        '--minify-syntax',
        join(ROOT, 'tools/installer/main.mjs'),
        '--outfile',
        out,
      ],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    if (!target.file.endsWith('.exe')) chmodSync(out, 0o755);
    let line = `  ${target.file.padEnd(36)} ${(statSync(out).size / 1048576).toFixed(1)} MB`;
    if (target.zip) {
      const zip = zipOne(target.file, readFileSync(out));
      writeFileSync(`${out}.zip`, zip);
      line += `, zipped ${(zip.length / 1048576).toFixed(1)} MB`;
    }
    console.log(line);
  }

  // What install.sh and install.ps1 check a download against.
  const sums = readdirSync(BIN)
    .filter((f) => f.startsWith('monochrome-unicorn-'))
    .sort()
    .map(
      (f) =>
        `${createHash('sha256')
          .update(readFileSync(join(BIN, f)))
          .digest('hex')}  ${f}`,
    );
  writeFileSync(join(BIN, 'SHA256SUMS'), sums.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error('package failed:', err.message);
    process.exit(1);
  }
}
