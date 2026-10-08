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
 * version.mjs -- the project's version number.
 *
 * package.json's "version" field is the one place it is written down.
 * Everything else asks for it: the build stamps it into the page footer,
 * and the pre-commit hook moves it on. Nothing hard-codes a version, so
 * nothing can disagree about what the version is.
 *
 *   node tools/version.mjs                 print the current version
 *   node tools/version.mjs bump patch      write the next patch version
 *   node tools/version.mjs bump minor      ... and so on
 *
 * Which of the three to bump is a judgement about the change, not
 * something a script can work out, so it is an argument. The hook
 * defaults to patch because that is the safe answer when nobody said.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = resolve(ROOT, 'package.json');

export const LEVELS = ['major', 'minor', 'patch'];

/** Split "1.2.3" into numbers, refusing anything that is not semver. */
export function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version).trim());
  if (!match) throw new Error(`"${version}" is not a MAJOR.MINOR.PATCH version`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * The next version at the given level, by semver's rules: a bump resets
 * everything below it, because 1.3.4 -> 1.4.0, not 1.4.4.
 */
export function bumpVersion(version, level) {
  if (!LEVELS.includes(level)) throw new Error(`Level must be one of ${LEVELS.join(', ')}`);
  const { major, minor, patch } = parseVersion(version);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The version as package.json currently has it. */
export function readVersion(manifestPath = MANIFEST) {
  const { version } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!version) throw new Error(`${manifestPath} has no "version" field`);
  return parseVersion(version) && version;
}

/**
 * Write a new version into package.json.
 *
 * Edited as text rather than re-serialized: JSON.stringify would reflow
 * the whole file, turning a one-line version change into a diff nobody
 * can read.
 */
export function writeVersion(next, manifestPath = MANIFEST) {
  parseVersion(next);
  const source = readFileSync(manifestPath, 'utf8');
  const updated = source.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
  if (updated === source) throw new Error(`Could not find a "version" field in ${manifestPath}`);
  writeFileSync(manifestPath, updated);
  return next;
}

function main() {
  const [command, level = 'patch'] = process.argv.slice(2);

  if (!command) {
    process.stdout.write(readVersion() + '\n');
    return;
  }
  if (command !== 'bump') {
    process.stderr.write('usage: node tools/version.mjs [bump major|minor|patch]\n');
    process.exit(2);
  }
  process.stdout.write(writeVersion(bumpVersion(readVersion(), level)) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`version: ${err.message}\n`);
    process.exit(1);
  }
}
