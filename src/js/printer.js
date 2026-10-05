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
 * printer.js -- everything that talks to the Zebra onboard web server.
 *
 * The page is served from the printer itself, so every request here is
 * same-origin and relative. Endpoints available to us (no custom CGI allowed):
 *
 *   /Zebra/cgi/setvars.cgi   POST, form-encoded "sgd.name=value". Always
 *                            answers 200 with an empty body, success or not,
 *                            so a write is only confirmed by reading back.
 *   /V_<n>.SHTML             helper files written by the deploy script. Each
 *                            line is "@sgd.name=value@", produced by the
 *                            server-side #exec getvar.cgi preprocessor.
 *   /zpl                     GET  -> edit form containing the stored script
 *                            POST -> preview / print / save a script
 *   /dir                     directory listing (HTML table)
 *   /delete                  delete a stored object (needs pw + confirm)
 *   /png?prev=Y&...          the bitmap a preview rendered into
 *   /<NAME.EXT>              a stored file served as itself, on any drive
 *                            (the namespace is flat), which is the only
 *                            way to read anything that is not a .ZPL
 *
 * Three file.* settings are commands rather than values -- file.print,
 * file.run and file.delete -- and those do work through setvars.cgi,
 * because they need no reply. Its results page is not the evidence it
 * looks like: it reports "FAILED" for every write-only setting, for a
 * file.delete that demonstrably deleted the file as much as for a
 * file.type that did nothing. The only proof is what changed.
 *
 * file.type cannot work here at all: it writes the file to whichever
 * port asked, and an HTTP request is not a port it can answer.
 *
 * Nothing here throws for a printer-level failure; callers get a result
 * object and decide how loud to be about it.
 */

/*
 * The web server answers one request at a time, and a slow setting
 * (file.drive_listing, nine seconds) holds it for the whole read: a
 * request sent meanwhile comes back as "The printer is busy processing
 * another request". So a slow read waits for the requests in flight to
 * finish, and every request made after it waits for the slow read,
 * rather than failing.
 */
let slowRead = null;
let inFlight = 0;
let idleWaiters = [];

/** Run one ordinary request, held back while a slow read has the printer. */
export async function printerTurn(request) {
  // The check and the count happen in the same tick, so a slow read
  // cannot start between them.
  while (slowRead) await slowRead.catch(() => {});
  inFlight++;
  try {
    return await request();
  } finally {
    if (--inFlight === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const wake of waiters) wake();
    }
  }
}

/**
 * Run a slow read with the printer to itself. It claims the printer at
 * once, so nothing new starts while it waits for what is in flight.
 */
async function slowTurn(request) {
  while (slowRead) await slowRead.catch(() => {});
  const turn = (async () => {
    while (inFlight > 0) await new Promise((wake) => idleWaiters.push(wake));
    return request();
  })();
  slowRead = turn;
  try {
    return await turn;
  } finally {
    if (slowRead === turn) slowRead = null;
  }
}

/** Serialize a flat object as application/x-www-form-urlencoded. */
function formEncode(fields) {
  return Object.entries(fields)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

function postForm(url, fields, options) {
  return printerTurn(() => sendForm(url, fields, options));
}

async function sendForm(url, fields, { timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode(fields),
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

function getText(url, options) {
  return printerTurn(() => fetchText(url, options));
}

async function fetchText(url, { timeout = 30000, charset = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    // The printer sends no charset. That is fine for settings, which are
    // ASCII, but the display grid carries single high bytes for its icons
    // and those are not valid UTF-8 -- decoding as such would replace them.
    if (!charset) return await res.text();
    return new TextDecoder(charset).decode(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * SGD settings
 * ------------------------------------------------------------------ */

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

/**
 * Undo the escaping the SSI preprocessor applies to substituted values.
 * It rewrites & " ' < > as entities, so a setting holding `A&B "q"` comes
 * back as `A&amp;B &quot;q&quot;` -- which would be displayed wrong and,
 * worse, would never match on the read-back after a write.
 */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:([a-z]+)|#(\d+)|#x([0-9a-f]+));/gi, (whole, name, dec, hex) => {
    if (name) {
      const mapped = ENTITIES[name.toLowerCase()];
      return mapped === undefined ? whole : mapped;
    }
    const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Parse a helper .SHTML file. The preprocessor has already replaced each
 * #exec with the variable's value, leaving lines of "@name=value@".
 * Values may contain newlines (device.syslog, file.drive_listing), so
 * match lazily across lines rather than line by line.
 *
 * Only line breaks are stripped from the edges, never spaces: display.text
 * is a fixed 20x6 character grid whose padding is the layout.
 */
export function parseVarFile(text) {
  const out = {};
  const re = /@([a-z0-9_.]+)=([\s\S]*?)@(?=\r?\n|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    out[m[1]] = decodeEntities(m[2].replace(/^[\r\n]+|[\r\n]+$/g, ''));
  }
  return out;
}

/**
 * Which helper file holds each settings branch: the build packs small
 * branches together, so this comes from the build (schema.branchFiles)
 * rather than from the branch's name.
 */
let branchFiles = {};

export function setBranchFiles(map) {
  branchFiles = map || {};
}

/** Helper-file path holding a settings branch, or null if none does. */
export function branchFile(branch) {
  const stem = branchFiles[branch];
  return stem ? `/${stem}.SHTML` : null;
}

/**
 * Read every live value in the helper file holding one SGD branch --
 * which may carry a few small branches besides (~0.1-0.4 s).
 */
export async function readBranch(branch) {
  const path = branchFile(branch);
  if (!path) throw new Error(`No helper file holds the ${branch} branch`);
  return parseVarFile(await getText(path));
}

/**
 * Read one setting that is too slow to include in a branch sweep, from
 * the single-setting helper the build wrote for it. Minutes of patience
 * are not required, but seconds are.
 */
export async function readSlowSetting(fileStem, { timeout = 60000 } = {}) {
  return parseVarFile(await slowTurn(() => fetchText(`/${fileStem}.SHTML`, { timeout })));
}

/**
 * Read the front-panel mirror: the LCD as a character grid, plus the
 * backlight and contrast settings. Decoded as windows-1252 so the icon
 * bytes survive as single characters.
 */
export async function readLcd({ timeout = 15000 } = {}) {
  return parseVarFile(await getText('/LCD.SHTML', { timeout, charset: 'windows-1252' }));
}

/** The printer's clock (build.mjs CLOCK_VARS). */
export async function readClock({ timeout = 15000 } = {}) {
  return parseVarFile(await getText('/CLOCK.SHTML', { timeout }));
}

/** The settings the header's status pill is drawn from (build.mjs STATUS_VARS). */
export async function readStatus({ timeout = 15000 } = {}) {
  return parseVarFile(await getText('/STATUS.SHTML', { timeout }));
}

/**
 * Send control commands -- ~PH, ~PP, ~JC and the like -- to be acted on
 * at once. They go in through the label form's print action, which hands
 * its data to the ZPL parser as a port would; a control command prints
 * nothing of its own.
 */
export async function sendControl(commands) {
  const res = await postForm('/zpl', {
    data: commands,
    dev: 'R',
    oname: 'UNKNOWN',
    otype: 'ZPL',
    print: 'Print Label',
  });
  const err = extractPrinterError(res.text);
  if (err) throw new Error(err);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * The ZPL command reference (src/data/zpl-reference.mjs), which the build
 * writes to a file of its own rather than into the page: at ~95 KB it
 * would add nearly two seconds to every load, and only the source view
 * wants it. Read once, on first use.
 */
let zplReference = null;

export function readZplReference() {
  if (!zplReference) {
    zplReference = getText('/ZPLREF.SHTML', { timeout: 60000 }).then((text) => JSON.parse(text));
    zplReference.catch(() => {
      zplReference = null;
    });
  }
  return zplReference;
}

/**
 * What each setting is for (src/data/sgd-reference.mjs), served beside
 * the page like the ZPL reference and read the first time a setting's
 * explanation is opened.
 */
let sgdReference = null;

export function readSgdReference() {
  if (!sgdReference) {
    sgdReference = getText('/SGDREF.SHTML', { timeout: 60000 }).then((text) => JSON.parse(text));
    sgdReference.catch(() => {
      sgdReference = null;
    });
  }
  return sgdReference;
}

/**
 * The front panel's real bitmap, if lcd_display_helper.sh is running.
 *
 * The helper reads display.image over port 9100, which a page cannot,
 * and stores it on the printer's RAM drive as R:LCD.GRF; /png hands a
 * stored graphic back as a PNG. Resolves with the PNG as a Blob, or null
 * when there is no such graphic -- the helper is not running, or has
 * been stopped and removed it.
 */
export function readPanelFrame({ timeout = 10000 } = {}) {
  return printerTurn(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch('/png?dev=R&oname=LCD&otype=GRF', {
        signal: ctrl.signal,
        cache: 'no-store',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for R:LCD.GRF`);
      return await res.blob();
    } finally {
      clearTimeout(timer);
    }
  });
}

/**
 * Pull whole "@name=value@" records out of a buffer that is still growing.
 *
 * A record is only complete once its closing @ has a line ending after
 * it -- values run to several lines (device.syslog), and a value can
 * contain an @ of its own -- so whatever follows the last complete one
 * is handed back to be prepended to the next chunk.
 */
export function extractVarRecords(buffer) {
  const values = {};
  const re = /@([a-z0-9_.]+)=([\s\S]*?)@(?=\r?\n)/gi;
  let consumed = 0;
  let match;
  while ((match = re.exec(buffer)) !== null) {
    values[match[1]] = decodeEntities(match[2].replace(/^[\r\n]+|[\r\n]+$/g, ''));
    consumed = match.index + match[0].length;
  }
  return { values, rest: buffer.slice(consumed) };
}

/**
 * Read every setting in one request, painting as it arrives.
 *
 * One file rather than one per branch: this web server charges about
 * 95 ms a request, which over 32 branches is three seconds of doing
 * nothing. It answers this one in 3.9 s against 6.9 s for the set --
 * and because the preprocessor streams its output as each getvar
 * returns, the values still arrive a few at a time. The first lands at
 * about 120 ms, which is sooner than the first branch file used to.
 *
 * `onValues` is called with each batch as it is decoded.
 */
export function readAllSettings(fileStem, onValues, options) {
  return printerTurn(() => streamAllSettings(fileStem, onValues, options));
}

async function streamAllSettings(fileStem, onValues, { timeout = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`/${fileStem}.SHTML`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${fileStem}.SHTML`);

    // Without a body reader there is nothing to stream; take it whole.
    if (!res.body || !res.body.getReader) {
      const values = parseVarFile(await res.text());
      if (onValues) onValues(values);
      return values;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const all = {};
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const batch = extractVarRecords(buffer);
      buffer = batch.rest;
      if (Object.keys(batch.values).length) {
        Object.assign(all, batch.values);
        if (onValues) onValues(batch.values);
      }
    }

    // The last record has no line ending after it, so it never matched.
    const tail = parseVarFile(buffer + '\n');
    if (Object.keys(tail).length) {
      Object.assign(all, tail);
      if (onValues) onValues(tail);
    }
    return all;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write one setting, then read the branch back to find out whether it took.
 * setvars.cgi reports nothing useful, so the read-back is the only source
 * of truth. Returns {ok, actual, reason}.
 */
export async function writeSetting(name, value) {
  try {
    await postForm('/Zebra/cgi/setvars.cgi', { [name]: value });
  } catch (err) {
    return { ok: false, actual: null, branch: null, reason: 'Could not reach setvars.cgi' };
  }

  // A branch is the smallest thing that can be read: a value only comes
  // back through a helper file holding an #exec for it, and the build
  // writes a few, each holding whole branches. So the read-back returns
  // every setting in the file whether we want them or not -- and we do
  // want them. One
  // write often moves others (print.tone carries print.tone_zpl with
  // it; a mode changes what its neighbours are allowed to hold), and
  // those values have already been paid for.
  const branch = name.split('.')[0];
  let values;
  try {
    values = await readBranch(branch);
  } catch (err) {
    // The write probably landed, we just cannot prove it.
    return { ok: true, actual: null, branch: null, reason: 'Applied, but read-back failed' };
  }

  const actual = values[name];
  if (actual === undefined) {
    return { ok: true, actual: null, branch: values, reason: 'Applied, but value is not readable' };
  }
  if (valuesMatch(actual, value)) {
    return { ok: true, actual, branch: values, reason: null };
  }
  return {
    ok: false,
    actual,
    branch: values,
    reason: `Printer kept "${actual}"` + (actual === '?' ? ' (rejected)' : ''),
  };
}

/**
 * Compare a written value with what the printer reports back. The printer
 * normalizes some values on the way in ("5" -> "5.0", "ON" -> "on"), so an
 * exact string match is too strict.
 */
export function valuesMatch(actual, written) {
  if (actual === written) return true;
  const a = String(actual).trim().toLowerCase();
  const w = String(written).trim().toLowerCase();
  if (a === w) return true;
  const na = Number(a);
  const nw = Number(w);
  if (Number.isFinite(na) && Number.isFinite(nw) && na === nw) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Stored graphics
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const imageCache = new Map();

/**
 * Repair what /png hands back.
 *
 * Asked for a stored .PNG the printer streams the file but drops its
 * first four bytes, so what arrives starts at "\r\n\x1a\n" and no browser
 * will touch it. (A .GRF comes back converted, and correct.) The four
 * missing bytes are always the same, so put them back.
 */
export function repairPng(bytes) {
  const hasSignature = PNG_SIGNATURE.every((b, i) => bytes[i] === b);
  if (hasSignature) return bytes;

  const startsMidSignature = PNG_SIGNATURE.slice(4).every((b, i) => bytes[i] === b);
  if (!startsMidSignature) return bytes;

  const fixed = new Uint8Array(bytes.length + 4);
  fixed.set(PNG_SIGNATURE.slice(0, 4), 0);
  fixed.set(bytes, 4);
  return fixed;
}

/**
 * Fetch a stored graphic as something an <img> will accept. Cached: the
 * canvas re-renders often and these run to 160 KB over a 56 KB/s link.
 */
export function loadStoredImage({ dev, oname, otype }) {
  const key = `${dev}:${oname}.${otype}`;
  if (imageCache.has(key)) return imageCache.get(key);

  const pending = (async () => {
    const url = `/png?dev=${dev}&oname=${encodeURIComponent(oname)}&otype=${otype}`;
    const bytes = await printerTurn(async () => {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`);
      return repairPng(new Uint8Array(await res.arrayBuffer()));
    });
    return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  })();

  imageCache.set(key, pending);
  pending.catch(() => imageCache.delete(key));
  return pending;
}

/** Forget a cached graphic, so the next render re-reads it. */
export function forgetStoredImage(name) {
  const pending = imageCache.get(name);
  if (!pending) return;
  imageCache.delete(name);
  pending.then((url) => URL.revokeObjectURL(url)).catch(() => {});
}

/**
 * Store a 1-bit graphic on the printer as <name>.GRF.
 *
 * ~DY is a download command, so it has to reach the ZPL parser -- and
 * the only way a browser can do that is the /zpl form. Preview is the
 * action to use: it runs the parser without feeding a label. The ASCII
 * hex form (b=A) keeps the payload printable, which matters because it
 * travels as a urlencoded form field. Sending a PNG the same way does
 * not work: the printer stores nothing.
 */
export async function uploadGraphic({ oname, hex, totalBytes, bytesPerRow }) {
  const name = oname.toUpperCase();
  const res = await postForm(
    '/zpl',
    {
      data: `~DYE:${name},A,G,${totalBytes},${bytesPerRow},${hex}`,
      dev: 'R',
      oname: 'UNKNOWN',
      otype: 'ZPL',
      prev: 'Preview Label',
    },
    { timeout: 120000 },
  );

  const err = extractPrinterError(res.text);
  if (err) throw new Error(err);

  // ~DY reports nothing, so confirm by looking for the object.
  const files = await listFiles({ dev: 'E', otype: 'GRF' });
  const stored = files.find((f) => f.oname === name && f.otype === 'GRF');
  if (!stored) throw new Error(`The printer did not store ${name}.GRF`);
  forgetStoredImage(`E:${name}.GRF`);
  return stored;
}

/* ------------------------------------------------------------------ *
 * Stored objects (files on E: and R:)
 * ------------------------------------------------------------------ */

/**
 * List stored objects by scraping /dir. Faster than the file.dir SGD
 * (0.14 s vs 3 s) because it does not walk the ROM drive.
 */
export async function listFiles({ dev = 'E', otype = '*  ' } = {}) {
  const html = await getText(
    `/dir?dev=${encodeURIComponent(dev)}&otype=${encodeURIComponent(otype)}`,
  );
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const files = [];

  for (const row of doc.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 3) continue;
    const name = cells[1].textContent.trim();
    const match = /^([A-Z]):([^.]+)\.(.+)$/.exec(name);
    if (!match) continue;
    files.push({
      name,
      dev: match[1],
      oname: match[2],
      otype: match[3],
      bytes: parseInt(cells[2].textContent.trim(), 10) || 0,
    });
  }
  return files;
}

/**
 * Every file on a drive, with its real extension.
 *
 * /dir is fast but reports any type the web server does not know as
 * "---", which loses the extension -- and the extension is what says
 * whether a file can be printed, run or viewed. file.drive_listing is
 * the one place the real name survives. It costs about nine seconds, so
 * callers treat it as a background repair of a /dir listing rather than
 * the way to list a drive.
 *
 * The value is JSON: {"E": {"NAME.EXT": {access, size, date, flags}}}.
 */
export async function readDriveListing({ fileStem, timeout = 60000 } = {}) {
  const values = await readSlowSetting(fileStem, { timeout });
  return parseDriveListing(values['file.drive_listing']);
}

/** Flatten the file.drive_listing JSON into the shape listFiles returns. */
export function parseDriveListing(raw) {
  if (!raw) return [];
  let tree;
  try {
    tree = JSON.parse(raw);
  } catch (err) {
    throw new Error('The printer returned a drive listing that is not valid JSON');
  }

  const files = [];
  for (const [dev, entries] of Object.entries(tree)) {
    if (!entries || typeof entries !== 'object') continue;
    for (const [filename, meta] of Object.entries(entries)) {
      const dot = filename.lastIndexOf('.');
      if (dot < 1) continue;
      files.push({
        name: `${dev}:${filename}`,
        dev,
        oname: filename.slice(0, dot),
        otype: filename.slice(dot + 1).toUpperCase(),
        bytes: (meta && Number(meta.size)) || 0,
        date: (meta && meta.date) || '',
        access: (meta && meta.access) || '',
      });
    }
  }
  return files;
}

/**
 * Fetch a stored file byte for byte, the way the printer's own web
 * server serves it: a file on E: is published at /NAME.EXT.
 *
 * This is the only way to read anything other than a .ZPL -- /zpl
 * refuses every other type -- but the server does not serve everything
 * either. Measured on a ZD500R: .ZPL, .PNG, .BAT and .SHTML come back,
 * .NRD and .TTF answer 500. A 404 usually means the real extension is
 * not what /dir said it was.
 *
 * The path namespace is flat -- /NAME.EXT, whichever drive the file is
 * on -- so a ROM file comes back the same way a flash one does. Where
 * two drives hold the same name, the printer decides which it serves.
 *
 * The obvious alternative, `setvar file.type`, cannot work here. The
 * printer writes the contents back to the port the command arrived on,
 * and through setvars.cgi that is nowhere: the CGI answers with a
 * results page reading "file.type->E:NAME FAILED", and reading the
 * setting back through the preprocessor gives "?". (That page says
 * FAILED for every write-only setting, file.delete included, so it is
 * no evidence either way -- but nothing arrives.)
 */
export function fetchStoredFile(file, options) {
  return printerTurn(() => fetchStoredBytes(file, options));
}

async function fetchStoredBytes({ oname, otype }, { timeout = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`/${encodeURIComponent(`${oname}.${otype}`)}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (res.status === 404) {
      throw new Error(`The printer does not serve ${oname}.${otype} (is that the real extension?)`);
    }
    if (!res.ok) {
      throw new Error(
        `The printer's web server will not hand over a .${otype} (HTTP ${res.status})`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Undo the way the printer stores a ZPL format: it tokenizes the file,
 * writing ^ as 0x1E and , as 0x1F and dropping the line breaks. The
 * /zpl form hands back readable text, so this is only needed when a
 * .ZPL has been fetched as a file.
 */
export function detokenizeZpl(text) {
  return text.replace(/\x1e/g, '\n^').replace(/\x1f/g, ',').replace(/^\n/, '');
}

/**
 * Write a command setting -- one of the write-only SGDs that make the
 * printer do something (file.print, file.run, file.delete) rather than
 * hold a value.
 *
 * There is nothing to read back: the setting is not readable, and
 * setvars.cgi answers 200 with an empty body either way. So this
 * reports only that the request was delivered, and callers confirm by
 * looking at what changed -- a file that disappeared, a label printed.
 */
export async function sendCommandSetting(name, value) {
  const res = await postForm('/Zebra/cgi/setvars.cgi', { [name]: value });
  if (!res.ok) throw new Error(`setvars.cgi answered HTTP ${res.status}`);
  return true;
}

/**
 * Press a button on the printer's own front panel.
 *
 * `diag.simulate_event` is undocumented and not in any catalogue --
 * allconfig and allcv both omit it -- but a getvar answers "" rather
 * than "?", which is how a write-only setting that exists replies. It
 * works through setvars.cgi like the other commands, and the value is
 * exact: "ButtonUp:Set", with the prefix, the capitals and the suffix.
 * "do" instead of "setvar", lower case, or a missing ":Set" all do
 * nothing at all.
 */
export function pressPanelButton(button) {
  return sendCommandSetting('diag.simulate_event', `${button}:Set`);
}

/** Print a stored format by name, e.g. "E:LABEL.ZPL". */
export function printStoredFile(name) {
  return sendCommandSetting('file.print', name);
}

/** Run a stored .BAT file by name, e.g. "E:SETUP.BAT". */
export function runStoredFile(name) {
  return sendCommandSetting('file.run', name);
}

/**
 * Delete through the SGD rather than the /delete CGI.
 *
 * It needs no password and, unlike the CGI, it will remove the types the
 * CGI refuses -- anything /dir lists as "---", .NRD included. Nothing is
 * reported back, so the caller re-lists to find out whether it worked.
 */
export function deleteStoredFile(name) {
  return sendCommandSetting('file.delete', name);
}

/**
 * Split what someone typed into an object name and a type.
 *
 * The printer stores NAME.EXT, so "test.zpl" is a name and a type, not
 * a name with a dot in it -- and TESTZPL.ZPL, which is what stripping
 * the dot gives you, is nobody's idea of the same file. A name with no
 * extension gets the default.
 */
export function parseObjectName(input, defaultType = 'ZPL') {
  const raw = String(input).trim();
  const dot = raw.lastIndexOf('.');
  const hasExt = dot > 0 && dot < raw.length - 1;

  const clean = (part, max) =>
    part
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '')
      .slice(0, max);
  const oname = clean(hasExt ? raw.slice(0, dot) : raw, 16);
  const otype = (hasExt && clean(raw.slice(dot + 1), 8)) || String(defaultType).toUpperCase();

  return { oname, otype };
}

/** Read a stored ZPL script out of the /zpl edit form's textarea. */
export async function readScript({ dev, oname, otype = 'ZPL' }) {
  const html = await getText(`/zpl?dev=${dev}&oname=${encodeURIComponent(oname)}&otype=${otype}`);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const textarea = doc.querySelector('textarea[name="data"]');
  if (!textarea) throw new Error(`No script content returned for ${dev}:${oname}.${otype}`);
  return textarea.value.replace(/\r\n/g, '\n');
}

/** Save a script to the printer's filesystem. Requires the printer password. */
export async function saveScript({ dev = 'E', oname, otype = 'ZPL', data, password }) {
  const res = await postForm('/zpl', {
    data,
    dev,
    oname: oname.toUpperCase(),
    otype,
    pw: password || '',
    save: 'Save',
  });
  const err = extractPrinterError(res.text);
  if (err) throw new Error(err);
  if (!/queued|saved/i.test(res.text)) {
    throw new Error('Printer did not confirm the save');
  }
  return true;
}

/** Delete a stored object. Requires the printer password. */
export async function deleteFile({ dev, oname, otype, password }) {
  const url =
    `/delete?dev=${dev}&oname=${encodeURIComponent(oname)}&otype=${encodeURIComponent(otype)}` +
    `&pw=${encodeURIComponent(password || '')}&confirm=Delete`;
  const html = await getText(url);
  const err = extractPrinterError(html);
  if (err) throw new Error(err);
  return true;
}

/**
 * Pull the message out of a printer error page. Its pages mark failures with
 * "<B>ERROR:</B> some text." inside a paragraph.
 */
export function extractPrinterError(html) {
  const match = /<B>\s*ERROR:\s*<\/B>\s*([^<]+)/i.exec(html);
  if (!match) return null;
  return match[1].replace(/\s+/g, ' ').trim();
}
