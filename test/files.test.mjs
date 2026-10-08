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

/* The filesystem mode's decisions. Run: node test/files.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const printerSrc = readFileSync(new URL('../src/js/printer.js', import.meta.url), 'utf8');
const printerUrl = 'data:text/javascript;base64,' + Buffer.from(printerSrc).toString('base64');
const p = await import(printerUrl);

/**
 * files.js pulls in the other modes the moment it is imported, and each
 * of those expects a document. Everything tested here decides from its
 * arguments alone, so those imports are cut and only printer.js -- which
 * needs nothing but fetch -- is resolved for real.
 */
const filesSrc = readFileSync(new URL('../src/js/files.js', import.meta.url), 'utf8')
  .replace("'./printer.js'", `'${printerUrl}'`)
  .replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/[^']*';?$/gm, '');
const fs = await import('data:text/javascript;base64,' + Buffer.from(filesSrc).toString('base64'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * The drive listing, which is where real extensions come from
 * ------------------------------------------------------------------ */

// Trimmed from what a ZD500R actually returned.
const LISTING = JSON.stringify({
  R: {},
  E: {
    'FF.BAT': { access: 'RW', size: 25, date: '09-20-2026 04:54:49', flags: '' },
    'FORMAT3X1.ZPL': { access: 'RW', size: 246, date: '07-31-2025 03:18:46', flags: '' },
    'INDEX.SHTML': { access: 'RW', size: 240558, date: '09-22-2026 15:57:23', flags: '' },
    'TT0003M_.TTF': { access: 'R', size: 1024, date: '', flags: '' },
  },
});

check('the drive listing gives real extensions, sizes and access', () => {
  const files = p.parseDriveListing(LISTING);
  const bat = files.find((f) => f.oname === 'FF');
  assert.equal(bat.otype, 'BAT', '/dir reports this one as "---"');
  assert.equal(bat.name, 'E:FF.BAT');
  assert.equal(bat.dev, 'E');
  assert.equal(bat.bytes, 25);
  assert.equal(bat.date, '09-20-2026 04:54:49');

  const shtml = files.find((f) => f.oname === 'INDEX');
  assert.equal(shtml.otype, 'SHTML', 'the extension can be longer than three characters');
  assert.equal(files.find((f) => f.oname === 'TT0003M_').access, 'R');
});

check('an empty drive contributes nothing', () => {
  assert.deepEqual(p.parseDriveListing(JSON.stringify({ R: {}, E: {} })), []);
  assert.deepEqual(p.parseDriveListing(''), []);
});

check('a truncated listing is an error, not silently half a drive', () => {
  assert.throws(() => p.parseDriveListing('{"E":{"A.ZPL":'), /not valid JSON/);
});

/* ------------------------------------------------------------------ *
 * A stored .ZPL is tokenized on the way in
 * ------------------------------------------------------------------ */

check('stored ZPL is turned back into ZPL', () => {
  // What GET /FORMAT3X1.ZPL actually returns: ^ as 0x1e, , as 0x1f.
  const stored = '\x1eXA\x1eCF0\x1f80\x1eFO10\x1f10\x1eFDHELLO\x1eXZ';
  assert.equal(p.detokenizeZpl(stored), '^XA\n^CF0,80\n^FO10,10\n^FDHELLO\n^XZ');
});

check('text that was never tokenized is left alone', () => {
  assert.equal(p.detokenizeZpl('! U1 setvar "x" "y"\r\n'), '! U1 setvar "x" "y"\r\n');
});

/* ------------------------------------------------------------------ *
 * What each row is allowed to do
 * ------------------------------------------------------------------ */

check('a stored ZPL can do everything', () => {
  const caps = fs.fsCapabilities({ dev: 'E', oname: 'LABEL', otype: 'ZPL' });
  assert.equal(caps.view, null);
  assert.equal(caps.download, null);
  assert.equal(caps.edit, null);
  assert.equal(caps.print, null);
  assert.equal(caps.delete, null);
  assert.match(caps.run, /Only a \.BAT/, 'but it is not a batch file');
});

check('a .BAT runs, and is not offered as a label', () => {
  const caps = fs.fsCapabilities({ dev: 'E', oname: 'FF', otype: 'BAT' });
  assert.equal(caps.run, null);
  assert.equal(caps.view, null, 'the web server does serve a .BAT');
  assert.match(caps.print, /not a stored label format/);
  assert.match(caps.edit, /only write a \.ZPL/);
});

check('a CPCL label prints, and says why it cannot be edited', () => {
  const caps = fs.fsCapabilities({ dev: 'E', oname: 'SHELF', otype: 'LBL' });
  assert.equal(caps.print, null);
  assert.match(caps.edit, /\.LBL is read-only/);
});

check('a type /dir could not name offers nothing, and says so', () => {
  const caps = fs.fsCapabilities({ dev: 'E', oname: 'FF', otype: '---' });
  assert.match(caps.view, /did not report/);
  assert.match(caps.edit, /did not report/);
  assert.match(caps.print, /did not report/);
  assert.ok(fs.fsIsUnknownType('---') && fs.fsIsUnknownType('') && !fs.fsIsUnknownType('ZPL'));
});

check('the ROM drive can be read but not written', () => {
  // The web server's path namespace is flat -- /BLUETOOTH.WML fetches a
  // ROM file as readily as a flash one -- so View and Download are open
  // on every drive, and only writing is refused.
  const rom = fs.fsCapabilities({ dev: 'Z', oname: 'BLUETOOTH', otype: 'WML' });
  assert.equal(rom.view, null);
  assert.equal(rom.download, null);
  assert.match(rom.delete, /read-only/);
  assert.match(rom.edit, /read-only/);

  const ram = fs.fsCapabilities({ dev: 'R', oname: 'TEMP', otype: 'ZPL' });
  assert.equal(ram.view, null, 'RAM is fetched the same way');
  assert.equal(ram.edit, null, 'and it is writable');
});

check('Download goes wherever View goes', () => {
  for (const file of [
    { dev: 'E', oname: 'LABEL', otype: 'ZPL' },
    { dev: 'Z', oname: 'A', otype: 'FNT' },
    { dev: 'E', oname: 'FF', otype: 'BAT' },
  ]) {
    const caps = fs.fsCapabilities(file);
    assert.equal(caps.download, caps.view, `${file.oname}.${file.otype}`);
  }
  // Except where there is no name to ask for.
  const unknown = fs.fsCapabilities({ dev: 'E', oname: 'X', otype: '---' });
  assert.match(unknown.download, /did not report/);
});

check('the drive listing’s access flags are believed when present', () => {
  const locked = fs.fsCapabilities({ dev: 'E', oname: 'X', otype: 'ZPL', access: 'R' });
  assert.match(locked.delete, /read-only/);
  assert.equal(
    fs.fsCapabilities({ dev: 'E', oname: 'X', otype: 'ZPL', access: 'RW' }).delete,
    null,
  );
});

/* ------------------------------------------------------------------ *
 * Reading bytes back
 * ------------------------------------------------------------------ */

check('text is told from bytes', () => {
  const text = new TextEncoder().encode('^XA^FDHELLO^FS^XZ\r\n');
  assert.equal(fs.fsLooksBinary(text), false);
  assert.equal(
    fs.fsLooksBinary(new Uint8Array([0x1e, 0x46, 0x53, 0x1f, 0x31])),
    false,
    'a tokenized ZPL is still text',
  );
  assert.equal(
    fs.fsLooksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])),
    true,
    'a PNG has a NUL in its signature',
  );
});

check('a .BAT is text, escape sequences and all', () => {
  // E:FF.BAT on the bench printer, byte for byte.
  const bat = new Uint8Array([
    0x1b,
    ...new TextEncoder().encode('JWaccNVMI40J132100037'),
    0,
    13,
    10,
  ]);
  assert.equal(fs.fsLooksBinary(bat), false, 'an ESC and a trailing NUL do not make it binary');
  assert.equal(
    fs.fsToDisplayText(bat),
    '\\x1bJWaccNVMI40J132100037\\x00\r\n',
    'the control bytes are shown rather than swallowed by the markup',
  );
});

check('a stored ZPL displays as the ZPL it was', () => {
  assert.equal(
    fs.fsToDisplayText(new Uint8Array([0x1e, 0x58, 0x41, 0x1e, 0x46, 0x53, 0x1f, 0x31])),
    '^XA\n^FS,1',
  );
});

check('the hex dump is offset, bytes and characters, and says what it left out', () => {
  const dump = fs.fsHexDump(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(dump, '00000000  89 50 4e 47                                      .PNG');
  const long = fs.fsHexDump(new Uint8Array(40), 16);
  assert.match(long, /… 24 more bytes$/);
});

/* ------------------------------------------------------------------ *
 * Upload routing
 * ------------------------------------------------------------------ */

check('a picture goes through the one-bit converter', () => {
  assert.equal(fs.fsUploadRoute('logo.png', 'image/png').route, 'image');
  assert.equal(
    fs.fsUploadRoute('LOGO.JPG', '').route,
    'image',
    'by extension when the type is missing',
  );
  assert.equal(fs.fsUploadRoute('scan', 'image/tiff').route, 'image');
});

check('a label format goes through the ZPL form', () => {
  assert.equal(fs.fsUploadRoute('label.zpl', 'text/plain').route, 'zpl');
  assert.equal(fs.fsUploadRoute('SHELF.FMT', '').route, 'zpl');
});

check('anything the printer cannot be given is refused up front', () => {
  assert.equal(fs.fsUploadRoute('setup.bat', '').route, 'none');
  assert.equal(fs.fsUploadRoute('font.ttf', '').route, 'none');
  assert.equal(fs.fsUploadRoute('README', '').route, 'none');
  assert.equal(fs.fsUploadRoute('page.shtml', 'text/html').route, 'none');
});

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
