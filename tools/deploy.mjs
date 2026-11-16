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
 *     Give several addresses to install on each in turn, or a range to
 *     scan for Zebra printers and install on those it finds:
 *     192.168.1.0/24 (or /255.255.255.0), 192.168.1.10-50, a range in any
 *     of the four numbers (192.168.1-2.1-254), or a list (192.168.1.5,7).
 *     A scan lists what it found and asks before installing
 *
 *     --discover    list the Zebra printers on this computer's networks
 *                   (Zebra's discovery broadcast, UDP port 4201), and stop
 *     --yes         install on what a range scan found without asking
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
 *     --enable-http  if the printer's web server is turned off
 *                   (ip.http.enable, off from the factory on some newer
 *                   firmware), turn it on and restart the printer
 *                   without asking. In a terminal it asks; otherwise a
 *                   deploy to such a printer stops before uploading
 *     --no-telemetry  do not report the deploy. A deploy that uploads
 *                   tells www.grizzlor.org when it starts and how it
 *                   ended (and at which step, if it failed), with the
 *                   printer's model, serial number and firmware and this
 *                   console's version; nothing else.
 *                   MONOCHROME_UNICORN_NO_TELEMETRY=1 does the same
 *     --send-log    if the deploy fails, send its diagnostic log without
 *                   asking. A failed deploy always writes one (dist/,
 *                   deploy-failed-*.log): every exchange with the printer,
 *                   with passwords and keys taken out. In a terminal it
 *                   asks whether to send it; otherwise it says how
 *     --send-log-file <file>  send a diagnostic log a failed deploy wrote
 *
 * The printer is reached two ways: port 9100 for the catalogue and raw
 * file writes (CISDFCRC16 header, tools/upload.mjs), and port 80 to
 * check that its web server answers before anything is uploaded, and to
 * verify what it then serves. Needs nothing but node.
 *
 * deploy() is also what the standalone installer runs (tools/installer/),
 * which carries a staged build instead of building one, and keeps the
 * catalogue and the page in memory instead of in dist/.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startTrace,
  stopTrace,
  trace,
  formatTrace,
  capText,
  failureCause,
  tracedReplies,
} from './diag.mjs';
import { fetchSchema, writeSchema, readFromPrinter, identifyPrinter } from './fetch-schema.mjs';
import { assemble } from './assemble.mjs';
import { sendRaw, uploadFile, deletePayload } from './upload.mjs';
import { discoverPrinters, scanRange, parseRange, isRange } from './discover.mjs';

export const USAGE =
  'usage: deploy <printer-ip|range>... [--yes] [--no-schema] [--no-upload] [--no-clean] [--packed] [--allcv|--allconfig] [--enable-http] [--no-telemetry] [--send-log]\n' +
  '       deploy --discover\n' +
  '       deploy --send-log-file <file>';

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
  { id: 'web', label: "Check the printer's web server" },
  { id: 'build', label: 'Build the console' },
  { id: 'clean', label: 'Remove the old helper files' },
  { id: 'upload', label: 'Upload' },
  { id: 'verify', label: 'Check what the printer serves' },
];

/** The command line, as options for deploy(); throws USAGE when it is wrong. */
export function parseArgs(argv) {
  const opts = {
    ip: '',
    targets: [],
    fetchSchema: true,
    upload: true,
    clean: true,
    packed: false,
    source: null,
    telemetry: !process.env.MONOCHROME_UNICORN_NO_TELEMETRY,
    sendLog: false,
    sendLogFile: null,
    discover: false,
    yes: false,
    enableHttp: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-schema') opts.fetchSchema = false;
    else if (arg === '--no-upload') opts.upload = false;
    else if (arg === '--packed') opts.packed = true;
    // The defaults now; kept so old command lines work.
    else if (arg === '--unpacked' || arg === '--clean') continue;
    else if (arg === '--no-clean') opts.clean = false;
    else if (arg === '--allcv') opts.source = 'allcv';
    else if (arg === '--allconfig') opts.source = 'allconfig';
    else if (arg === '--no-telemetry') opts.telemetry = false;
    else if (arg === '--send-log') opts.sendLog = true;
    else if (arg === '--discover') opts.discover = true;
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--enable-http') opts.enableHttp = true;
    else if (arg === '--send-log-file') {
      opts.sendLogFile = argv[++i];
      if (!opts.sendLogFile) throw new Error('--send-log-file needs the log to send');
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else opts.targets.push(arg);
  }
  opts.ip = opts.targets[0] || '';
  const asked = opts.help || opts.sendLogFile || opts.discover;
  if (!asked && !opts.ip && (opts.upload || opts.fetchSchema)) {
    throw new Error(USAGE);
  }
  if (!opts.fetchSchema && (opts.targets.length > 1 || opts.targets.some(isRange))) {
    throw new Error("--no-schema reuses one printer's catalogue, so it takes one printer");
  }
  return opts;
}

/**
 * GET a URL, as `curl -w '%{http_code} %{size_download}'` reported it.
 * The printer can take a while: it serves one request at a time.
 */
export async function probe(url, timeoutMs = 60000) {
  const started = Date.now();
  let res, body;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    trace('http', { url, error: err.cause?.code || err.cause?.message || err.message });
    throw err;
  }
  trace('http', {
    url,
    status: res.status,
    bytes: body.length,
    elapsed: Date.now() - started,
    headers: [...res.headers],
    head: body.subarray(0, 2048).toString('latin1'),
  });
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
 *
 * Every exchange with the printer is traced (diag.mjs). A deploy that
 * fails throws with the trace as text on the error, err.diagnosticLog,
 * and its id as err.deployId -- the same as telemetry's -- for
 * sendDiagnosticLog(); one that works keeps nothing.
 */
export async function deploy(opts, context) {
  const deployId = randomBytes(8).toString('hex');
  const { staged } = context;
  const version = context.version ?? (typeof staged === 'function' ? '' : staged.version);
  const { ip, port, ...options } = opts;
  startTrace({
    version,
    deploy_id: deployId,
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
    os: `${process.platform} ${process.arch}`,
    options,
  });
  let current = null;
  const emit = (event) => {
    if (event.type === 'step') {
      current = event.id;
      trace('step', { id: event.id });
    } else if (event.type === 'log') trace('log', { text: event.text });
    context.emit(event);
  };
  try {
    return await reportedDeploy(
      opts,
      { ...context, emit },
      { deployId, version, step: () => current },
    );
  } catch (err) {
    err.deployId = deployId;
    const cause = causeOf(err);
    err.diagnosticLog = formatTrace(stopTrace(), { error: err, step: current, cause });
    throw err;
  } finally {
    stopTrace();
  }
}

/**
 * Why a deploy failed, as one of diag.mjs's CAUSES codes: worked out
 * once, while the trace is still being recorded, and kept on the error.
 */
function causeOf(err) {
  err.failureCause ??= failureCause(err, tracedReplies());
  return err.failureCause;
}

/** deploy(), with its start and end reported. */
async function reportedDeploy(opts, context, { deployId, version, step }) {
  if (!opts.telemetry || !opts.upload) return runDeploy(opts, context);
  const log = (text) => context.emit({ type: 'log', text });
  const report = {
    // opts.port is for the tests' fake printer.
    ...(await identifyForTelemetry(opts.ip, { port: opts.port })),
    version,
    event: 'start',
    deploy_id: deployId,
  };
  const send = async (fields) => {
    let outcome = await sendTelemetry({ ...report, ...fields });
    // A server from before 0.56 refuses a field it does not know.
    if (outcome === 'the server answered 422' && fields.cause) {
      const { cause, ...older } = fields;
      outcome = await sendTelemetry({ ...report, ...older });
    }
    if (outcome !== 'sent') log(`Telemetry: not sent (${outcome})\n`);
  };
  const printer = [report.model, report.serial, report.firmware].filter(Boolean).join(' ');
  log(
    `Telemetry: reporting this deploy's start and end, for ` +
      `${printer || 'a printer that did not say what it is'} (--no-telemetry to stop)\n`,
  );
  await send({});

  try {
    const result = await runDeploy(opts, context);
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
    await send({ event: 'end', ok: false, step: step() || '', cause: causeOf(err) });
    throw err;
  }
}

/** The most of a diagnostic log the telemetry server takes. */
export const LOG_LIMIT = 1000000;

/**
 * Send a failed deploy's diagnostic log to the telemetry server, which
 * keeps it for whoever is fixing that printer. Never throws: resolves
 * to { reference } -- what to quote when asking about it -- or to
 * { error }, why it was not sent.
 */
export async function sendDiagnosticLog(
  text,
  { deployId, version = '', url = `${TELEMETRY_URL}/log`, timeoutMs = 15000 } = {},
) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deploy_id: /^[0-9a-f]{16}$/.test(deployId || '')
          ? deployId
          : randomBytes(8).toString('hex'),
        version: String(version).slice(0, 64),
        log: capText(String(text), LOG_LIMIT - 100),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `the server answered ${res.status}` };
    const { reference } = await res.json();
    return { reference };
  } catch (err) {
    return { error: err.cause?.code || err.cause?.message || err.message };
  }
}

/** A diagnostic log's deploy_id and version, from its header. */
export function logHeader(text) {
  const field = (name) => (new RegExp(`^${name}: (.*)$`, 'm').exec(text) || [])[1] || '';
  return { deployId: field('deploy_id'), version: field('version') };
}

/**
 * Write a diagnostic log into `dir`, and say where: named for when, and
 * for its deploy, so two failures in the same second keep both.
 */
export function writeDiagnosticLog(text, dir) {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = logHeader(text).deployId.replace(/[^0-9a-f]/g, '');
  const path = join(dir, `deploy-failed-${stamp}Z${id ? `-${id}` : ''}.log`);
  writeFileSync(path, text);
  return path;
}

/*
 * Whether the printer will serve the page
 * ------------------------------------------------------------------
 * Everything goes up over port 9100, but the console is only any use if
 * port 80 serves it, so that is asked before anything is uploaded. When
 * it does not answer, the printer is asked why over 9100:
 *
 *   ip.http.enable           off: the web server is turned off -- the
 *                            factory setting on some newer firmware
 *                            (a ZD621R on V93.21.48Z). It can be turned
 *                            on, but takes effect only once the printer
 *                            restarts (docs/printer-notes.md)
 *   ip.http.port             not 80: serve, and verify, on that port
 *   ip.firewall.whitelist_in addresses the printer answers; this
 *                            computer may not be one of them
 */

/** The settings that say why a web server does not answer, asked in one go. */
export const WEB_QUERY = ['ip.http.enable', 'ip.http.port', 'ip.firewall.whitelist_in']
  .map((name) => `! U1 getvar "${name}"\r\n`)
  .join('');

/** The answers to WEB_QUERY; '' for one the printer does not know. */
export function parseWebSettings(reply) {
  const [enable = '', port = '', whitelist = ''] = [...String(reply).matchAll(/"([^"]*)"/g)].map(
    (m) => (m[1] === '?' ? '' : m[1].trim()),
  );
  return { enable: enable.toLowerCase(), port, whitelist };
}

/** The base URL of a web server on `port`, the way a person would type it. */
export function webBase(ip, port = 80) {
  return Number(port) === 80 ? `http://${ip}` : `http://${ip}:${port}`;
}

/** Whether anything answers HTTP at `base`: any status will do. */
async function answers(base, timeoutMs) {
  try {
    await probe(`${base}/`, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * An error a person can act on: `code` is one of diag.mjs's CAUSES,
 * which the installer explains and the telemetry reports.
 */
function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Turn the web server on and restart the printer, then wait for it: for
 * port 9100 to answer again (about a minute), then for port 80.
 */
async function enableWebServer(ip, httpPort, { port, log, pause = 5000, waitMs = 180000 }) {
  log('  turning the web server on and restarting the printer ... ');
  await sendRaw(
    ip,
    Buffer.from('! U1 setvar "ip.http.enable" "on"\r\n! U1 do "device.reset" ""\r\n'),
    { quiet: 1, port },
  );
  const until = Date.now() + waitMs;
  await sleep(pause);
  while (Date.now() < until) {
    const back = await readFromPrinter(ip, '! U1 getvar "ip.http.enable"\r\n', {
      idleMs: 800,
      timeout: 4000,
      port,
    }).catch(() => null);
    if (back) {
      if (!/"on"/.test(back)) {
        throw codedError('http-off', `${ip} restarted, but its web server is still turned off`);
      }
      break;
    }
    await sleep(Math.min(2000, pause));
  }
  while (Date.now() < until) {
    if (await answers(webBase(ip, httpPort), 5000)) {
      log('back, and serving\n');
      return;
    }
    await sleep(Math.min(2000, pause));
  }
  throw codedError('http-unreachable', `${ip} did not come back serving its web pages`);
}

/**
 * Make sure the printer's web server answers before anything is put on
 * it, and resolve to the base URL it answers at. A printer that serves
 * costs one GET; one that does not is asked why, and either fixed (the
 * web server turned on, with leave), worked around (another port), or
 * the deploy stops here with what to do about it.
 *
 *   opts.enableHttp    turn the web server on without asking
 *   opts.httpPort      the port to try first (80; the tests' fake)
 *   confirmEnableHttp  asked whether to, when opts.enableHttp is not
 *                      set; resolves true or false. Without it, no
 */
export async function checkWebServer(
  ip,
  opts,
  { log, confirmEnableHttp = null, pause, waitMs } = {},
) {
  const first = opts.httpPort || 80;
  log(`Checking that ${ip} serves web pages ... `);
  if (await answers(webBase(ip, first), 15000)) {
    log('it does\n');
    return webBase(ip, first);
  }
  log('no answer on port ' + first + '; asking it why\n');
  const settings = parseWebSettings(
    await readFromPrinter(ip, WEB_QUERY, { idleMs: 1000, timeout: 10000, port: opts.port }).catch(
      () => '',
    ),
  );
  log(
    `  ip.http.enable "${settings.enable}", ip.http.port "${settings.port}", ` +
      `ip.firewall.whitelist_in "${settings.whitelist}"\n`,
  );
  const httpPort = /^\d+$/.test(settings.port) ? Number(settings.port) : first;

  if (settings.enable === 'off') {
    const yes = opts.enableHttp || (confirmEnableHttp ? await confirmEnableHttp(ip) : false);
    if (!yes) {
      throw codedError(
        'http-off',
        `${ip}'s web server is turned off (ip.http.enable), so it could not serve the console. ` +
          'Turning it on needs the printer restarted: --enable-http does both',
      );
    }
    await enableWebServer(ip, httpPort, { port: opts.port, log, pause, waitMs });
    return webBase(ip, httpPort);
  }
  if (httpPort !== first && (await answers(webBase(ip, httpPort), 15000))) {
    log(`  it serves on port ${httpPort}\n`);
    return webBase(ip, httpPort);
  }
  if (settings.whitelist) {
    throw codedError(
      'http-firewall',
      `${ip} answers web requests only from the addresses in ip.firewall.whitelist_in ` +
        `(${settings.whitelist}); add this computer's, or clear it`,
    );
  }
  throw codedError(
    'http-unreachable',
    `${ip}'s web server is turned on, but did not answer on port ${httpPort} from this computer: ` +
      'something between the two, a firewall or the network, may be in the way',
  );
}

/*
 * Whether the files arrived
 * ------------------------------------------------------------------
 * A CISDFCRC16 upload is never answered: the printer takes the bytes
 * and closes the connection, so the upload alone cannot tell a file
 * stored from one dropped. ^HW, which every ZPL printer knows, lists a
 * drive over the same port, which tells "did not land" apart from
 * "landed, but is not served" -- and still works when port 80 is the
 * trouble. (^HWE:*.SHTML would not do: the printer lists an extension
 * it does not know as *.---, and finds nothing.)
 */

/** Ask for the listing of every file on E:. */
export const LIST_E = '^XA^HWE:*.*^XZ\r\n';

/**
 * A ^HW listing as a Map of name to size, or null if `reply` is not one:
 *
 *   - DIR E:*.*
 *   * E:INDEX.SHTML    538999
 *   * E:TT0003M_.TTF    169188  P
 *   -  56822272 bytes free E: ONBOARD FLASH
 */
export function parseListing(reply) {
  const text = String(reply);
  if (!/^- DIR /m.test(text)) return null;
  const files = new Map();
  for (const m of text.matchAll(/^\* ([A-Z]:\S+)\s+(\d+)/gm)) files.set(m[1], Number(m[2]));
  return files;
}

/**
 * Throw (upload-missing) if any of `sent` is not on the printer at the
 * size it was sent; a printer that will not list E: is let through,
 * for the web server to have the last word.
 */
export async function checkUploaded(ip, sent, { log, port } = {}) {
  log('Checking the files arrived ... ');
  const listing = parseListing(
    await readFromPrinter(ip, LIST_E, { idleMs: 1500, timeout: 20000, port }).catch(() => ''),
  );
  if (!listing) {
    log('the printer would not list E:, so not checked\n');
    return;
  }
  const wrong = sent.filter((f) => listing.get(f.name) !== f.bytes);
  if (!wrong.length) {
    log(`all ${sent.length} there\n`);
    return;
  }
  for (const f of wrong) {
    const there = listing.get(f.name);
    log(
      `  ${f.name}: sent ${f.bytes} bytes, ${there === undefined ? 'not there' : `${there} there`}\n`,
    );
  }
  throw codedError(
    'upload-missing',
    `${wrong.length} of the ${sent.length} files sent to ${ip} did not arrive whole: ` +
      wrong.map((f) => f.name).join(', '),
  );
}

/** deploy() without the telemetry. */
async function runDeploy(
  opts,
  {
    staged,
    schemaPath = null,
    outDir = null,
    readSchema = null,
    writeBuild = null,
    emit,
    confirmEnableHttp = null,
    webWait = {},
  },
) {
  const log = (text) => emit({ type: 'log', text });
  const step = (id) => emit({ type: 'step', ...STEPS.find((s) => s.id === id) });
  const { ip } = opts;

  step('schema');
  let schema;
  if (opts.fetchSchema) {
    schema = await fetchSchema(ip, { source: opts.source, log, port: opts.port });
    if (schemaPath) writeSchema(schema, schemaPath);
  } else {
    if (!readSchema) throw new Error('--no-schema needs a catalogue from an earlier deploy');
    log(`Using cached ${schemaPath}\n`);
    schema = readSchema(schemaPath);
  }

  // Before the build, which a printer that cannot serve the page would waste.
  let base = null;
  if (opts.upload) {
    step('web');
    base = await checkWebServer(ip, opts, { log, confirmEnableHttp, ...webWait });
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
  const sent = [];
  for (const file of files) {
    const bytes = await uploadFile(ip, file.contents, file.dest);
    sent.push({ name: file.dest, bytes });
    log(`  ${file.dest.padEnd(22)} ${bytes} bytes\n`);
  }
  await checkUploaded(ip, sent, { log, port: opts.port });

  step('verify');
  log('Verifying...\n');
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  const page = await probe(`${base}/INDEX.SHTML`);
  log(`  ${base}/INDEX.SHTML -> ${page.status} ${page.bytes}\n`);
  const root = await probe(`${base}/`);
  log(`  ${base}/            -> ${root.status} ${root.bytes}\n`);
  if (page.status !== 200) {
    throw codedError(
      'http-status',
      `The printer answered ${page.status} for INDEX.SHTML after the upload`,
    );
  }
  // The footer is plain text in a packed page too.
  const footer = /Version (\d+\.\d+\.\d+) &middot; Built/.exec(page.body.toString('latin1'));
  const served = footer ? footer[1] : null;
  if (served !== result.version) {
    log(`  but it serves version ${served || '(none found)'}, not ${result.version}\n`);
  }
  return {
    url: `${base}/`,
    version: result.version,
    served,
    printer: telemetryFromPage(page.body.toString('latin1'), result.version),
  };
}

/** Ask a yes-or-no question on the terminal; no is the answer to anything else. */
async function confirm(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** Send a diagnostic log and say how that went; 0 if it went. */
async function sendLogCli(text, fields) {
  process.stdout.write('Sending the diagnostic log ... ');
  const { reference, error } = await sendDiagnosticLog(text, fields);
  if (error) {
    console.log(`not sent (${error})`);
    return 1;
  }
  console.log(`sent; its reference is ${reference}`);
  return 0;
}

/**
 * The CLI: print what deploy() reports, as deploy.sh always has.
 *
 *   logDir    where a failed deploy's diagnostic log is written
 *   command   how to run this again, for the hints it prints
 *   deploy    deploy(), replaced in tests
 *
 * Several printers are installed on one after another, as deploy() is
 * one at a time (diag.mjs keeps one trace); 1 if any of them failed.
 */
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
  if (opts.sendLogFile) {
    let text;
    try {
      text = readFileSync(opts.sendLogFile, 'utf8');
    } catch (err) {
      console.error(`Could not read ${opts.sendLogFile}: ${err.message}`);
      return 1;
    }
    return sendLogCli(text, logHeader(text));
  }
  if (opts.discover) {
    process.stdout.write('Looking for Zebra printers on this network ... ');
    const found = await discoverPrinters().catch((err) => {
      console.log(`could not ask (${err.message})`);
      return null;
    });
    if (!found) return 1;
    console.log(found.length ? `${found.length} found:\n` : 'none answered.');
    for (const p of found) console.log(`  ${describePrinter(p)}`);
    if (found.length) {
      console.log(
        `\nTo install on them: ${context.command || 'node tools/deploy.mjs'} ${found.map((p) => p.ip).join(' ')}`,
      );
    } else {
      console.log(
        'A printer on another network, or with discovery turned off, can be found by\n' +
          'scanning its range instead, for example 192.168.1.0/24.',
      );
    }
    return found.length ? 0 : 1;
  }

  let printers;
  try {
    printers = await resolveTargets(opts);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (printers === null) return 2;
  if (printers.length === 0) return 1;

  const deployOne = context.deploy || deploy;
  const failed = [];
  for (const [i, ip] of printers.entries()) {
    if (printers.length > 1) console.log(`\n== ${ip} (${i + 1} of ${printers.length}) ==\n`);
    const ok = await deployCli({ ...opts, ip }, context, deployOne);
    if (!ok) failed.push(ip);
  }
  if (printers.length > 1) {
    const worked = printers.length - failed.length;
    console.log(`\nInstalled on ${worked} of ${printers.length} printers.`);
    if (failed.length) console.log(`Failed: ${failed.join(' ')}`);
  }
  return failed.length ? 1 : 0;
}

/** One printer as a line of the lists the CLI prints. */
function describePrinter(p) {
  return [p.ip.padEnd(15), (p.model || '(model not known)').padEnd(8), p.firmware, p.name]
    .filter(Boolean)
    .join('  ');
}

/**
 * The addresses to install on: each one given, and what a scan of each
 * range given found -- after asking, for a scan. Resolves to null when
 * the answer was no, and throws for a range that does not parse.
 */
async function resolveTargets(opts) {
  const printers = [];
  let scanned = false;
  for (const target of opts.targets.length ? opts.targets : ['']) {
    if (!isRange(target)) {
      if (!printers.includes(target)) printers.push(target);
      continue;
    }
    scanned = true;
    const addresses = parseRange(target);
    const tty = process.stdout.isTTY;
    let shown = '';
    const progress = ({ phase, done, total }) => {
      if (!tty) return;
      const line =
        phase === 'discovery'
          ? `Asking ${total} addresses in ${target} ... ${done}`
          : `Checking the web pages of ${total} that did not answer ... ${done}`;
      if (line !== shown) process.stdout.write(`\r${line}\x1b[K`);
      shown = line;
    };
    if (!tty)
      console.log(`Scanning ${target} (${addresses.length} addresses) for Zebra printers ...`);
    const found = await scanRange(addresses, { onProgress: progress });
    if (tty) process.stdout.write('\r\x1b[K');
    console.log(
      found.length
        ? `${target}: ${found.length} Zebra printer${found.length === 1 ? '' : 's'}`
        : `${target}: no Zebra printers found`,
    );
    for (const p of found) {
      console.log(`  ${describePrinter(p)}`);
      if (!printers.includes(p.ip)) printers.push(p.ip);
    }
  }
  if (!scanned || printers.length === 0 || opts.yes) return printers;
  const many = printers.length === 1 ? 'this printer' : `these ${printers.length} printers`;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error(`\nTo install on ${many} without being asked, add --yes.`);
    return null;
  }
  return (await confirm(`\nInstall on ${many}? [y/N] `)) ? printers : null;
}

/** One deploy, printed as deploy.sh always has; true if it worked. */
async function deployCli(opts, context, deployOne) {
  try {
    const tty = process.stdin.isTTY && process.stdout.isTTY;
    const { url } = await deployOne(opts, {
      ...context,
      emit: (event) => {
        if (event.type === 'log') process.stdout.write(event.text);
      },
      confirmEnableHttp: tty
        ? (ip) =>
            confirm(
              `\n${ip}'s web server is turned off, so it cannot serve the console. Turn it on?\n` +
                'That restarts the printer, which takes about a minute. [y/N] ',
            )
        : null,
    });
    if (url) console.log(`\nOpen ${url}`);
    return true;
  } catch (err) {
    console.error(`\ndeploy failed: ${err.message}`);
    if (!err.diagnosticLog) return false;
    let path = null;
    if (context.logDir) {
      try {
        path = writeDiagnosticLog(err.diagnosticLog, context.logDir);
        console.error(`\nDiagnostic log: ${path}`);
      } catch (writeErr) {
        console.error(`\nCould not write the diagnostic log: ${writeErr.message}`);
      }
    }
    const fields = { deployId: err.deployId, version: logHeader(err.diagnosticLog).version };
    if (opts.sendLog) {
      await sendLogCli(err.diagnosticLog, fields);
    } else if (opts.telemetry && process.stdin.isTTY && process.stdout.isTTY) {
      const yes = await confirm(
        '\nSend this log to the developer, to help fix it? It holds what the printer\n' +
          'said, including its settings listing, with passwords and keys removed. [y/N] ',
      );
      if (yes) await sendLogCli(err.diagnosticLog, fields);
    } else if (path) {
      console.error(
        `To send it to the developer: ${context.command || 'node tools/deploy.mjs'} --send-log-file '${path}'`,
      );
    }
    return false;
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
    logDir: outDir,
    command: './deploy.sh',
    help: `${USAGE}\n\n${help}`,
  });
}
