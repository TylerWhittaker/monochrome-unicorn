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
 * format.js -- Mode 3: fill in the fields of a stored label format.
 *
 * Works in every label language the printer stores formats in, not just
 * ZPL. What the console can do varies by language, and only because the
 * printer's web server varies -- formats.js has the measured matrix. In
 * short:
 *
 *   ZPL   read the format, find its ^FN fields, preview and print.
 *   EPL   the web server will not hand over the file, so the fields are
 *         described by hand (or by pasting the source); print only.
 *   CPCL  same, and /dir does not even report the real extension, so
 *         finding these is a separate and slower scan.
 */

import { el, toast, confirmDialog, debounce, formatBytes, replaceChildren, modal } from './ui.js';
import { printer } from './state.js';
import { listFiles, readScript, readSlowSetting } from './printer.js';
import {
  LANGUAGES,
  FORMAT_OTYPES,
  languageOf,
  printerSpeaks,
  parseFields,
  blankFields,
  buildRecall,
} from './formats.js';
import { createPreview } from './preview.js';

const formatState = {
  formats: [],
  current: null,
  lang: null,
  source: '',
  /** True once we have real source, from the printer or from the user. */
  sourceRead: false,
  fields: [],
  values: new Map(),
  copies: 1,
};

let formatSelect = null;
/** A format another mode asked for, waiting for this one to exist. */
let pendingFormat = null;
let fieldsHost = null;
let sourceHost = null;
let noticeHost = null;
let formatPreview = null;
let printBtn = null;
let summaryNode = null;
let scanBtn = null;

/* ------------------------------------------------------------------ *
 * The command stream for the current state
 * ------------------------------------------------------------------ */

function recallZpl() {
  if (!formatState.current || !formatState.lang) return '';
  return buildRecall(
    formatState.lang,
    formatState.current,
    formatState.fields,
    formatState.values,
    { copies: formatState.copies },
  );
}

const scheduleFormatPreview = debounce(() => {
  if (formatState.current && formatState.lang.previewable) formatPreview.update(recallZpl());
}, 600);

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderNotice() {
  const { current, lang, sourceRead } = formatState;
  if (!current) {
    replaceChildren(noticeHost, []);
    return;
  }

  const notes = [];
  const mode = printer.boot['device.languages'];

  if (!printerSpeaks(lang, mode)) {
    notes.push([
      'warn',
      `This printer is set to ${mode || 'an unknown language'}, which does not parse ${lang.label}. ` +
        'Sending this format will most likely print nothing. device.languages is in Printer Settings.',
    ]);
  }

  if (!sourceRead) {
    notes.push([
      'info',
      `The web server will not return the contents of a ${lang.label} file, so its ` +
        `${lang.fieldNoun}s cannot be found automatically. Set how many there are, or paste the ` +
        'source and they will be read from that.',
    ]);
  }

  if (!lang.previewable) {
    notes.push([
      'info',
      `The printer only renders ZPL previews, so there is none for ${lang.label}. Printing still works.`,
    ]);
  }

  replaceChildren(
    noticeHost,
    notes.map(([kind, text]) =>
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
    ),
  );
}

/** How many fields a format we could not read has. */
function countInput() {
  const input = el('input', {
    class: 'field field-mono w-16',
    type: 'number',
    min: '0',
    max: '99',
    value: String(formatState.fields.length),
  });
  input.addEventListener('change', () => {
    const count = Math.min(99, Math.max(0, Math.round(Number(input.value) || 0)));
    input.value = String(count);
    const previous = formatState.values;
    formatState.fields = blankFields(formatState.lang, count);
    formatState.values = new Map(formatState.fields.map((f) => [f.key, previous.get(f.key) ?? '']));
    renderFields();
    renderSummary();
  });
  return input;
}

function renderFields() {
  if (!formatState.current) {
    replaceChildren(fieldsHost, [
      el('p', { class: 'px-3 py-6 text-center text-ink-400' }, [
        'Choose a stored format to fill in.',
      ]),
    ]);
    printBtn.disabled = true;
    return;
  }

  printBtn.disabled = false;
  const { lang, fields } = formatState;

  const controls = el(
    'div',
    {
      class: 'flex flex-wrap items-center gap-3 border-b border-ink-200 px-3 py-2',
    },
    [
      el('span', { class: 'text-[11px] uppercase tracking-wide text-ink-500' }, [
        `${lang.label} format`,
      ]),
      !formatState.sourceRead &&
        el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, [
          `${lang.fieldNoun}s`,
          countInput(),
        ]),
      !formatState.sourceRead &&
        el(
          'button',
          {
            class: 'btn-secondary btn-sm',
            onclick: () => pasteSourceDialog(),
          },
          ['Paste source…'],
        ),
    ].filter(Boolean),
  );

  if (fields.length === 0) {
    replaceChildren(fieldsHost, [
      controls,
      el('div', { class: 'px-3 py-6 text-center' }, [
        el('p', { class: 'text-ink-500' }, [
          formatState.sourceRead
            ? `This format has no ${lang.fieldNoun}s, so there is nothing to fill in.`
            : `Set how many ${lang.fieldNoun}s this format has, or paste its source.`,
        ]),
        el('p', { class: 'mt-1 text-[11px] text-ink-400' }, [
          'You can still send it to the printer as it stands.',
        ]),
      ]),
    ]);
    return;
  }

  const rows = fields.map((field) => {
    const input = el('input', {
      class: 'field',
      type: 'text',
      value: formatState.values.get(field.key) ?? '',
      placeholder: field.initial ? `default: ${field.initial}` : '',
      autocomplete: 'off',
    });
    if (field.maxLength) input.maxLength = field.maxLength;

    input.addEventListener('input', () => {
      formatState.values.set(field.key, input.value);
      scheduleFormatPreview();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      // Enter walks the fields, and prints from the last one.
      const inputs = [...fieldsHost.querySelectorAll('input[type="text"]')];
      const next = inputs[inputs.indexOf(input) + 1];
      if (next) next.focus();
      else printFormatLabel();
    });

    return el('label', { class: 'block space-y-1 px-3 py-2' }, [
      el('span', { class: 'label-text' }, [field.label]),
      input,
    ]);
  });

  replaceChildren(fieldsHost, [
    controls,
    el('div', { class: 'divide-y divide-ink-100' }, rows),
    el(
      'div',
      { class: 'flex items-center justify-between gap-3 border-t border-ink-200 px-3 py-2' },
      [
        el(
          'button',
          {
            class: 'btn-secondary btn-sm',
            onclick: () => {
              for (const field of formatState.fields) {
                formatState.values.set(field.key, field.initial || '');
              }
              renderFields();
              scheduleFormatPreview();
            },
          },
          ['Reset to defaults'],
        ),
        lang.previewable
          ? el(
              'button',
              {
                class: 'btn-secondary btn-sm',
                onclick: () => formatPreview.update(recallZpl()),
              },
              ['Preview now'],
            )
          : el('span', { class: 'text-[11px] text-ink-400' }, [`no preview for ${lang.label}`]),
      ],
    ),
  ]);
}

/**
 * The console cannot read an EPL or CPCL file, but the user may well
 * have the source to hand; parsing what they paste gives them the same
 * labelled fields ZPL gets for free.
 */
async function pasteSourceDialog() {
  const lang = formatState.lang;
  const pasted = await modal(`Paste ${lang.label} source`, (close) => {
    const area = el(
      'textarea',
      {
        class: 'field field-mono w-full',
        rows: '10',
        spellcheck: 'false',
        placeholder: lang.help,
      },
      [formatState.source || ''],
    );
    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-ink-600' }, [
        `The ${lang.fieldNoun}s will be read from this. Nothing is sent to the printer.`,
      ]),
      area,
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Cancel']),
        el('button', { class: 'btn-primary', onclick: () => close(area.value) }, ['Read fields']),
      ]),
    ]);
  });

  if (pasted === null) return;
  applySource(pasted, false);
  renderNotice();
  renderFields();
  renderSource();
  renderSummary();
  toast(`Found ${formatState.fields.length} ${lang.fieldNoun}(s).`, 'success');
}

function applySource(source, fromPrinter) {
  formatState.source = source || '';
  formatState.sourceRead = Boolean(fromPrinter) || Boolean(source);
  formatState.fields = parseFields(formatState.lang, source);
  formatState.values = new Map(formatState.fields.map((f) => [f.key, f.initial || '']));
}

function renderSource() {
  if (!formatState.current || !formatState.source) {
    replaceChildren(sourceHost, []);
    return;
  }
  replaceChildren(sourceHost, [
    el('details', { class: 'border-t border-ink-200' }, [
      el('summary', { class: 'cursor-pointer px-3 py-2 text-[12px] text-ink-600' }, [
        'Format source',
      ]),
      el(
        'pre',
        {
          class:
            'max-h-64 overflow-auto bg-ink-50 px-3 py-2 font-mono text-[11px] leading-snug text-ink-700',
        },
        [formatState.source],
      ),
    ]),
  ]);
}

function renderSummary() {
  if (!formatState.current) {
    summaryNode.textContent = '';
    return;
  }
  const count = formatState.fields.length;
  const noun = formatState.lang.fieldNoun;
  summaryNode.textContent = `${formatState.lang.label} · ${count} ${noun}${count === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ *
 * Finding formats
 * ------------------------------------------------------------------ */

function renderFormatOptions() {
  const selected = formatState.current
    ? `${formatState.current.dev}:${formatState.current.oname}.${formatState.current.otype}`
    : '';

  formatSelect.replaceChildren(el('option', { value: '' }, ['— choose a format —']));
  for (const file of formatState.formats) {
    const lang = languageOf(file.otype);
    const value = `${file.dev}:${file.oname}.${file.otype}`;
    formatSelect.append(
      el('option', { value, selected: value === selected }, [
        `${file.name}  — ${lang ? lang.label : '?'}${file.bytes ? `, ${formatBytes(file.bytes)}` : ''}`,
      ]),
    );
  }
}

/** Formats /dir will admit to, which is everything except CPCL. */
async function refreshFormats() {
  let found = [];
  try {
    const files = await listFiles({ dev: 'E', otype: '*  ' });
    found = files.filter((f) => FORMAT_OTYPES.includes(f.otype));
  } catch (err) {
    toast(`Could not list stored formats: ${err.message}`, 'error');
    return;
  }

  // Whatever a CPCL scan turned up keeps its place in the list.
  const scanned = formatState.formats.filter(
    (f) => f.fromScan && !found.some((x) => x.name === f.name),
  );
  formatState.formats = [...found, ...scanned];
  renderFormatOptions();
}

/**
 * CPCL formats are invisible to /dir: it reports E:SHELF.FMT as type
 * "---", losing the extension. file.drive_listing is the one place the
 * real name survives, and reading it takes about nine seconds, so this
 * is a button rather than something done on every visit.
 */
async function scanForCpcl() {
  const stem = (printer.schema.slowFiles || {})['file.drive_listing'];
  if (!stem) {
    toast('This build has no helper for file.drive_listing.', 'error');
    return;
  }

  scanBtn.disabled = true;
  scanBtn.textContent = 'Scanning…';
  const busy = toast('Reading the full drive listing… this takes a few seconds', 'busy', {
    timeout: 0,
  });

  try {
    const values = await readSlowSetting(stem, { timeout: 60000 });
    const listing = values['file.drive_listing'] || '';
    const re = new RegExp(`"([A-Z0-9_~]+)\\.(${LANGUAGES.cpcl.otypes.join('|')})"`, 'gi');

    const found = new Map();
    let match;
    while ((match = re.exec(listing)) !== null) {
      const oname = match[1].toUpperCase();
      const otype = match[2].toUpperCase();
      found.set(`E:${oname}.${otype}`, {
        name: `E:${oname}.${otype}`,
        dev: 'E',
        oname,
        otype,
        bytes: 0,
        fromScan: true,
      });
    }

    const added = [...found.values()].filter(
      (f) => !formatState.formats.some((x) => x.name === f.name),
    );
    formatState.formats = [...formatState.formats, ...added];
    renderFormatOptions();

    busy.update(
      added.length ? `Found ${added.length} CPCL format(s).` : 'No CPCL formats on this printer.',
      added.length ? 'success' : 'info',
    );
  } catch (err) {
    busy.update(`Scan failed: ${err.message}`, 'error');
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = 'Scan for CPCL';
  }
}

/* ------------------------------------------------------------------ *
 * Selecting and printing
 * ------------------------------------------------------------------ */

async function selectFormat(value, preloaded = null) {
  if (!value) {
    formatState.current = null;
    formatState.lang = null;
    formatState.fields = [];
    formatState.source = '';
    formatState.sourceRead = false;
    formatState.values.clear();
    renderNotice();
    renderFields();
    renderSource();
    renderSummary();
    formatPreview.idle('Choose a format to see it rendered.');
    return;
  }

  const [dev, rest] = value.split(':');
  const dot = rest.lastIndexOf('.');
  const oname = rest.slice(0, dot);
  const otype = rest.slice(dot + 1);
  const lang = languageOf(otype);

  formatState.current = { dev, oname, otype };
  formatState.lang = lang;

  // A mode that has already read the file hands the source over with it,
  // which is the only way an EPL or CPCL format ever gets its fields
  // named: /zpl will not open one, but the file itself can be fetched.
  if (preloaded) {
    applySource(preloaded, true);
  } else if (lang.id === 'zpl') {
    // Only ZPL comes back from /zpl; the others are refused, so do not
    // make the user wait on a request known to fail.
    const busy = toast(`Reading ${dev}:${oname}.${otype}…`, 'busy', { timeout: 0 });
    try {
      applySource(await readScript({ dev, oname, otype }), true);
      busy.close();
    } catch (err) {
      busy.update(`Could not read ${oname}: ${err.message}`, 'error');
      applySource('', false);
    }
  } else {
    applySource('', false);
  }

  renderNotice();
  renderFields();
  renderSource();
  renderSummary();

  if (lang.previewable) formatPreview.update(recallZpl());
  else
    formatPreview.idle(
      `The printer only renders ZPL previews, so there is none for ${lang.label}.`,
    );

  const first = fieldsHost.querySelector('input[type="text"]');
  if (first) first.focus();
}

async function printFormatLabel() {
  if (!formatState.current) return;
  const { lang, current, copies } = formatState;

  const ok = await confirmDialog(
    'Print this label?',
    `${copies > 1 ? `${copies} copies of` : 'One copy of'} ${current.oname}.${current.otype}` +
      ` will be sent to the printer as ${lang.label}.`,
    'Print',
  );
  if (!ok) return;
  formatPreview.print(recallZpl());
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export function mountFormat(panel) {
  formatSelect = el('select', { class: 'field w-full min-w-0 sm:w-80' });
  formatSelect.addEventListener('change', () => selectFormat(formatSelect.value));

  const copiesInput = el('input', {
    class: 'field field-mono w-20',
    type: 'number',
    min: '1',
    max: '999',
    value: '1',
  });
  copiesInput.addEventListener('change', () => {
    formatState.copies = Math.max(1, Math.round(Number(copiesInput.value) || 1));
    copiesInput.value = String(formatState.copies);
    scheduleFormatPreview();
  });

  scanBtn = el(
    'button',
    {
      class: 'btn-secondary btn-sm',
      title:
        'CPCL formats are not listed under their real extension, so this reads the full drive listing to find them',
      onclick: () => scanForCpcl(),
    },
    ['Scan for CPCL'],
  );

  printBtn = el(
    'button',
    {
      class: 'btn-primary btn-sm',
      onclick: () => printFormatLabel(),
      disabled: true,
    },
    ['Print'],
  );
  summaryNode = el('span', { class: 'text-[11px] text-ink-500' });

  noticeHost = el('div');
  fieldsHost = el('div');
  sourceHost = el('div');
  formatPreview = createPreview();

  panel.append(
    el('div', { class: 'grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]' }, [
      el('div', { class: 'card min-w-0 overflow-hidden' }, [
        el('div', { class: 'toolbar' }, [
          formatSelect,
          scanBtn,
          el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, ['Copies', copiesInput]),
          el('div', { class: 'ml-auto flex items-center gap-3' }, [summaryNode, printBtn]),
        ]),
        noticeHost,
        fieldsHost,
        sourceHost,
      ]),
      el('div', { class: 'min-w-0' }, [formatPreview.node]),
    ]),
  );

  renderFields();
  formatPreview.idle('Choose a format to see it rendered.');
  refreshFormats().then(drainPendingFormat);
}

/** Stored formats can change from the Label Editor, so re-read the list. */
export function onFormatShown() {
  refreshFormats().then(drainPendingFormat);
}

/**
 * Fill in a particular stored format, at another mode's request.
 *
 * The File System tab sends anything it finds fields in this way, with
 * the source it has already read -- which is how an EPL or CPCL format
 * arrives here with its fields named, rather than as a count the user
 * has to guess.
 */
export function openInFormat(file, source = null) {
  pendingFormat = { file, source };
  if (formatSelect) drainPendingFormat();
}

function drainPendingFormat() {
  const pending = pendingFormat;
  if (!pending || !formatSelect) return;
  pendingFormat = null;

  const { file, source } = pending;
  const value = `${file.dev}:${file.oname}.${file.otype}`;
  if (!formatState.formats.some((f) => f.name === value)) {
    formatState.formats = [
      ...formatState.formats,
      {
        name: value,
        dev: file.dev,
        oname: file.oname,
        otype: file.otype,
        bytes: file.bytes || 0,
      },
    ];
  }
  formatState.current = { dev: file.dev, oname: file.oname, otype: file.otype };
  renderFormatOptions();
  formatSelect.value = value;
  selectFormat(value, source);
}
