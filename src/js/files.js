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
 * files.js -- Mode 5: the printer's filesystem.
 *
 * Every stored object on a drive, with what can be done to each one.
 * What that is depends entirely on the type, because the printer's web
 * server treats types very differently:
 *
 *   view     .ZPL through the /zpl form (readable text); images through
 *            /png; everything else by fetching /NAME.EXT, which the
 *            server serves for some types (.BAT, .SHTML) and refuses
 *            for others (.NRD, .TTF).
 *   edit     .ZPL only, in the Label Editor -- it is the one type the
 *            web server will write back.
 *   print    file.print for stored formats. A format with fields is
 *            worth filling in first, so those hand over to Format
 *            Printer instead of printing blanks.
 *   run      file.run, for .BAT.
 *   delete   file.delete, which needs no password and removes the types
 *            the /delete CGI refuses.
 *
 * `setvar file.type` is the documented way to read a file and is no use
 * here: the contents go back to the port the command arrived on, and
 * that is not the HTTP request. Retested every way there is -- through
 * setvars.cgi, read back through the preprocessor, and from inside a
 * file.run -- and nothing ever arrives. printer.js has the detail.
 *
 * The listing comes from file.drive_listing rather than /dir. /dir is
 * far faster -- 0.14 s against nine seconds -- and unusable: it reports
 * any type it does not know as "---", losing the extension that decides
 * every button above, and it answers for one drive at a time. One
 * drive_listing read has the real names, sizes, dates, access flags and
 * all three drives at once, so it is read once and the header says so
 * while it happens.
 */

import {
  el,
  toast,
  confirmDialog,
  modal,
  debounce,
  formatBytes,
  replaceChildren,
  withPrinterPassword,
} from './ui.js';
import { printer, loadUnitPreference } from './state.js';
import {
  cachedDriveListing,
  driveListingError,
  driveListingLoading,
  driveListingStem,
  onDriveListing,
  refreshDriveListing,
  staleDriveListing,
} from './drives.js';
import {
  listFiles,
  fetchStoredFile,
  detokenizeZpl,
  readScript,
  saveScript,
  loadStoredImage,
  forgetStoredImage,
  printStoredFile,
  runStoredFile,
  deleteStoredFile,
  deleteFile,
  parseObjectName,
  renameStoredObject,
  writeStoredFile,
} from './printer.js';
import { decodeForEditing, encodeFromEditing, firstNul, UNSERVED_TYPES } from './filewrite.js';
import { pictureGrid, isPicture, askRename } from './gallery.js';
import { languageOf, parseFields } from './formats.js';
import { formatZpl } from './zpl.js';
import { openInEditor } from './editor.js';
import { openInFormat } from './format.js';
import { uploadImageDialog } from './imagedialog.js';
import { objectNameFrom } from './imageprep.js';

/** Types the printer will render for us, so View can show a picture. */
const FS_IMAGE_TYPES = ['PNG', 'GRF', 'BMP', 'PCX'];

/** Types worth offering a Print button for. */
const FS_PRINTABLE_TYPES = ['ZPL', 'LBL', 'FMT', 'EPL'];

/**
 * Drives to offer. One listing covers them all, so these filter what
 * has already been read rather than asking the printer again.
 */
const FS_DRIVES = [
  ['E', 'E: onboard flash'],
  ['R', 'R: RAM'],
  ['Z', 'Z: ROM (read-only)'],
  ['*', 'All drives'],
];

const fsState = {
  drive: 'E',
  /** Every file on every drive, as the last listing found them. */
  files: [],
  filter: '',
  loading: false,
  /** Set once a listing has landed, so returning to the tab is instant. */
  loaded: false,
  /** When the listing shown was read, so a copy already taken is not retaken. */
  listedAt: 0,
  /** Showing the pictures as thumbnails rather than every file as a row. */
  pictures: false,
};

let fsListNode = null;
let fsCountNode = null;
let fsNoticeNode = null;
let fsLoadingNode = null;
let fsDriveSelect = null;
let fsRefreshBtn = null;
let fsPicturesBtn = null;

/* ------------------------------------------------------------------ *
 * What a file is, and what can be done with it
 * ------------------------------------------------------------------ */

/** True for a type /dir could not name. */
export function fsIsUnknownType(otype) {
  return !otype || otype === '---' || otype === '?';
}

/**
 * What the buttons on a row should be, given the file.
 *
 * Everything here is a consequence of something measured against the
 * printer, so each answer carries the reason it is no: the row shows it
 * as the disabled button's tooltip rather than leaving the user to
 * wonder which of the four buttons vanished and why.
 */
export function fsCapabilities(file) {
  const otype = String(file.otype || '').toUpperCase();
  const unknown = fsIsUnknownType(otype);
  // Z: is the firmware's own drive. Everywhere else, the drive listing
  // reports per-file access when it has been read; before that, assume
  // writable rather than greying out buttons that do work.
  const readOnly = file.dev === 'Z' || (Boolean(file.access) && !file.access.includes('W'));

  const caps = { view: null, edit: null, download: null, print: null, run: null, delete: null };

  // The web server's path namespace is flat: a file is served as
  // /NAME.EXT whichever drive it is on, ROM included. Whether it will
  // part with a particular type is a different question, and one only
  // the request itself answers -- a .WML comes back, a .FNT is a 500 --
  // so View stays enabled and reports what the printer said.
  if (unknown) {
    caps.view = 'The printer did not report this file’s type, so there is no way to ask for it.';
  }
  caps.download = caps.view;

  // A .ZPL opens in the Label Editor; anything else the web server will
  // hand over opens as text, and is written back through file.append.
  if (unknown) {
    caps.edit = 'The printer did not report this file’s type.';
  } else if (readOnly) {
    caps.edit = 'This drive is read-only.';
  } else if (otype === 'ZPL') {
    caps.edit = null;
  } else if (FS_IMAGE_TYPES.includes(otype)) {
    caps.edit = 'A picture is replaced by uploading a new one (Upload…), not edited as text.';
  } else if (UNSERVED_TYPES.includes(otype)) {
    caps.edit = `The web server will not hand over a .${otype}, so there is nothing to edit; Upload… replaces it.`;
  } else if (file.dev === 'R') {
    caps.edit = 'Files on R: are not served over HTTP, so there is nothing to edit.';
  }

  if (!FS_PRINTABLE_TYPES.includes(otype)) {
    caps.print = unknown
      ? 'The printer did not report this file’s type.'
      : `A .${otype} is not a stored label format.`;
  }

  if (otype !== 'BAT') caps.run = `Only a .BAT can be run; this is a .${otype || '?'}.`;

  if (readOnly) caps.delete = 'This drive is read-only.';

  return caps;
}

/** A human label for the type column. */
function fsTypeLabel(file) {
  if (fsIsUnknownType(file.otype)) return 'unknown';
  return file.otype.toUpperCase();
}

const FS_TYPE_BADGE = {
  ZPL: 'bg-indigo-50 text-indigo-700',
  EPL: 'bg-indigo-50 text-indigo-700',
  FMT: 'bg-indigo-50 text-indigo-700',
  LBL: 'bg-indigo-50 text-indigo-700',
  BAT: 'bg-amber-50 text-amber-800',
  PNG: 'bg-emerald-50 text-emerald-700',
  GRF: 'bg-emerald-50 text-emerald-700',
  BMP: 'bg-emerald-50 text-emerald-700',
  PCX: 'bg-emerald-50 text-emerald-700',
  unknown: 'bg-ink-100 text-ink-500',
};

/* ------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------ */

/**
 * Show the drive listing, then ask for a fresh one.
 *
 * The listing is read once, shared with the other modes (drives.js), and
 * usually already there -- Settings reads it when its sweep is done. So
 * this shows that copy at once, and re-reads in the background: nine
 * seconds, during which the printer's web server answers nothing else,
 * which is why a copy under a minute old is left alone unless Refresh
 * forces it.
 */
async function fsRefresh({ force = false } = {}) {
  if (!driveListingStem()) {
    fsSetNotice(
      'This build has no helper file for file.drive_listing, so the filesystem cannot ' +
        'be listed. Re-deploy against this printer.',
      'warn',
    );
    return;
  }
  fsSync();
  // Failure is reported through fsSync, which every read calls back.
  await refreshDriveListing({ force }).catch(() => {});
}

/** Bring the tab up to date with the shared listing. */
function fsSync() {
  if (!fsListNode) return;
  const cached = cachedDriveListing();
  // Only a new listing replaces the rows: a delete made here since the
  // last read has already taken its row out, and must not bring it back.
  if (cached && cached.at !== fsState.listedAt) {
    fsState.files = [...cached.files].sort((a, b) => a.name.localeCompare(b.name));
    fsState.listedAt = cached.at;
    fsState.loaded = true;
  }
  fsState.loading = driveListingLoading();

  const err = driveListingError();
  if (err && !fsState.loading) {
    fsSetNotice(`The drive listing could not be read: ${err.message}`, 'warn');
  } else {
    fsSetNotice('');
  }
  fsRenderLoading();
  fsRenderList();
}

/** The spinner and its word, while the listing is on its way. */
function fsRenderLoading() {
  if (fsRefreshBtn) fsRefreshBtn.disabled = fsState.loading;
  if (!fsState.loading) {
    replaceChildren(fsLoadingNode, []);
    return;
  }
  replaceChildren(fsLoadingNode, [
    el('span', {
      class:
        'inline-block h-3 w-3 animate-spin rounded-full border-2 border-ink-300 border-t-ink-700',
      role: 'status',
      'aria-label': 'Loading',
    }),
    el('span', { class: 'text-[11px] text-ink-500' }, [
      fsState.loaded ? 'refreshing the drive listing…' : 'reading the drive listing…',
    ]),
  ]);
}

/**
 * The printer's web server answers one request at a time, and the drive
 * listing holds it for about nine seconds. A row's button pressed in that
 * window waits its turn (printer.js holds it back), so say why nothing
 * seems to happen.
 */
function fsNoteWait() {
  if (!driveListingLoading()) return;
  toast(
    'Waiting for the drive listing to finish — the printer answers one request at a time.',
    'info',
  );
}

function fsSetNotice(text, kind = 'info') {
  if (!text) {
    replaceChildren(fsNoticeNode, []);
    return;
  }
  replaceChildren(fsNoticeNode, [
    el(
      'p',
      {
        class:
          kind === 'warn'
            ? 'border-b border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900'
            : 'border-b border-ink-200 bg-ink-50 px-3 py-2 text-[12px] text-ink-600',
      },
      [text],
    ),
  ]);
}

function fsVisibleFiles() {
  const needle = fsState.filter.toLowerCase();
  return fsState.files.filter((file) => {
    if (fsState.drive !== '*' && file.dev !== fsState.drive) return false;
    if (fsState.pictures && !isPicture(file)) return false;
    return !needle || file.name.toLowerCase().includes(needle);
  });
}

function fsRenderList() {
  const files = fsVisibleFiles();
  const total = fsState.files.length;
  fsCountNode.textContent = !fsState.loaded
    ? ''
    : fsState.pictures
      ? `${files.length} picture${files.length === 1 ? '' : 's'}`
      : files.length === total
        ? `${total} file${total === 1 ? '' : 's'}`
        : `${files.length} of ${total} files`;

  if (!files.length) {
    // "No files" is a fact about a drive, not about a listing that has
    // not arrived yet -- nine seconds of the wrong answer reads as a
    // broken tab.
    const empty = fsState.loading
      ? 'Reading the drive listing…'
      : !fsState.loaded
        ? 'The drive listing has not been read yet.'
        : fsState.pictures
          ? 'No pictures here.'
          : total
            ? 'No files match this filter.'
            : 'This drive holds no files.';
    replaceChildren(fsListNode, [
      el('p', { class: 'px-3 py-6 text-center text-ink-400' }, [empty]),
    ]);
    return;
  }

  if (fsState.pictures) {
    replaceChildren(fsListNode, [
      el('div', { class: 'p-3' }, [pictureGrid(files, { actions: fsPictureActions })]),
    ]);
    return;
  }

  replaceChildren(fsListNode, [
    el('div', { class: 'divide-y divide-ink-100' }, files.map(fsBuildRow)),
  ]);
}

/** The buttons under a picture: what its row would offer, and Rename. */
function fsPictureActions(file) {
  const caps = fsCapabilities(file);
  const button = (label, reason, onclick, cls = 'btn-secondary btn-sm') =>
    el(
      'button',
      { class: `${cls} px-2`, disabled: Boolean(reason), title: reason || undefined, onclick },
      [label],
    );
  return [
    button('Download', caps.download, () => fsDownloadFile(file)),
    button('Rename', caps.delete, () => fsRenameFile(file)),
    button('Delete', caps.delete, () => fsDeleteFile(file), 'btn-danger btn-sm'),
  ];
}

/** Rename a stored object, and show what the printer then lists. */
async function fsRenameFile(file) {
  fsNoteWait();
  const target = await askRename(file, fsState.files);
  if (!target) return;
  const busy = toast(`Renaming ${file.name}…`, 'busy', { timeout: 0 });
  try {
    await renameStoredObject(file, target.oname);
    const old = { ...file };
    file.oname = target.oname;
    file.name = target.name;
    staleDriveListing();
    fsRenderList();
    // renameStoredObject saw the copy; this checks the original went.
    if (await fsStillThere(old)) {
      busy.update(`Copied to ${target.name}, but the printer kept ${old.name} too.`, 'error');
      fsRefresh({ force: true });
      return;
    }
    busy.update(`Renamed ${old.name} to ${target.name}.`, 'success');
  } catch (err) {
    busy.update(`Could not rename it: ${err.message}`, 'error');
  }
}

function fsBuildRow(file) {
  const caps = fsCapabilities(file);
  const typeText = fsTypeLabel(file);

  const button = (label, reason, onClick, extraClass = 'btn-secondary btn-sm') =>
    el(
      'button',
      {
        class: extraClass,
        disabled: Boolean(reason),
        title: reason || undefined,
        onclick: onClick,
      },
      [label],
    );

  const meta = [file.bytes ? formatBytes(file.bytes) : null, file.date || null]
    .filter(Boolean)
    .join('  ·  ');

  return el('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2' }, [
    el('div', { class: 'min-w-0 flex-1' }, [
      el('div', { class: 'flex items-center gap-2' }, [
        el('span', { class: 'truncate font-mono text-[12px] text-ink-900' }, [file.name]),
        el(
          'span',
          { class: `pill shrink-0 ${FS_TYPE_BADGE[typeText] || 'bg-ink-100 text-ink-600'}` },
          [typeText],
        ),
      ]),
      meta ? el('div', { class: 'text-[11px] text-ink-400' }, [meta]) : null,
    ]),
    el('div', { class: 'flex shrink-0 flex-wrap items-center gap-1.5' }, [
      button('View', caps.view, () => fsViewFile(file)),
      button('Edit', caps.edit, () =>
        String(file.otype).toUpperCase() === 'ZPL' ? fsEditFile(file) : fsEditTextFile(file),
      ),
      button('Download', caps.download, () => fsDownloadFile(file)),
      caps.print === null ? button('Print', null, () => fsPrintFile(file)) : null,
      caps.run === null ? button('Run', null, () => fsRunFile(file)) : null,
      button('Delete', caps.delete, () => fsDeleteFile(file), 'btn-danger btn-sm'),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * View
 * ------------------------------------------------------------------ */

/**
 * Whether a file is better shown as bytes than as text.
 *
 * Counting control characters is enough, but two kinds have to be
 * forgiven or every interesting file looks binary: 0x1e and 0x1f are
 * how a stored ZPL keeps its ^ and , separators, and a .BAT is escape
 * sequences by definition. Trailing NULs are padding, not content.
 */
export function fsLooksBinary(bytes) {
  let end = Math.min(bytes.length, 512);
  while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 10 || bytes[end - 1] === 13)) end--;
  if (!end) return false;

  let odd = 0;
  for (let i = 0; i < end; i++) {
    const byte = bytes[i];
    if (byte === 0x1e || byte === 0x1f || byte === 0x1b) continue;
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte > 126) odd++;
  }
  return odd > end / 8;
}

/**
 * Bytes as text a person can read: the printer's own encoding, ZPL put
 * back together, and anything still unprintable shown as its hex escape
 * rather than as nothing at all -- a .BAT is mostly ESC sequences, and
 * a pre element would simply swallow them.
 */
export function fsToDisplayText(bytes) {
  const text = detokenizeZpl(new TextDecoder('windows-1252').decode(bytes));
  return text.replace(
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
    (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'),
  );
}

/** A hex dump, for the files that are not text. */
export function fsHexDump(bytes, limit = 1024) {
  const lines = [];
  const end = Math.min(bytes.length, limit);
  for (let i = 0; i < end; i += 16) {
    const chunk = bytes.subarray(i, Math.min(i + 16, end));
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const text = [...chunk]
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${text}`);
  }
  if (bytes.length > end) lines.push(`… ${bytes.length - end} more bytes`);
  return lines.join('\n');
}

/**
 * Read a file as text, whichever way its type allows.
 *
 * A .ZPL is stored tokenized (^ as 0x1e, , as 0x1f, no line breaks), so
 * the /zpl form -- which hands back the readable original -- is tried
 * first and the raw file is the fallback.
 */
async function fsReadText(file) {
  if (file.otype === 'ZPL') {
    try {
      // /zpl hands back the commands but barely any line breaks: most
      // of a label arrives as one long line, comments and all.
      return formatZpl(await readScript({ dev: file.dev, oname: file.oname, otype: 'ZPL' }));
    } catch (err) {
      /* fall through to the file itself */
    }
  }
  const bytes = await fetchStoredFile(file);
  if (fsLooksBinary(bytes)) return { binary: bytes };
  return fsToDisplayText(bytes);
}

async function fsViewFile(file) {
  fsNoteWait();
  const otype = String(file.otype).toUpperCase();
  const busy = toast(`Reading ${file.name}…`, 'busy', { timeout: 0 });

  let body;
  try {
    if (FS_IMAGE_TYPES.includes(otype)) {
      forgetStoredImage(file.name);
      const url = await loadStoredImage({ dev: file.dev, oname: file.oname, otype });
      body = el(
        'div',
        { class: 'flex justify-center rounded border border-ink-200 bg-ink-50 p-2' },
        [
          el('img', {
            class: 'max-h-[60vh] max-w-full bg-white ring-1 ring-ink-300',
            style: 'image-rendering:pixelated;',
            src: url,
            alt: file.name,
          }),
        ],
      );
    } else {
      const text = await fsReadText(file);
      body =
        text && text.binary
          ? el('div', { class: 'space-y-2' }, [
              el('p', { class: 'text-[12px] text-ink-500' }, [
                'This file is not text, so it is shown as bytes.',
              ]),
              el(
                'pre',
                {
                  class:
                    'max-h-[55vh] overflow-auto rounded bg-ink-50 px-3 py-2 font-mono text-[11px] leading-snug text-ink-700',
                },
                [fsHexDump(text.binary)],
              ),
            ])
          : el(
              'pre',
              {
                class:
                  'max-h-[60vh] overflow-auto rounded bg-ink-50 px-3 py-2 font-mono text-[11px] leading-snug text-ink-700',
              },
              [text || '(empty file)'],
            );
    }
    busy.close();
  } catch (err) {
    busy.update(`Could not read ${file.name}: ${err.message}`, 'error', { timeout: 8000 });
    return;
  }

  await modal(file.name, (close) =>
    el('div', { class: 'space-y-3' }, [
      body,
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Close']),
      ]),
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * Download
 * ------------------------------------------------------------------ */

/**
 * Hand the file to the browser to save.
 *
 * What gets saved is what the file is, with one deliberate exception: a
 * stored .ZPL is tokenized on the printer (^ as 0x1e, no line breaks),
 * and saving that would give you a file no editor will open. So a .ZPL
 * is saved as the ZPL the /zpl form hands back, laid out one field to a
 * line -- the form's own output runs most of a label together on one.
 */
async function fsDownloadFile(file) {
  fsNoteWait();
  const busy = toast(`Fetching ${file.name}…`, 'busy', { timeout: 0 });

  let blob;
  try {
    if (file.otype === 'ZPL') {
      const text = formatZpl(await readScript({ dev: file.dev, oname: file.oname, otype: 'ZPL' }));
      blob = new Blob([text], { type: 'text/plain' });
    } else {
      const bytes = await fetchStoredFile(file);
      blob = new Blob([bytes], { type: 'application/octet-stream' });
    }
  } catch (err) {
    busy.update(`Could not fetch ${file.name}: ${err.message}`, 'error', { timeout: 8000 });
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `${file.oname}.${file.otype}` });
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser the moment it needs to start the save before the
  // object URL stops pointing at anything.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  busy.update(`Saved ${file.oname}.${file.otype}`, 'success');
}

/* ------------------------------------------------------------------ *
 * Edit, print, run, delete
 * ------------------------------------------------------------------ */

function fsEditFile(file) {
  openInEditor({ dev: file.dev, oname: file.oname });
  location.hash = '#editor';
}

/**
 * Print a stored format.
 *
 * A format with fields in it prints blanks if it is simply recalled, so
 * anything that turns out to have fields is handed to Stored Formats
 * with its source, rather than sent straight to the platen. Source we
 * could not read is not a reason to refuse: file.print still works, and
 * the confirmation says what is about to happen.
 */
async function fsPrintFile(file) {
  fsNoteWait();
  const lang = languageOf(file.otype);
  const busy = toast(`Looking at ${file.name}…`, 'busy', { timeout: 0 });

  let source = '';
  try {
    source =
      file.otype === 'ZPL'
        ? await readScript({ dev: file.dev, oname: file.oname, otype: 'ZPL' })
        : await fsReadSourceText(file);
  } catch (err) {
    source = '';
  }
  busy.close();

  const fields = lang && source ? parseFields(lang, source) : [];
  if (fields.length) {
    toast(
      `${file.name} has ${fields.length} ${lang.fieldNoun}${fields.length === 1 ? '' : 's'} to fill in.`,
      'info',
    );
    openInFormat(file, source);
    location.hash = '#format';
    return;
  }

  const ok = await confirmDialog(
    'Print this file?',
    `The printer will be told to print ${file.name}` +
      (source ? ' as it stands; it has no fields to fill in.' : '.'),
    'Print',
  );
  if (!ok) return;

  try {
    await printStoredFile(file.name);
    toast(`Told the printer to print ${file.name}.`, 'success');
  } catch (err) {
    toast(`Could not print ${file.name}: ${err.message}`, 'error');
  }
}

/** The source of a non-ZPL format, if the web server will part with it. */
async function fsReadSourceText(file) {
  const bytes = await fetchStoredFile(file);
  if (fsLooksBinary(bytes)) return '';
  return fsToDisplayText(bytes);
}

/**
 * Run a .BAT.
 *
 * A batch file is a list of commands the printer runs against itself --
 * it can change settings, print, or reset the thing -- and there is no
 * way to see what it did afterwards, so this asks first and shows the
 * contents while it does.
 */
async function fsRunFile(file) {
  fsNoteWait();
  let preview = '';
  try {
    const text = await fsReadSourceText(file);
    preview = text.slice(0, 600);
  } catch (err) {
    preview = '';
  }

  const ok = await modal('Run this batch file?', (close) =>
    el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-ink-700' }, [
        `${file.name} will be run by the printer. A batch file can change settings, print labels ` +
          'or restart the printer, and reports nothing back.',
      ]),
      preview
        ? el(
            'pre',
            {
              class:
                'max-h-48 overflow-auto rounded bg-ink-50 px-3 py-2 font-mono text-[11px] leading-snug text-ink-700',
            },
            [preview],
          )
        : el('p', { class: 'text-[12px] text-ink-400' }, ['Its contents could not be read first.']),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(false) }, ['Cancel']),
        el('button', { class: 'btn-danger', onclick: () => close(true) }, ['Run']),
      ]),
    ]),
  );
  if (ok !== true) return;

  try {
    await runStoredFile(file.name);
    toast(`Told the printer to run ${file.name}.`, 'success');
  } catch (err) {
    toast(`Could not run ${file.name}: ${err.message}`, 'error');
  }
}

/**
 * Delete a file.
 *
 * file.delete is tried first: it needs no password and removes types the
 * /delete CGI refuses (anything listed as "---", and .NRD). Neither
 * route reports success, so the listing is the proof -- and if the file
 * is still there, the CGI gets a turn with the password.
 */
async function fsDeleteFile(file) {
  fsNoteWait();
  const ok = await confirmDialog(
    'Delete this file?',
    `${file.name} will be removed from the printer. This cannot be undone.`,
    'Delete',
  );
  if (!ok) return;

  const busy = toast(`Deleting ${file.name}…`, 'busy', { timeout: 0 });
  try {
    await deleteStoredFile(file.name);
    if (await fsStillThere(file)) {
      await withPrinterPassword((password) =>
        deleteFile({
          dev: file.dev,
          oname: file.oname,
          otype: file.otype,
          password,
        }),
      );
      if (await fsStillThere(file)) {
        busy.update(`The printer kept ${file.name}.`, 'error');
        return;
      }
    }
    forgetStoredImage(file.name);
    busy.update(`Deleted ${file.name}`, 'success');
    fsRenderList();
  } catch (err) {
    if (err.cancelled) busy.update(`${file.name} was not deleted.`, 'info');
    else busy.update(`Delete failed: ${err.message}`, 'error');
  }
}

/** Re-list the drive and say whether the file survived, dropping it if not. */
async function fsStillThere(file) {
  const files = await listFiles({ dev: file.dev, otype: '*  ' });
  const survived = files.some((f) => f.dev === file.dev && f.oname === file.oname);
  if (!survived) {
    fsState.files = fsState.files.filter((f) => f !== file);
    staleDriveListing();
  }
  return survived;
}

/* ------------------------------------------------------------------ *
 * Upload
 *
 * What a browser can put on the printer is decided by what the web
 * server will accept, and it is a short list. The /zpl form writes a
 * .ZPL (and only a .ZPL: it runs the text through the ZPL parser, so
 * anything else arrives mangled or empty). ~DY through the same form
 * stores a graphic, which is how a picture gets there -- as a .GRF,
 * one bit per pixel, converted in the browser. A .PNG cannot be stored
 * this way at all: ~DY reports success and writes nothing.
 *
 * Everything else -- .BAT, .TXT, .EPL, .FMT, .TTF, .SHTML -- needs the
 * CISDFCRC16 download header on port 9100, which a page cannot open.
 * tools/upload.mjs does exactly that from a computer on the network.
 * ------------------------------------------------------------------ */

/**
 * Which upload route suits the file picked: a picture is converted to a
 * one-bit .GRF; a .ZPL goes through the label form, which stores it the
 * way the Label Editor's labels are stored; everything else is written
 * as it is, through file.append (writeStoredFile).
 */
export function fsUploadRoute(filename, mimeType = '') {
  const dot = String(filename).lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1).toUpperCase() : '';
  if (String(mimeType).startsWith('image/')) return { route: 'image', ext };
  if (ext === 'PNG' || ext === 'JPG' || ext === 'JPEG' || ext === 'GIF' || ext === 'BMP') {
    return { route: 'image', ext };
  }
  if (ext === 'ZPL') return { route: 'zpl', ext };
  return { route: 'file', ext };
}

function fsUploadPicker() {
  const input = el('input', { type: 'file', class: 'hidden' });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) await fsHandlePickedFile(file);
  });
  return input;
}

async function fsHandlePickedFile(file) {
  const { route, ext } = fsUploadRoute(file.name, file.type);

  if (route === 'image') {
    // The image dialog converts to one bit and stores a .GRF; it only
    // wants a document for its unit and a sensible default width.
    const stored = await uploadImageDialog({
      doc: { unit: loadUnitPreference(), width: printer.dpi * 4 },
    });
    if (stored) await fsRefresh({ force: true });
    return;
  }

  if (route === 'zpl') {
    await fsUploadTextFile(file);
    return;
  }

  await fsUploadAnyFile(file, ext);
}

/*
 * Any other file, written as it is (writeStoredFile). The printer ends a
 * file written this way at the first NUL byte, so a file with one is
 * turned away before anything is sent, with where else it can go.
 */
async function fsUploadAnyFile(file, ext) {
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    toast(`Could not read ${file.name}: ${err.message}`, 'error');
    return;
  }
  const nul = firstNul(bytes);
  if (nul !== -1) {
    await modal('This file cannot be stored from a browser', (close) =>
      el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-ink-700' }, [
          `${file.name} has a NUL byte (at byte ${nul + 1}). The printer stores files from a ` +
            'browser through a setting, and a setting ends at the first NUL -- so a font, a ' +
            'PNG or any other binary file cannot go this way. (A picture can: Upload converts ' +
            'it to a one-bit .GRF.)',
        ]),
        el('p', { class: 'text-ink-600' }, ['From a computer on the same network:']),
        el(
          'pre',
          {
            class: 'overflow-auto rounded bg-ink-50 px-3 py-2 font-mono text-[11px] text-ink-700',
          },
          [
            `node tools/upload.mjs ${printer.ip || '<printer-ip>'} ${file.name} E:${objectNameFrom(file.name)}.${ext || 'EXT'}`,
          ],
        ),
        el('div', { class: 'flex justify-end gap-2' }, [
          el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Close']),
        ]),
      ]),
    );
    return;
  }
  const target = await fsAskFileName({
    title: 'Upload to the printer',
    detail: `${file.name} — ${formatBytes(bytes.length)}, stored exactly as it is.`,
    suggested: `${objectNameFrom(file.name)}.${ext || 'TXT'}`,
    confirm: 'Upload',
  });
  if (target) await fsStoreBytes(target, bytes);
}

/**
 * Ask for the name to store a file under: NAME.EXT on E:, the name up to
 * 16 letters, digits and underscores. Resolves to { oname, otype } or null.
 */
function fsAskFileName({ title, detail, suggested, confirm }) {
  return modal(title, (close) => {
    const input = el('input', {
      class: 'field field-mono',
      type: 'text',
      value: suggested,
      spellcheck: 'false',
      autocomplete: 'off',
    });
    const error = el('p', { class: 'text-[12px] text-red-700' });
    const submit = () => {
      const { oname, otype } = parseObjectName(input.value, 'TXT');
      if (!oname) {
        error.textContent = 'Give it a name: letters, digits or underscores.';
        return;
      }
      close({ oname, otype });
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    return el('div', { class: 'space-y-3' }, [
      detail ? el('p', { class: 'text-ink-600' }, [detail]) : null,
      el('label', { class: 'block space-y-1' }, [
        el('span', { class: 'label-text' }, ['Name on the printer (E:)']),
        input,
      ]),
      error,
      el('p', { class: 'text-[11px] text-ink-400' }, [
        'Up to 16 letters, digits and underscores, then the extension. A file of that name is ' +
          'replaced -- only once the new one has been written and checked.',
      ]),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Cancel']),
        el('button', { class: 'btn-primary', onclick: submit }, [confirm]),
      ]),
    ]);
  });
}

/** Write bytes to E:<oname>.<otype>, saying how it goes; true once stored. */
async function fsStoreBytes({ dev = 'E', oname, otype }, bytes) {
  const name = `${dev}:${oname}.${otype}`;
  fsNoteWait();
  const busy = toast(`Storing ${name}…`, 'busy', { timeout: 0 });
  try {
    const { verified } = await writeStoredFile({
      dev,
      oname,
      otype,
      bytes,
      onProgress: (sent, total) =>
        busy.update(`Storing ${name}… ${formatBytes(sent)} of ${formatBytes(total)}`, 'busy', {
          timeout: 0,
        }),
    });
    busy.update(
      verified
        ? `Stored ${name}, ${formatBytes(bytes.length)}, read back and checked.`
        : `Stored ${name}. The printer does not serve a .${otype}, so it could not be read back.`,
      'success',
    );
    staleDriveListing();
    await fsRefresh({ force: true });
    return true;
  } catch (err) {
    busy.update(`Could not store ${name}: ${err.message}`, 'error', { timeout: 10000 });
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Edit as text, and New file
 *
 * Anything the web server will hand over can be edited here and written
 * back through file.append. A UTF-8 file is edited as UTF-8; anything
 * else keeps one character to a byte, so a .BAT's escape sequences and
 * high bytes come back as they were (filewrite.js).
 * ------------------------------------------------------------------ */

/** The editing dialog: resolves to the text to save, or null. */
function fsTextEditor({ title, text, note }) {
  return modal(
    title,
    (close) => {
      const area = el('textarea', {
        class: 'field field-mono h-[55vh] w-full resize-y whitespace-pre text-[12px] leading-snug',
        spellcheck: 'false',
        autocomplete: 'off',
        wrap: 'off',
        'aria-label': 'File contents',
      });
      area.value = text;
      const size = el('span', { class: 'text-[11px] text-ink-400' });
      const sync = () => {
        size.textContent = `${area.value.split('\n').length} lines`;
      };
      area.addEventListener('input', sync);
      area.addEventListener('keydown', (event) => {
        // Tab is a character in most of these files, not a way out.
        if (event.key === 'Tab' && !event.shiftKey) {
          event.preventDefault();
          area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
          sync();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          close(area.value);
        }
      });
      sync();
      setTimeout(() => area.focus(), 0);
      return el('div', { class: 'space-y-2' }, [
        note ? el('p', { class: 'text-[12px] text-ink-500' }, [note]) : null,
        area,
        el('div', { class: 'flex items-center justify-end gap-2' }, [
          size,
          el('span', { class: 'mr-auto text-[11px] text-ink-400' }, ['Ctrl+S saves']),
          el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Cancel']),
          el('button', { class: 'btn-primary', onclick: () => close(area.value) }, ['Save']),
        ]),
      ]);
    },
    { wide: true },
  );
}

/** Edit any served, non-binary file as text, and store it back. */
async function fsEditTextFile(file) {
  fsNoteWait();
  const busy = toast(`Reading ${file.name}…`, 'busy', { timeout: 0 });
  let bytes;
  try {
    bytes = await fetchStoredFile(file);
    busy.close();
  } catch (err) {
    busy.update(`Could not read ${file.name}: ${err.message}`, 'error', { timeout: 8000 });
    return;
  }
  if (firstNul(bytes) !== -1) {
    toast(
      `${file.name} is a binary file (it has NUL bytes), which cannot be written back from a browser.`,
      'error',
      { timeout: 8000 },
    );
    return;
  }
  const { text, encoding } = decodeForEditing(bytes);
  let draft = text;
  for (;;) {
    const edited = await fsTextEditor({
      title: `Edit ${file.name}`,
      text: draft,
      note:
        `${formatBytes(bytes.length)}, ` +
        (encoding === 'utf-8' ? 'UTF-8 text.' : 'one byte to a character (not UTF-8).') +
        ' Saving writes it back and checks it before replacing the stored file.',
    });
    if (edited === null || edited === text) return;
    draft = edited;
    let out;
    try {
      out = encodeFromEditing(edited, encoding);
    } catch (err) {
      toast(err.message, 'error', { timeout: 8000 });
      continue;
    }
    if (await fsStoreBytes({ dev: file.dev, oname: file.oname, otype: file.otype }, out)) return;
  }
}

/** Write a new file from scratch: a name, then the editor. */
async function fsNewFile() {
  const target = await fsAskFileName({
    title: 'New file',
    detail:
      'Any type: a .WML menu, an EPL or CPCL format, a .BAT, a .TXT... It is written ' +
      'through file.append, as text.',
    suggested: 'NEWFILE.TXT',
    confirm: 'Next',
  });
  if (!target) return;
  let draft = '';
  for (;;) {
    const text = await fsTextEditor({
      title: `New file E:${target.oname}.${target.otype}`,
      text: draft,
    });
    if (text === null) return;
    draft = text;
    if (await fsStoreBytes(target, new TextEncoder().encode(text))) return;
  }
}

/**
 * Store a .ZPL through the label form, as the Label Editor saves one: the
 * printer tokenizes it on the way in, the form it reads back from.
 */
async function fsUploadTextFile(file) {
  let text;
  try {
    text = await file.text();
  } catch (err) {
    toast(`Could not read ${file.name}: ${err.message}`, 'error');
    return;
  }

  const suggested = `${objectNameFrom(file.name)}.ZPL`;
  const target = await modal('Upload to the printer', (close) => {
    const nameInput = el('input', {
      class: 'field field-mono',
      type: 'text',
      maxlength: '16',
      value: suggested,
      onkeydown: (event) => {
        if (event.key === 'Enter') close(nameInput.value);
      },
    });
    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-ink-600' }, [`${file.name} — ${formatBytes(file.size)}`]),
      el('label', { class: 'block space-y-1' }, [
        el('span', { class: 'label-text' }, ['Object name']),
        nameInput,
      ]),
      el('p', { class: 'text-[11px] text-ink-400' }, [
        'Upper case, up to 16 characters. An existing file of that name is overwritten.',
      ]),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Cancel']),
        el('button', { class: 'btn-primary', onclick: () => close(nameInput.value) }, ['Upload']),
      ]),
    ]);
  });

  if (!target) return;
  const { oname, otype } = parseObjectName(target, 'ZPL');
  if (!oname) {
    toast('That name has no usable characters.', 'error');
    return;
  }

  const busy = toast(`Uploading ${oname}.${otype}…`, 'busy', { timeout: 0 });
  try {
    await withPrinterPassword((password) =>
      saveScript({
        dev: 'E',
        oname,
        otype,
        data: text,
        password,
      }),
    );
    busy.update(`Stored E:${oname}.${otype}`, 'success');
    await fsRefresh({ force: true });
  } catch (err) {
    busy.close();
    if (!err.cancelled) toast(`Upload failed: ${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export function mountFiles(panel) {
  const filterInput = el('input', {
    class: 'field w-full sm:w-64',
    type: 'search',
    placeholder: 'Filter by name…',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  filterInput.addEventListener(
    'input',
    debounce(() => {
      fsState.filter = filterInput.value.trim();
      fsRenderList();
    }, 120),
  );

  fsDriveSelect = el(
    'select',
    { class: 'field w-auto' },
    FS_DRIVES.map(([value, label]) =>
      el('option', { value, selected: value === fsState.drive }, [label]),
    ),
  );
  fsDriveSelect.addEventListener('change', () => {
    fsState.drive = fsDriveSelect.value;
    // One listing covers every drive, so this is a filter, not a re-read.
    fsRenderList();
  });

  const picker = fsUploadPicker();
  const newFileBtn = el(
    'button',
    {
      class: 'btn-secondary btn-sm',
      title: 'Write a new file of any type, as text',
      onclick: () => fsNewFile(),
    },
    ['New file…'],
  );
  const uploadBtn = el(
    'button',
    {
      class: 'btn-primary btn-sm',
      onclick: () => picker.click(),
    },
    ['Upload…'],
  );

  fsRefreshBtn = el(
    'button',
    {
      class: 'btn-secondary btn-sm',
      onclick: () => fsRefresh({ force: true }),
    },
    ['Refresh'],
  );
  fsPicturesBtn = el(
    'button',
    {
      class: 'btn-secondary btn-sm',
      'aria-pressed': 'false',
      title: 'Show the pictures as thumbnails',
      onclick: () => {
        fsState.pictures = !fsState.pictures;
        fsPicturesBtn.setAttribute('aria-pressed', String(fsState.pictures));
        fsPicturesBtn.className = fsState.pictures ? 'btn-primary btn-sm' : 'btn-secondary btn-sm';
        fsRenderList();
      },
    },
    ['Pictures'],
  );
  fsCountNode = el('span', { class: 'text-[11px] text-ink-500' });
  fsLoadingNode = el('span', { class: 'flex items-center gap-1.5' });
  fsNoticeNode = el('div');
  fsListNode = el('div');

  panel.append(
    el('div', { class: 'card overflow-hidden' }, [
      el('div', { class: 'toolbar' }, [
        fsDriveSelect,
        filterInput,
        fsPicturesBtn,
        picker,
        el('div', { class: 'ml-auto flex items-center gap-3' }, [
          fsLoadingNode,
          fsCountNode,
          newFileBtn,
          uploadBtn,
          fsRefreshBtn,
        ]),
      ]),
      fsNoticeNode,
      fsListNode,
    ]),
  );

  onDriveListing(fsSync);
  fsRefresh();
}

/**
 * Coming back to the tab shows what was already read, and re-reads it
 * in the background if that copy is more than a minute old. Refresh
 * forces a read, and the actions that change the filesystem re-read it
 * themselves.
 */
export function onFilesShown() {
  fsRefresh();
}
