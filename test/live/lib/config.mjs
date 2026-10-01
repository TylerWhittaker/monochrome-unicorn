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
 * What the live tests need to know before they start: which printer,
 * whether they may print, and what label is loaded.
 *
 * Three sources, each overriding the one before: a JSON config file
 * (test/live/config.json, or --config), the command line, and -- when
 * run from a terminal without --yes -- questions, with whatever the
 * first two said as the defaults. Run from CI or a script, nothing is
 * asked and anything missing is an error.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { getvar } from './printer.mjs';

export const DEFAULT_CONFIG = fileURLToPath(new URL('../config.json', import.meta.url));

export const SUITES = ['app', 'settings', 'editor', 'formats', 'files', 'lcd'];

const USAGE = `usage: node test/live/run.mjs [options]

  --config <file>     JSON config (default test/live/config.json)
  --ip <address>      the printer to test against
  --password <pin>    its 4-digit password (default 1234)
  --print | --no-print   whether tests may print labels
  --label <WxH[unit]> the label loaded, e.g. 4x6, 4x6in, 101.6x152.4mm,
                      812x1218dots (default: what the printer reports)
  --no-deploy         test what the printer already serves, rather than
                      building and uploading this working tree first
  --only <a,b>        run only these suites: ${SUITES.join(', ')}
  --headed            show the browser
  --chrome <path>     the Chrome or Chromium to drive
  --yes               ask nothing; take everything from the config/flags
  -h, --help          this`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--config') args.config = next();
    else if (a === '--ip') args.ip = next();
    else if (a === '--password') args.password = next();
    else if (a === '--print') args.print = true;
    else if (a === '--no-print') args.print = false;
    else if (a === '--label') args.label = next();
    else if (a === '--no-deploy') args.deploy = false;
    else if (a === '--deploy') args.deploy = true;
    else if (a === '--only')
      args.only = next()
        .split(',')
        .map((s) => s.trim());
    else if (a === '--headed') args.headed = true;
    else if (a === '--chrome') args.chrome = next();
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown option ${a}\n\n${USAGE}`);
  }
  return args;
}

/**
 * A label size as typed, in dots. Accepts "4x6" (inches), "4x6in",
 * "101.6x152.4mm" and "812x1218dots"; a bare pair over 50 is taken as
 * dots, since nobody loads a 50-inch label.
 */
export function parseLabelSize(text, dpi) {
  const m = /^\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*(in|inch|inches|"|mm|dots?)?\s*$/i.exec(
    String(text || ''),
  );
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  let unit = (m[3] || '').toLowerCase();
  if (!unit) unit = w > 50 || h > 50 ? 'dots' : 'in';
  const perUnit = unit.startsWith('mm') ? dpi / 25.4 : unit.startsWith('dot') ? 1 : dpi;
  return { width: Math.round(w * perUnit), height: Math.round(h * perUnit) };
}

/** A size in dots, said both ways. */
export function describeSize({ width, height }, dpi) {
  const inch = (d) => (d / dpi).toFixed(2).replace(/\.?0+$/, '');
  return `${inch(width)} x ${inch(height)} in (${width} x ${height} dots at ${dpi} dpi)`;
}

async function ask(rl, question, fallback) {
  const shown = fallback === undefined || fallback === '' ? '' : ` [${fallback}]`;
  const answer = (await rl.question(`${question}${shown}: `)).trim();
  return answer || (fallback === undefined ? '' : String(fallback));
}

const yes = (text) => /^y(es)?$/i.test(String(text).trim());

/**
 * Settle the configuration, asking where allowed. Resolves with
 * { ip, password, print, label: {width, height}, dpi, deploy, only,
 *   headed, chrome, reported: {width, height} }.
 */
export async function loadConfig(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const path = args.config || DEFAULT_CONFIG;
  let file = {};
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } else if (args.config) {
    throw new Error(`No config file at ${path}`);
  }

  const cfg = {
    ip: args.ip ?? file.ip ?? '',
    password: args.password ?? file.password ?? '1234',
    print: args.print ?? file.print ?? false,
    label: args.label ?? file.label ?? '',
    deploy: args.deploy ?? file.deploy ?? true,
    only: args.only ?? file.only ?? SUITES,
    headed: args.headed ?? file.headed ?? false,
    chrome: args.chrome ?? file.chrome ?? '/usr/bin/google-chrome-stable',
  };
  for (const s of cfg.only) {
    if (!SUITES.includes(s)) throw new Error(`No suite called "${s}" (have: ${SUITES.join(', ')})`);
  }

  const interactive = process.stdin.isTTY && !args.yes;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  try {
    if (rl) cfg.ip = await ask(rl, 'Printer IP address', cfg.ip);
    if (!cfg.ip) throw new Error('No printer address: pass --ip or set "ip" in the config file');

    // What the printer says is loaded is the default answer, and what
    // the console itself will assume.
    const dpi = parseInt(await getvar(cfg.ip, 'head.resolution.in_dpi'), 10) || 203;
    const reported = {
      width: parseInt(await getvar(cfg.ip, 'ezpl.print_width'), 10) || 0,
      height: parseInt(await getvar(cfg.ip, 'zpl.label_length'), 10) || 0,
    };
    cfg.dpi = dpi;
    cfg.reported = reported;
    const reportedText = `${reported.width}x${reported.height}dots`;

    if (rl) {
      cfg.password = await ask(rl, 'Printer password', cfg.password);
      cfg.print = yes(await ask(rl, 'Print test labels? (y/n)', cfg.print ? 'y' : 'n'));
      console.log(`  The printer reports ${describeSize(reported, dpi)} loaded.`);
      cfg.label = await ask(
        rl,
        'Loaded label size, WxH in in, mm or dots',
        cfg.label || reportedText,
      );
      cfg.deploy = yes(
        await ask(rl, 'Build and deploy this working tree first? (y/n)', cfg.deploy ? 'y' : 'n'),
      );
    }

    const label = parseLabelSize(cfg.label || reportedText, dpi);
    if (!label || !label.width || !label.height) {
      throw new Error(`Cannot read the label size "${cfg.label}"; try 4x6in or 812x1218dots`);
    }
    cfg.label = label;

    if (rl && !existsSync(path)) {
      if (yes(await ask(rl, `Save these answers to ${path} for next time? (y/n)`, 'y'))) {
        const saved = {
          ip: cfg.ip,
          password: cfg.password,
          print: cfg.print,
          label: `${label.width}x${label.height}dots`,
          deploy: cfg.deploy,
        };
        writeFileSync(path, JSON.stringify(saved, null, 2) + '\n');
      }
    }
  } finally {
    if (rl) rl.close();
  }
  return cfg;
}
