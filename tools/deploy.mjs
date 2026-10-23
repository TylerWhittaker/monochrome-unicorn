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
 * deploy.mjs -- build the console and install it on a Zebra printer.
 *
 *   node tools/deploy.mjs <printer-ip> [options]      (or ./deploy.sh)
 *
 *     --no-schema   reuse dist/sgd-schema.json instead of re-reading the
 *                   printer's SGD catalogue (faster; use when you know the
 *                   target printer matches the captured one)
 *     --allcv       read the catalogue with `! U1 getvar "allcv"` rather
 *                   than the JSON allconfig. A printer that does not answer
 *                   the JSON question {}{"appl.name":null} -- pre-Link-OS
 *                   (firmware below V68), or with JSON turned off -- gets
 *                   allcv anyway, so this only forces it on one that does
 *     --allconfig   force the JSON catalogue, skipping the JSON question
 *     --no-upload   build only, leave the printer alone
 *     --packed      gzip the page, about 170 KB instead of 440, for a slow
 *                   link; the browser then needs DecompressionStream
 *                   (Safari 16.4, Firefox 113). The default is unpacked
 *     --no-clean    keep the helper files a previous deploy installed.
 *                   By default they (E:V_*, E:S_* and E:LCD .SHTML) are
 *                   removed before the new set goes up, so a build that
 *                   packs the settings differently leaves nothing stale
 *     --no-telemetry  do not report the deploy. A deploy that uploads
 *                   tells www.grizzlor.org when it starts and how it
 *                   ended (and at which step, if it failed), with the
 *                   printer's model, serial number and firmware and this
 *                   console's version; nothing else.
 *                   MONOCHROME_UNICORN_NO_TELEMETRY=1 does the same
 *
 * The printer is reached two ways: port 9100 for the catalogue and raw
 * file writes (CISDFCRC16 header, tools/upload.mjs), and port 80 to
 * verify what it now serves. Needs nothing but node.
 *
 * deploy() is also what the standalone installer runs (tools/installer/),
 * which carries a staged build instead of building one, and keeps the
 * catalogue and the page in memory instead of in dist/.
 */

import { randomBytes } from 'node:crypto';
import { fetchSchema, writeSchema, readFromPrinter, identifyPrinter } from './fetch-schema.mjs';
import { assemble } from './assemble.mjs';
import { sendRaw, uploadFile, deletePayload } from './upload.mjs';

export const USAGE =
  'usage: deploy <printer-ip> [--no-schema] [--no-upload] [--no-clean] [--packed] [--allcv|--allconfig] [--no-telemetry]';

/** Where a deploy is reported; see sendTelemetry(). */
export const TELEMETRY_URL =
  process.env.MONOCHROME_UNICORN_TELEMETRY_URL ||
  'https://www.grizzlor.org/monochrome-unicorn/telemetry';

/*
 * What a deploy removes before uploading. ^ID takes a wildcard, and one
 * object pattern per format; one connection carries them all. Only
 * .SHTML goes, so a user's own V_ or S_ label or graphic is left alone.
 */
export const CLEAN_PATTERNS = [
  'E:V_*.SHTML',
  'E:S_*.SHTML',
  'E:LCD.SHTML',
  'E:STATUS.SHTML',
  'E:CLOCK.SHTML',
  'E:MAINT.SHTML',
  'E:SENSOR.SHTML',
  'E:LOGS.SHTML',
];

/** The steps a deploy goes through, in order, as the installer lists them. */
export const STEPS = [
  { id: 'schema', label: "Read the printer's settings" },
  { id: 'build', label: 'Build the console' },
  { id: 'clean', label: 'Remove the old helper files' },
  { id: 'upload', label: 'Upload' },
  { id: 'verify', label: 'Check what the printer serves' },
];

/** The command line, as options for deploy(); throws USAGE when it is wrong. */
export function parseArgs(argv) {
  const opts = {
    ip: '',
    fetchSchema: true,
    upload: true,
    clean: true,
    packed: false,
    source: null,
    telemetry: !process.env.MONOCHROME_UNICORN_NO_TELEMETRY,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--no-schema') opts.fetchSchema = false;
    else if (arg === '--no-upload') opts.upload = false;
    else if (arg === '--packed') opts.packed = true;
    // The defaults now; kept so old command lines work.
    else if (arg === '--unpacked' || arg === '--clean') continue;
    else if (arg === '--no-clean') opts.clean = false;
    else if (arg === '--allcv') opts.source = 'allcv';
    else if (arg === '--allconfig') opts.source = 'allconfig';
    else if (arg === '--no-telemetry') opts.telemetry = false;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else opts.ip = arg;
  }
  if (!opts.help && !opts.ip && (opts.upload || opts.fetchSchema)) throw new Error(USAGE);
  return opts;
}

/**
 * GET a URL, as `curl -w '%{http_code} %{size_download}'` reported it.
 * The printer can take a while: it serves one request at a time.
 */
export async function probe(url, timeoutMs = 60000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: body.length, body };
}

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/**
 * What a deploy reports, from the page the printer now serves: its
 * boot-vars block has the model, serial and firmware filled in by the
 * preprocessor, HTML-escaped as it escapes every value.
 */
export function telemetryFromPage(body, version) {
  const vars = {};
  for (const m of String(body).matchAll(/^@([a-z0-9_.]+)=([^@\r\n]*)@\r?$/gm)) {
    vars[m[1]] = m[2]
      .trim()
      .replace(/&(?:([a-z]+)|#(\d+));/gi, (whole, name, dec) =>
        name ? (ENTITIES[name.toLowerCase()] ?? whole) : String.fromCodePoint(parseInt(dec, 10)),
      );
  }
  return {
    model: vars['device.product_name'] || '',
    serial: vars['device.unique_id'] || '',
    firmware: vars['appl.name'] || '',
    version,
  };
}

/** The three settings a report names the printer by, asked in one go. */
export const IDENTITY_QUERY = ['device.product_name', 'device.unique_id', 'appl.name']
  .map((name) => `! U1 getvar "${name}"\r\n`)
  .join('');

/** The answers to IDENTITY_QUERY: quoted values back to back, "?" for one not known. */
export function parseIdentity(reply) {
  const [model = '', serial = '', firmware = ''] = [...String(reply).matchAll(/"([^"]*)"/g)].map(
    (m) => (m[1] === '?' ? '' : m[1].trim()),
  );
  return { model, serial, firmware };
}

/**
 * What the printer is, for the report a deploy sends as it starts:
 * before anything is uploaded, so a deploy that then fails still says
 * which printer it failed on. A printer that will not answer the
 * getvars is asked ~HI, which any ZPL printer knows. Never throws.
 */
export async function identifyForTelemetry(ip, { port } = {}) {
  let id = { model: '', serial: '', firmware: '' };
  try {
    id = parseIdentity(
      await readFromPrinter(ip, IDENTITY_QUERY, { idleMs: 1000, timeout: 10000, port }),
    );
  } catch (err) {
    // Not there at all: the deploy will say so, with no ~HI to wait for.
    if (/^(Could not reach|Timed out)/.test(err.message)) return id;
    // Otherwise it is deaf to SGD: ~HI, and then whatever we have.
  }
  if (!id.model || !id.firmware) {
    const hi = await identifyPrinter(ip, { port, timeout: 10000 }).catch(() => null);
    if (hi) {
      id.model ||= hi.model;
      id.firmware ||= hi.version || '';
    }
  }
  return id;
}

/**
 * POST a deploy's report to the telemetry server. Never throws: a
 * deploy that worked is not failed by a server that is down. Resolves
 * to 'sent', or to why it was not.
 */
export async function sendTelemetry(report, { url = TELEMETRY_URL, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? 'sent' : `the server answered ${res.status}`;
  } catch (err) {
    return err.cause?.code || err.cause?.message || err.message;
  }
}

/**
 * Build the console for the printer at `opts.ip` and install it.
 *
 *   staged      what tools/build.mjs stage() made, or a function that
 *               makes it -- only called when a build is needed
 *   schemaPath  where to keep the catalogue (and, with --no-schema, read
 *               it); null keeps it in memory
 *   outDir      where to write the page and its helpers; null keeps them
 *               in memory
 *   emit        told of each step ({ type: 'step', id, label }) and each
 *               piece of output ({ type: 'log', text }, not always a
 *               whole line)
 *
 *   version     this console's version, for the report a deploy sends
 *               before it has built anything (staged.version otherwise)
 *
 * Resolves to { url, version, served, printer } once the printer serves
 * the page; printer is what that page says the printer is.
 *
 * Unless opts.telemetry is false, or nothing is to be uploaded, a deploy
 * reports its start, and its end: whether it worked, and if not, at
 * which step. The two share a random deploy_id, so a start with no end
 * is a deploy that never finished.
 */
export async function deploy(opts, context) {
  if (!opts.telemetry || !opts.upload) return runDeploy(opts, context);
  const log = (text) => context.emit({ type: 'log', text });
  const { staged } = context;
  const report = {
    // opts.port is for the tests' fake printer.
    ...(await identifyForTelemetry(opts.ip, { port: opts.port })),
    version: context.version ?? (typeof staged === 'function' ? '' : staged.version),
    event: 'start',
    deploy_id: randomBytes(8).toString('hex'),
  };
  const send = async (fields) => {
    const outcome = await sendTelemetry({ ...report, ...fields });
    if (outcome !== 'sent') log(`Telemetry: not sent (${outcome})\n`);
  };
  const printer = [report.model, report.serial, report.firmware].filter(Boolean).join(' ');
  log(
    `Telemetry: reporting this deploy's start and end, for ` +
      `${printer || 'a printer that did not say what it is'} (--no-telemetry to stop)\n`,
  );
  await send({});

  let current = null;
  const emit = (event) => {
    if (event.type === 'step') current = event.id;
    context.emit(event);
  };
  try {
    const result = await runDeploy(opts, { ...context, emit });
    // What the served page says fills in what the printer would not.
    const page = result.printer || {};
    await send({
      event: 'end',
      ok: true,
      model: report.model || page.model || '',
      serial: report.serial || page.serial || '',
      firmware: report.firmware || page.firmware || '',
      version: result.version,
    });
    return result;
  } catch (err) {
    await send({ event: 'end', ok: false, step: current || '' });
    throw err;
  }
}

/** deploy() without the telemetry. */
async function runDeploy(
  opts,
  { staged, schemaPath = null, outDir = null, readSchema = null, writeBuild = null, emit },
) {
  const log = (text) => emit({ type: 'log', text });
  const step = (id) => emit({ type: 'step', ...STEPS.find((s) => s.id === id) });
  const { ip } = opts;

  step('schema');
  let schema;
  if (opts.fetchSchema) {
    schema = await fetchSchema(ip, { source: opts.source, log });
    if (schemaPath) writeSchema(schema, schemaPath);
  } else {
    if (!readSchema) throw new Error('--no-schema needs a catalogue from an earlier deploy');
    log(`Using cached ${schemaPath}\n`);
    schema = readSchema(schemaPath);
  }

  step('build');
  const result = assemble({
    staged: typeof staged === 'function' ? staged() : staged,
    schema,
    packed: opts.packed,
  });
  if (outDir && writeBuild) writeBuild(result, outDir);
  log(
    `Built INDEX.SHTML, version ${result.version}: ` +
      `${(Buffer.byteLength(result.html) / 1024).toFixed(1)} KB` +
      `${result.packed ? ', packed' : ''}, and ${result.helpers.length} helper files\n`,
  );

  if (!opts.upload) {
    log('Skipping upload.\n');
    return { url: null, version: result.version, served: null };
  }

  if (opts.clean) {
    step('clean');
    log('Removing previously installed helper files...\n');
    try {
      await sendRaw(ip, deletePayload(CLEAN_PATTERNS));
      log(`  removed ${CLEAN_PATTERNS.join(' ')}\n`);
    } catch (err) {
      // As deploy.sh had it: a printer that will not take the ^ID will
      // not take the upload either, and that is the error worth showing.
      log(`  could not remove them: ${err.message}\n`);
    }
  }

  step('upload');
  log(`Uploading to ${ip} ...\n`);
  const files = [{ dest: 'E:INDEX.SHTML', contents: result.html }, ...result.helpers];
  for (const file of files) {
    const bytes = await uploadFile(ip, file.contents, file.dest);
    log(`  ${file.dest.padEnd(22)} ${bytes} bytes\n`);
  }

  step('verify');
  log('Verifying...\n');
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  const page = await probe(`http://${ip}/INDEX.SHTML`);
  log(`  http://${ip}/INDEX.SHTML -> ${page.status} ${page.bytes}\n`);
  const root = await probe(`http://${ip}/`);
  log(`  http://${ip}/            -> ${root.status} ${root.bytes}\n`);
  if (page.status !== 200) {
    throw new Error(`The printer answered ${page.status} for INDEX.SHTML after the upload`);
  }
  // The footer is plain text in a packed page too.
  const footer = /Version (\d+\.\d+\.\d+) &middot; Built/.exec(page.body.toString('latin1'));
  const served = footer ? footer[1] : null;
  if (served !== result.version) {
    log(`  but it serves version ${served || '(none found)'}, not ${result.version}\n`);
  }
  return {
    url: `http://${ip}/`,
    version: result.version,
    served,
    printer: telemetryFromPage(page.body.toString('latin1'), result.version),
  };
}

/** The CLI: print what deploy() reports, as deploy.sh always has. */
export async function runCli(argv, context) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.help) {
    console.log(context.help || USAGE);
    return 0;
  }
  try {
    const { url } = await deploy(opts, {
      ...context,
      emit: (event) => {
        if (event.type === 'log') process.stdout.write(event.text);
      },
    });
    if (url) console.log(`\nOpen ${url}`);
    return 0;
  } catch (err) {
    console.error(`\ndeploy failed: ${err.message}`);
    return 1;
  }
}

// import.meta.main where the runtime has it: bundled into the installer,
// every module shares the entry's URL, and only main.mjs is the entry.
if (import.meta.main ?? import.meta.url === `file://${process.argv[1]}`) {
  // From a checkout: build from the sources, and keep the catalogue and
  // the page in dist/ as deploy.sh always has. Imported here, by a URL a
  // bundler cannot follow, so the installer never carries the build's
  // npm half.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { stage, readSchema, writeBuild } = await import(
    new URL('build.mjs', import.meta.url).href
  );
  const { readVersion } = await import(new URL('version.mjs', import.meta.url).href);
  const outDir = resolve('dist');
  const help = readFileSync(new URL(import.meta.url), 'utf8')
    .match(/\/\*\n \* deploy\.mjs --[\s\S]*?\n \*\n([\s\S]*?) \* The printer/)[1]
    .replace(/^ \* ?/gm, '');
  process.exitCode = await runCli(process.argv.slice(2), {
    staged: () => stage({ outDir }),
    version: readVersion(),
    schemaPath: resolve(outDir, 'sgd-schema.json'),
    outDir,
    readSchema,
    writeBuild,
    help: `${USAGE}\n\n${help}`,
  });
}
