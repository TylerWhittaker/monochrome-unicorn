/*
 * printer.js -- everything that talks to the Zebra onboard web server.
 *
 * The page is served from the printer itself, so every request here is
 * same-origin and relative. Endpoints available to us (no custom CGI allowed):
 *
 *   /Zebra/cgi/setvars.cgi   POST, form-encoded "sgd.name=value". Always
 *                            answers 200 with an empty body, success or not,
 *                            so a write is only confirmed by reading back.
 *   /V_<BRANCH>.SHTML        helper files written by the deploy script. Each
 *                            line is "@sgd.name=value@", produced by the
 *                            server-side #exec getvar.cgi preprocessor.
 *   /zpl                     GET  -> edit form containing the stored script
 *                            POST -> preview / print / save a script
 *   /dir                     directory listing (HTML table)
 *   /delete                  delete a stored object (needs pw + confirm)
 *   /png?prev=Y&...          the bitmap a preview rendered into
 *
 * Nothing here throws for a printer-level failure; callers get a result
 * object and decide how loud to be about it.
 */

/** Serialize a flat object as application/x-www-form-urlencoded. */
function formEncode(fields) {
  return Object.entries(fields)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

async function postForm(url, fields, { timeout = 30000 } = {}) {
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

async function getText(url, { timeout = 30000, charset = null } = {}) {
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

/** Helper-file name for a settings branch, matching tools/build.mjs. */
export function branchFile(branch) {
  return '/V_' + branch.toUpperCase() + '.SHTML';
}

/** Read every live value in one SGD branch (~0.1 s for most branches). */
export async function readBranch(branch) {
  return parseVarFile(await getText(branchFile(branch)));
}

/**
 * Read one setting that is too slow to include in a branch sweep, from
 * the single-setting helper the build wrote for it. Minutes of patience
 * are not required, but seconds are.
 */
export async function readSlowSetting(fileStem, { timeout = 60000 } = {}) {
  return parseVarFile(await getText(`/${fileStem}.SHTML`, { timeout }));
}

/**
 * Read the front-panel mirror: the LCD as a character grid, plus the
 * backlight and contrast settings. Decoded as windows-1252 so the icon
 * bytes survive as single characters.
 */
export async function readLcd({ timeout = 15000 } = {}) {
  return parseVarFile(await getText('/LCD.SHTML', { timeout, charset: 'windows-1252' }));
}

/**
 * Read live values for every branch, handing each one to `onBranch` as it
 * lands so the caller can show values arriving rather than waiting for the
 * whole sweep.
 *
 * Fetched sequentially: the printer's web server closes each connection
 * and handles one request at a time, so firing these in parallel makes it
 * slower, not faster. A branch is also the finest granularity available --
 * it is one HTTP request, so its settings arrive together.
 */
export async function readAllBranches(branches, onBranch) {
  const failed = [];
  let read = 0;

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i];
    let values = null;
    try {
      values = await readBranch(branch);
      read += Object.keys(values).length;
    } catch (err) {
      failed.push(branch);
    }
    if (onBranch) onBranch({ branch, values, read, branchesDone: i + 1 });
  }
  return { failed, read };
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
    return { ok: false, actual: null, reason: 'Could not reach setvars.cgi' };
  }

  const branch = name.split('.')[0];
  let actual;
  try {
    const values = await readBranch(branch);
    actual = values[name];
  } catch (err) {
    // The write probably landed, we just cannot prove it.
    return { ok: true, actual: null, reason: 'Applied, but read-back failed' };
  }

  if (actual === undefined) {
    return { ok: true, actual: null, reason: 'Applied, but value is not readable' };
  }
  if (valuesMatch(actual, value)) {
    return { ok: true, actual, reason: null };
  }
  return {
    ok: false,
    actual,
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
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`);
    const bytes = repairPng(new Uint8Array(await res.arrayBuffer()));
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
  const res = await postForm('/zpl', {
    data: `~DYE:${name},A,G,${totalBytes},${bytesPerRow},${hex}`,
    dev: 'R',
    oname: 'UNKNOWN',
    otype: 'ZPL',
    prev: 'Preview Label',
  }, { timeout: 120000 });

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
  const html = await getText(`/dir?dev=${encodeURIComponent(dev)}&otype=${encodeURIComponent(otype)}`);
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
  const url = `/delete?dev=${dev}&oname=${encodeURIComponent(oname)}&otype=${encodeURIComponent(otype)}`
    + `&pw=${encodeURIComponent(password || '')}&confirm=Delete`;
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
