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
 * fetch-schema.mjs -- capture the printer's SGD catalogue at build time.
 *
 * Asks the printer for its settings on port 9100 and writes a compacted
 * schema to data/sgd-schema.json. Only the shape of each setting (type,
 * range, access, factory default) is kept -- live values come from the
 * V_*.SHTML helper files at page load, so baking them in would just make
 * the page bigger and wronger.
 *
 * There are two ways to ask, because there are two generations of
 * printer:
 *
 *   {}{"allconfig":null}      Link-OS (firmware V68 and later). JSON,
 *                             and complete: type, range, access and the
 *                             factory default of every setting.
 *   ! U1 getvar "allcv"       every printer, including the pre-Link-OS
 *                             ones that have no JSON channel at all.
 *                             Plain text, and much less of it: a value,
 *                             and a list of choices for some settings.
 *
 * ~HI says which generation this is, so the choice is made for you
 * unless --allcv or --allconfig says otherwise.
 *
 *   node tools/fetch-schema.mjs <printer-ip> [--out data/sgd-schema.json]
 *                              [--allcv | --allconfig]
 */

import net from 'node:net';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const TYPES = ['string', 'enum', 'integer', 'bool', 'double', 'ipv4-address', 'json'];
export const ACCESS = ['R', 'W', 'RW', 'RW?'];

/**
 * Settings that are ruinously slow to read through the SSI preprocessor:
 * file.drive_listing walks ROM and takes ~9 s, most of the time a full
 * sweep costs. These are left out of the per-branch helper files and get
 * a single-setting file each, so the console reads them only on request.
 *
 * (file.dir is slower still at ~3 s, but the printer does not list it in
 * allconfig, so it never reaches the console and is not named here.)
 */
export const SLOW_SETTINGS = new Set([
  'file.drive_listing',
  // allconfig does not list file.dir, so it only shows up on the allcv
  // path -- where it would otherwise sit in the file branch's helper and
  // add its three seconds to every sweep.
  'file.dir',
  // A netstat dump and a reboot log: both are pages of text rather than
  // settings, and nobody needs them on the way to media.darkness.
  'ip.netstat',
  'log.reboot.report',
]);

/** Firmware below this major version predates Link-OS, and has no JSON. */
export const LINK_OS_FIRMWARE = 68;

/**
 * Send something to the print port and collect what comes back.
 *
 * The printer never says it has finished: it answers and falls silent,
 * so silence is the signal. `isComplete` is what tells the two kinds of
 * silence apart -- a reply that looks finished is given `settleMs` to
 * prove otherwise, and one that does not is given the longer `idleMs`
 * before we give up waiting and take what we have.
 *
 * A socket rather than nc: nc -C rewrites bare newlines, and a settings
 * value that contains one would come back altered.
 */
export function readFromPrinter(
  ip,
  payload,
  { idleMs = 3000, settleMs = 0, isComplete = null, timeout = 180000, port = 9100 } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: ip, port });
    const chunks = [];
    let idle = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(overall);
      socket.destroy();
      const out = Buffer.concat(chunks).toString('latin1');
      if (!out) rejectPromise(new Error(`No response from ${ip}:${port}`));
      else resolvePromise(out);
    };

    const overall = setTimeout(() => {
      settled = true;
      socket.destroy();
      rejectPromise(new Error(`Timed out waiting for ${ip}:${port}`));
    }, timeout);

    const arm = () => {
      clearTimeout(idle);
      const done = isComplete && isComplete(Buffer.concat(chunks).toString('latin1'));
      idle = setTimeout(finish, done ? settleMs : idleMs);
    };

    socket.on('connect', () => {
      socket.write(payload);
      arm();
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      arm();
    });
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(overall);
      rejectPromise(new Error(`Could not reach ${ip}:${port}: ${err.message}`));
    });
    socket.on('close', finish);
  });
}

/** Kept for callers that just want a reply and a quiet period. */
export function queryPrinter(ip, payload, { timeout = 60000, quiet = 3 } = {}) {
  return readFromPrinter(ip, payload, { idleMs: quiet * 1000, timeout });
}

/*
 * Which generation of printer this is
 * ------------------------------------------------------------------
 * ~HI answers with the model, the firmware version and some sizes,
 * wrapped in STX/ETX:
 *
 *   \x02ZD500R-300dpi,V74.20.23Z,12,4096KB,CUTTER DETECTED\x03
 *
 * The version's leading number is the only part that matters here.
 */

/** Pull the firmware version out of a ~HI reply. */
export function parseHostIdentification(reply) {
  const text = String(reply)
    .replace(/[\x02\x03]/g, '')
    .trim();
  const fields = text.split(',').map((f) => f.trim());
  const version = fields.find((f) => /^V\d+/.test(f)) || null;
  const major = version ? parseInt(version.slice(1), 10) : null;
  return {
    model: fields[0] || '',
    version,
    major,
    /** Unknown firmware is treated as Link-OS: it is the safer guess. */
    preLinkOs: major !== null && major < LINK_OS_FIRMWARE,
  };
}

/** Ask the printer what it is. */
export async function identifyPrinter(ip, options = {}) {
  const reply = await readFromPrinter(ip, '~HI\r\n', { idleMs: 2000, timeout: 20000, ...options });
  return parseHostIdentification(reply);
}

/* ------------------------------------------------------------------ *
 * allcv: the catalogue a pre-Link-OS printer will give you
 *
 * A flat listing, one setting per line, in categories:
 *
 *   bluetooth.                                     <- category marker
 *   bluetooth.discoverable : off , Choices: on,off <- value and choices
 *   bluetooth.friendly_name : 40J132100037         <- value only
 *   bluetooth.clear_bonding_cache                  <- no value at all
 *   ip.netstat : Active Internet connections       <- value carries on
 *   Proto Recv-Q Send-Q  Local Address ...            over more lines
 *
 * and it ends with a line of nothing but quote characters, with no line
 * ending after it. That is not proof on its own -- a quote can be the
 * last line of a multi-line value -- so the reader waits five seconds
 * after seeing one before believing it.
 *
 * What it does not say is as important as what it does: no types, no
 * factory defaults, and no access flags. Type comes from the shape of
 * the choices; access is discussed at accessFromEntry().
 * ------------------------------------------------------------------ */

/** A setting name at the start of a line: lower case, dotted. */
const ALLCV_NAME = /^([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)(?: : (.*))?$/;

/** A category marker: a branch name and nothing else. */
const ALLCV_CATEGORY = /^[a-z][a-z0-9_]*\.$/;

/** True once the reply ends in the quote line that closes an allcv. */
export function allcvLooksComplete(text) {
  const tail = text.slice(text.lastIndexOf('\n') + 1);
  return tail.length > 0 && /^"+$/.test(tail);
}

/**
 * Ask a printer for allcv.
 *
 * Slow printers and long listings mean the idle window has to be
 * generous; the five-second settle is the rule that actually ends it.
 */
export async function fetchAllcv(ip, options = {}) {
  return readFromPrinter(ip, '! U1 getvar "allcv"\r\n', {
    idleMs: 15000,
    settleMs: 5000,
    isComplete: allcvLooksComplete,
    timeout: 300000,
    ...options,
  });
}

/**
 * What a setting's access is, as far as allcv lets anyone tell.
 *
 * A listed choice is the printer offering you something to set, so
 * those are read/write. A name with no value at all is a command --
 * clear this, run that -- so those are write-only. What is left is a
 * value with no choices, and allcv simply does not say: measured
 * against the same printer's allconfig, 195 of those were read-only and
 * 111 were writable. Calling them read-only would hide a third of the
 * settings you might want to change, so they are marked "RW?" instead:
 * editable, and labelled as unverified. A write is checked by reading
 * it back anyway, so the printer has the last word either way.
 */
export function accessFromEntry(entry) {
  if (entry.value === null) return 'W';
  if (entry.choices) return 'RW';
  return 'RW?';
}

/** The type a setting probably has, judged by the choices it offers. */
export function typeFromEntry(entry) {
  const choices = entry.choices && entry.choices.trim();
  if (!choices) return 'string';
  if (/^-?[\d.]+\s*-\s*-?[\d.]+$/.test(choices)) {
    return choices.includes('.') ? 'double' : 'integer';
  }
  const parts = choices
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 2 && parts.includes('on') && parts.includes('off')) return 'bool';
  return parts.length > 1 ? 'enum' : 'string';
}

/**
 * Parse an allcv listing into the same shape allconfig arrives in, so
 * everything downstream can stay ignorant of which printer it came from.
 *
 * Values may run over several lines, and a continuation line can look
 * like anything at all -- a netstat table, a log -- so a line only
 * starts a new setting if it begins with a dotted lower-case name at
 * column zero. Everything else belongs to the setting above it.
 */
export function parseAllcv(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const entries = new Map();
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const last = i === lines.length - 1;

    // The quote line that closes the listing, rather than a value.
    if (last && /^"+$/.test(line)) break;
    if (ALLCV_CATEGORY.test(line)) {
      current = null;
      continue;
    }

    const match = ALLCV_NAME.exec(line);
    if (match) {
      const [, name, rest] = match;
      let value = rest === undefined ? null : rest;
      let choices = null;
      if (value !== null) {
        const split = value.indexOf(' , Choices: ');
        if (split !== -1) {
          choices = value.slice(split + ' , Choices: '.length);
          value = value.slice(0, split);
        }
        value = value.replace(/\s+$/, '');
      }
      current = { name, value, choices };
      entries.set(name, current);
      continue;
    }

    if (current && current.value !== null) current.value += '\n' + line;
  }

  const config = {};
  for (const entry of entries.values()) {
    config[entry.name] = {
      type: typeFromEntry(entry),
      range: entry.choices ? entry.choices.trim() : '',
      access: accessFromEntry(entry),
      // allcv never says what a setting left the factory as, and a
      // guess here would show up as a wrong "not default" tag on rows
      // nobody has touched.
      default: null,
    };
  }
  return config;
}

/** Turn the printer's allconfig reply into the compact form we inline. */
export function compactSchema(allconfig, source = 'allconfig') {
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
    /**
     * Which command this came from. The console says so on screen when
     * it is allcv, because half the catalogue's detail is missing and a
     * blank "factory default" column would otherwise look like a bug.
     */
    source,
    types: TYPES,
    access: ACCESS,
    ranges,
    branches,
    slow: [...SLOW_SETTINGS].filter((name) => name in settings),
    settings,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const ip = args.find((a) => !a.startsWith('--'));
  if (!ip) {
    console.error(
      'usage: node tools/fetch-schema.mjs <printer-ip> [--out <path>] [--allcv|--allconfig]',
    );
    process.exit(2);
  }
  const outFlag = args.indexOf('--out');
  const outPath = resolve(outFlag !== -1 ? args[outFlag + 1] : 'data/sgd-schema.json');

  let source = args.includes('--allcv')
    ? 'allcv'
    : args.includes('--allconfig')
      ? 'allconfig'
      : null;

  if (!source) {
    process.stderr.write(`Asking ${ip} what it is ... `);
    let printer;
    try {
      printer = await identifyPrinter(ip);
    } catch (err) {
      throw new Error(
        `~HI got no answer (${err.message}). Force a format with --allcv or --allconfig.`,
      );
    }
    source = printer.preLinkOs ? 'allcv' : 'allconfig';
    process.stderr.write(
      `${printer.model || 'printer'} ${printer.version || '(no version)'}` +
        `${printer.preLinkOs ? ' -- pre-Link-OS' : ''}, using ${source}\n`,
    );
  }

  process.stderr.write(`Reading SGD catalogue from ${ip} via ${source} ... `);
  let config;

  if (source === 'allcv') {
    const raw = await fetchAllcv(ip);
    if (!allcvLooksComplete(raw)) {
      process.stderr.write(
        "\n  warning: the listing did not end with allcv's quote line; it may be short\n  ",
      );
    }
    config = parseAllcv(raw);
    if (Object.keys(config).length === 0) {
      throw new Error(`Nothing in the allcv reply looked like a setting (${raw.length} bytes)`);
    }
  } else {
    const raw = await queryPrinter(ip, '{}{"allconfig":null}\r\n');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Printer reply was not JSON (${raw.length} bytes). A pre-Link-OS printer cannot answer this; ` +
          `try --allcv. First 200 chars:\n${raw.slice(0, 200)}`,
      );
    }
    if (!parsed.allconfig) throw new Error('Printer reply had no "allconfig" member');
    config = parsed.allconfig;
  }

  const schema = compactSchema(config, source);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(schema, null, 1));

  const count = Object.keys(schema.settings).length;
  const unverified = Object.values(schema.settings).filter(
    (meta) => ACCESS[meta[2]] === 'RW?',
  ).length;
  process.stderr.write(
    `${count} settings, ${schema.branches.length} branches` +
      (unverified ? `, ${unverified} of unverified access` : '') +
      '\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('\nfetch-schema failed:', err.message);
    process.exit(1);
  });
}
