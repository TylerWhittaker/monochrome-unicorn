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
 * settings.js -- Mode 1: browse and edit every SGD on the printer.
 *
 * Modelled on about:config. The catalogue (name, type, range, access,
 * factory default) is inlined at build time; SGD values are read from the
 * V_*.SHTML helper files: all of them in one streamed request, and after
 * a write the few-branch file holding that setting.
 *
 * setvars.cgi answers 200 with an empty body whether or not it liked the
 * value, so every write is followed by a read-back of that branch and the
 * row reports what the printer actually kept.
 */

import { el, qs, replaceChildren, toast, debounce } from './ui.js';
import { printer, allSettings } from './state.js';
import { createMaintenanceCard } from './maintenance.js';
import {
  readAllSettings,
  readSlowSetting,
  writeSetting,
  valuesMatch,
  readSgdReference,
} from './printer.js';
import {
  cachedDriveListing,
  driveListingLoading,
  onDriveListing,
  refreshDriveListing,
} from './drives.js';

/** Shown wherever the live value has not been read yet. */
const UNKNOWN = '\u2014';

/** Live values, keyed by SGD name. Filled in by refresh(). */
const values = Object.create(null);

/** Rows currently built, keyed by SGD name, so a refresh can update in place. */
const rows = new Map();

/** Branch sections, in catalogue order: {branch, header, countNode, entries}. */
const groups = [];

let filterText = '';
let modifiedOnly = false;
let sortMode = 'default';
let listNode = null;
let countNode = null;
let refreshBtn = null;

/* ------------------------------------------------------------------ *
 * Range parsing
 * ------------------------------------------------------------------ */

/**
 * Numeric ranges arrive as "lo-hi" and the low bound may be negative
 * ("-400.0-338.0"), so the split has to be on the separator between the
 * two numbers rather than on the first hyphen.
 */
export function parseNumericRange(range) {
  const match = /^\s*(-?[\d.]+)\s*-\s*(-?[\d.]+)\s*$/.exec(range || '');
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/** Choice lists arrive comma separated; a single choice is still a list. */
export function parseChoices(range) {
  if (!range || !range.includes(',')) return null;
  const choices = range
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return choices.length > 1 ? choices : null;
}

/* ------------------------------------------------------------------ *
 * Editors
 * ------------------------------------------------------------------ */

/** About what the narrow value box shows on one line, in characters. */
const NARROW_BOX_CHARS = 40;

/**
 * Whether a setting's value wants the full width of the row.
 *
 * For strings the range is a "min-max" length, not a value range. A
 * handful of settings advertise 0-4294967295, which is really "no limit";
 * those hold log dumps and the like, so they get a box you can actually
 * read -- an editor as much as a read-only value. A read-only value is
 * also widened when it simply will not fit the narrow box, since nobody
 * can make it shorter.
 */
function holdsLongText(meta, current, { readOnly = false } = {}) {
  // A number's range is its values, not its length.
  const isNumber = meta.type === 'integer' || meta.type === 'double';
  const numeric = isNumber ? null : parseNumericRange(meta.range);
  const maxLen = numeric ? numeric.max : 0;
  const text = current ?? '';
  return maxLen > 512 || text.includes('\n') || (readOnly && text.length > NARROW_BOX_CHARS);
}

/**
 * Build the right input for a setting. `commit(value)` is called when the
 * user finishes editing -- change for pickers, blur or Enter for text.
 */
function buildEditor(meta, current, commit) {
  const choices = parseChoices(meta.range);
  const numeric = parseNumericRange(meta.range);

  const known = current !== undefined;

  // bool and enum both present as a picker when we know the options.
  if ((meta.type === 'bool' || meta.type === 'enum') && choices) {
    const select = el('select', { class: 'field w-full sm:w-56' });
    // Before the live value arrives, a picker would otherwise sit on its
    // first option and read as if that were the printer's setting.
    if (!known) select.append(el('option', { value: '', selected: true }, [UNKNOWN]));
    // A value outside the advertised range still has to be selectable,
    // or opening the picker would silently rewrite it.
    const options = !known || choices.includes(current) ? choices : [current, ...choices];
    for (const choice of options) {
      select.append(el('option', { value: choice, selected: choice === current }, [choice]));
    }
    select.addEventListener('change', () => {
      if (select.value === '') return;
      commit(select.value);
    });
    return select;
  }

  if (meta.type === 'integer' || meta.type === 'double') {
    const input = el('input', {
      class: 'field w-full sm:w-40 field-mono',
      type: 'number',
      value: current ?? '',
      placeholder: known ? '' : UNKNOWN,
      step: meta.type === 'double' ? 'any' : '1',
    });
    if (numeric) {
      input.min = String(numeric.min);
      input.max = String(numeric.max);
    }
    wireTextCommit(input, current, commit);
    return input;
  }

  if (meta.type === 'ipv4-address') {
    const input = el('input', {
      class: 'field w-full sm:w-44 field-mono',
      type: 'text',
      inputmode: 'numeric',
      value: current ?? '',
      pattern: '^(\\d{1,3}\\.){3}\\d{1,3}$',
      placeholder: known ? '0.0.0.0' : UNKNOWN,
    });
    wireTextCommit(input, current, commit);
    return input;
  }

  if (meta.type === 'json') {
    const area = el(
      'textarea',
      {
        class: 'field field-mono w-full',
        rows: '3',
        spellcheck: 'false',
        placeholder: known ? '' : UNKNOWN,
      },
      [current ?? ''],
    );
    wireTextCommit(area, current, commit);
    return area;
  }

  const maxLen = numeric ? numeric.max : 0;
  if (holdsLongText(meta, current)) {
    const area = el(
      'textarea',
      {
        class: 'field field-mono w-full',
        rows: '3',
        spellcheck: 'false',
        placeholder: known ? '' : UNKNOWN,
      },
      [current ?? ''],
    );
    wireTextCommit(area, current, commit);
    return area;
  }

  const input = el('input', {
    class: 'field w-full sm:w-72 field-mono',
    type: meta.name.includes('password') || meta.name.includes('_pin') ? 'password' : 'text',
    value: current ?? '',
    placeholder: known ? '' : UNKNOWN,
  });
  if (maxLen > 0) input.maxLength = maxLen;
  wireTextCommit(input, current, commit);
  return input;
}

/** Commit a text-ish field on Enter or blur, but only when it changed. */
function wireTextCommit(input, original, commit) {
  let last = original ?? '';
  const fire = () => {
    if (input.value === last) return;
    last = input.value;
    commit(input.value);
  };
  input.addEventListener('blur', fire);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.tagName !== 'TEXTAREA') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      input.value = last;
      input.blur();
    }
  });
}

/**
 * What the catalogue could not tell us, said once at the top.
 *
 * A pre-Link-OS printer has no JSON channel, so the catalogue comes
 * from allcv, which lists neither factory defaults nor access flags.
 * Without a word of explanation the missing "not default" tags read as
 * a broken page rather than a printer that never said.
 */
function sourceNotice() {
  if (!printer.schema || printer.schema.source !== 'allcv') return null;
  return el(
    'p',
    {
      class: 'border-b border-ink-200 bg-ink-50 px-3 py-2 text-[12px] text-ink-600',
    },
    [
      'This printer\u2019s settings were read with allcv, which is all a pre-Link-OS printer ' +
        'offers: no factory defaults, so nothing is marked as changed, and no access flags, ' +
        'so anything without a list of choices is tagged read/write? and can be tried.',
    ],
  );
}

/* ------------------------------------------------------------------ *
 * Sorting
 *
 * The catalogue's own order groups related settings the way the
 * firmware thinks of them, which is worth keeping as the default; the
 * alternatives are for when you know the name and just want to find it.
 * ------------------------------------------------------------------ */

export const SORT_MODES = [
  ['default', 'default order'],
  ['alpha', 'alphabetical'],
  ['alpha-enable', 'alphabetical, .enable first'],
];

/**
 * The key a name sorts under.
 *
 * In "alpha-enable", a `.enable` sorts as the branch it switches on --
 * `ip.ftp.enable` becomes `ip.ftp.` followed by a character below every
 * other -- so it lands at the head of its own group rather than among
 * its siblings. Everything else sorts as itself.
 */
export function sortKeyFor(name, mode) {
  if (mode !== 'alpha-enable' || !name.endsWith('.enable')) return name;
  return name.slice(0, -'enable'.length) + '\u0000';
}

/** Plain code-unit order: SGD names are lower-case ASCII with dots. */
export function compareNames(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Re-order the list in place.
 *
 * Appending a node that is already in the list moves it, so the whole
 * order is expressed by appending everything once, in the order wanted.
 */
function applySort() {
  const branches =
    sortMode === 'default' ? groups : [...groups].sort((a, b) => compareNames(a.branch, b.branch));

  for (const group of branches) {
    const entries =
      sortMode === 'default'
        ? group.entries
        : [...group.entries].sort((a, b) =>
            compareNames(sortKeyFor(a.meta.name, sortMode), sortKeyFor(b.meta.name, sortMode)),
          );
    listNode.append(group.header, ...entries.map((entry) => entry.row));
  }
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/*
 * Every tag gets its own hue, so two tags side by side never read as the
 * same thing. Types never sit next to each other (a setting has one), so
 * the constraint that matters is type vs access vs "not default".
 */
const TYPE_BADGE = {
  string: 'bg-blue-100 text-blue-800',
  bool: 'bg-cyan-100 text-cyan-800',
  enum: 'bg-violet-100 text-violet-800',
  integer: 'bg-amber-100 text-amber-800',
  double: 'bg-orange-100 text-orange-800',
  'ipv4-address': 'bg-teal-100 text-teal-800',
  json: 'bg-fuchsia-100 text-fuchsia-800',
};

const ACCESS_BADGE = {
  RW: ['read/write', 'bg-emerald-100 text-emerald-800'],
  // Read-only is the one tag that should recede: it marks a row you
  // cannot act on.
  R: ['read-only', 'bg-ink-100 text-ink-500'],
  W: ['write-only', 'bg-rose-100 text-rose-800'],
  // A catalogue read from allcv does not say whether a setting can be
  // written unless it lists choices for it. Rather than guess in either
  // direction, such a row is editable and says that it is a guess: the
  // write is checked by reading the value back, so trying it is how you
  // find out.
  'RW?': ['read/write?', 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200'],
};

const ACCESS_TITLE = {
  'RW?':
    'This printer\u2019s catalogue (allcv) does not say whether this setting can be ' +
    'written. You can try: the value is read back afterwards, and the row reports what ' +
    'the printer kept.',
};

/** Outlined, because unlike the others this tag is a button. */
const NOT_DEFAULT_BADGE = 'border border-red-400 bg-red-50 text-red-700';

/*
 * A `.enable` setting says on or off, which is worth reading as a state
 * rather than a value -- these are the rows people scan a page for.
 * Neither hue is one a `.enable` row already carries: those are bool
 * (cyan) and read/write (emerald).
 */
const ENABLE_BADGE = {
  on: ['enabled', 'bg-lime-100 text-lime-800'],
  off: ['disabled', 'bg-zinc-200 text-zinc-700'],
};

/**
 * The on/off tag for a `.enable` setting, or nothing for anything else.
 *
 * Built empty and filled in by paintEnableTag, so that a write can
 * change what it says without re-rendering the row -- re-rendering
 * would replace the very widget that was just used, and take the focus
 * and the "saved" note with it.
 */
function enableTag(meta) {
  if (!meta.name.endsWith('.enable')) return null;
  return el('span', { class: 'pill shrink-0' });
}

/**
 * Put the current state on the tag.
 *
 * Hidden rather than absent when the value is neither on nor off: an
 * enum reading "none", or a value the printer returns as "?", has no
 * state to report, and the row should not jump about when one arrives.
 */
function paintEnableTag(entry) {
  const node = entry.enableTag;
  if (!node) return;
  const state = String(values[entry.meta.name] ?? '')
    .trim()
    .toLowerCase();
  const badge = ENABLE_BADGE[state];
  node.hidden = !badge;
  if (!badge) return;
  node.textContent = badge[0];
  node.className = `pill shrink-0 ${badge[1]}`;
}

/**
 * What a setting is for, opened under its row by clicking its name: the
 * reference's summary, and the range and default the printer's own
 * catalogue gives.
 */
function toggleExplanation(entry) {
  if (entry.explainNode) {
    entry.explainNode.remove();
    entry.explainNode = null;
    return;
  }
  const { meta } = entry;
  const facts = [
    meta.range ? `Range: ${meta.range}` : null,
    meta.default !== null && meta.default !== undefined
      ? `Default: ${meta.default === '' ? '(empty)' : meta.default}`
      : null,
  ].filter(Boolean);
  const text = el('p', { class: 'text-[12px] leading-snug text-ink-700' }, [
    'Reading the setting reference…',
  ]);
  entry.explainNode = el(
    'div',
    {
      class: 'rounded border border-ink-200 bg-white px-3 py-2 sm:col-span-2',
      dataset: { explain: meta.name },
    },
    [
      text,
      facts.length
        ? el('p', { class: 'mt-1 text-[11px] text-ink-400' }, [facts.join(' · ')])
        : null,
    ],
  );
  entry.row.append(entry.explainNode);
  readSgdReference()
    .then((reference) => {
      text.textContent =
        reference[meta.name] || 'The ZPL programming guide does not describe this setting.';
      text.classList.toggle('text-ink-400', !reference[meta.name]);
    })
    .catch((err) => {
      text.textContent = `The setting reference could not be read: ${err.message}`;
    });
}

function buildRow(meta) {
  const nameNode = el(
    'code',
    {
      class:
        'cursor-pointer break-all text-[12px] leading-tight text-ink-800 decoration-ink-300 decoration-dotted underline-offset-2 hover:underline',
      title: 'What is this? Click for an explanation',
      onclick: () => toggleExplanation(rows.get(meta.name)),
    },
    [meta.name],
  );

  const noteNode = el('span', { class: 'text-[11px] text-ink-400' });

  const valueCell = el('div', { class: 'flex flex-wrap items-center gap-2' });

  const row = el(
    'div',
    {
      class:
        'grid grid-cols-1 gap-1 px-3 py-2 odd:bg-ink-50/40 hover:bg-ink-100/60' +
        ' sm:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] sm:items-start sm:gap-3 sm:py-1.5',
      dataset: { name: meta.name },
    },
    [
      el('div', { class: 'min-w-0 sm:pt-1.5' }, [nameNode]),
      el('div', { class: 'min-w-0' }, [valueCell, noteNode]),
    ],
  );

  const entry = {
    meta,
    row,
    valueCell,
    noteNode,
    nameNode,
    editor: null,
    resetBtn: null,
    enableTag: null,
    explainNode: null,
  };
  renderValueCell(entry);
  rows.set(meta.name, entry);
  return row;
}

/**
 * The tags that follow the value: what it is, whether you can change it,
 * and whether it still matches the factory default.
 *
 * "not default" doubles as the way to put it back, so it is a button --
 * outlined rather than filled, to set it apart from the two that are
 * purely informational.
 */
function buildTags(entry) {
  const { meta } = entry;
  const [accessText, accessClass] = ACCESS_BADGE[meta.access] || ACCESS_BADGE.R;

  entry.resetBtn =
    meta.writable && meta.default !== null
      ? el(
          'button',
          {
            class: `pill shrink-0 ${NOT_DEFAULT_BADGE} hover:bg-red-100`,
            title: `Restore the factory default: ${meta.default}`,
            onclick: () => applyChange(entry, meta.default),
          },
          ['not default'],
        )
      : el('span', { class: `pill shrink-0 ${NOT_DEFAULT_BADGE}` }, ['not default']);

  // ml-auto pushes the group to the right edge of the row, away from the
  // value, so the tags line up into their own column down the table.
  //
  // "not default" leads: it is the only one that comes and goes, and it
  // is hidden rather than absent when it does not apply, so the two
  // constant tags keep their place at the right edge either way.
  entry.enableTag = enableTag(meta);

  return el('div', { class: 'ml-auto flex shrink-0 items-center gap-2' }, [
    entry.resetBtn,
    entry.enableTag,
    el('span', { class: `pill ${TYPE_BADGE[meta.type] || TYPE_BADGE.string}` }, [meta.type]),
    el('span', { class: `pill ${accessClass}`, title: ACCESS_TITLE[meta.access] || null }, [
      accessText,
    ]),
  ]);
}

function renderValueCell(entry) {
  const { meta } = entry;
  const current = values[meta.name];

  // Slow settings are skipped by the sweep, so they stay unknown until
  // asked for -- whether or not they are also writable.
  const isSlow = current === undefined && slowFileFor(meta.name) !== null;
  // The drive listing is also read in the background, for the other modes.
  const inFlight = meta.name === DRIVE_LISTING && driveListingLoading();
  const readNow =
    isSlow &&
    el(
      'button',
      {
        class: 'btn-secondary btn-sm',
        title: 'Reading this one takes a few seconds, so it is left out of the sweep',
        disabled: inFlight,
        onclick: (event) => loadSlowSetting(meta.name, event.currentTarget),
      },
      [inFlight ? 'reading\u2026' : 'Read now'],
    );

  if (!meta.writable) {
    entry.editor = null;
    replaceChildren(entry.valueCell, [
      // Boxed like an input so it reads as a value, but filled and
      // borderless-looking enough to say you cannot type in it.
      // A long one takes the row, as the long editors do, and the tags
      // wrap onto the line below it.
      el(
        'div',
        {
          class:
            'field-static field-mono' +
            (holdsLongText(meta, current, { readOnly: true }) ? ' sm:w-full' : ''),
        },
        [displayValue(current, isSlow)],
      ),
      readNow,
      buildTags(entry),
    ]);
  } else {
    const editor = buildEditor(meta, current, (value) => applyChange(entry, value));
    entry.editor = editor;
    replaceChildren(entry.valueCell, [editor, readNow, buildTags(entry)]);
  }

  markModified(entry);
}

function displayValue(value, isSlow) {
  if (value === undefined) return isSlow ? '(not read — slow)' : '—';
  if (value === '') return '(empty)';
  return value;
}

/**
 * Repaint the tags that follow from the current value.
 *
 * Called after a write as well as after a render, which is what keeps
 * the enabled/disabled tag honest: a row that has just been switched on
 * says so without waiting for the next sweep.
 */
function markModified(entry) {
  paintEnableTag(entry);
  markDefaultState(entry);
}

/** about:config bolds anything that differs from its factory default. */
function markDefaultState(entry) {
  const { meta } = entry;
  const current = values[meta.name];
  const differs =
    meta.default !== null && current !== undefined && !valuesMatch(current, meta.default);
  entry.nameNode.classList.toggle('font-semibold', differs);
  entry.nameNode.classList.toggle('text-ink-900', differs);
  entry.row.dataset.modified = String(differs);
  if (entry.resetBtn) entry.resetBtn.hidden = !differs;
}

function note(entry, text, kind = 'info') {
  const styles = {
    info: 'text-[11px] text-ink-400',
    busy: 'text-[11px] text-ink-500',
    success: 'text-[11px] text-emerald-700',
    error: 'text-[11px] text-red-700',
  };
  entry.noteNode.className = styles[kind] || styles.info;
  entry.noteNode.textContent = text || '';
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

async function applyChange(entry, value) {
  const { meta } = entry;
  note(entry, 'saving…', 'busy');
  if (entry.editor) entry.editor.disabled = true;

  const result = await writeSetting(meta.name, value);

  if (entry.editor) entry.editor.disabled = false;

  if (result.actual !== null && result.actual !== undefined) {
    values[meta.name] = result.actual;
  } else if (result.ok) {
    values[meta.name] = value;
  }

  // The read-back brought the whole branch with it, so the rows around
  // this one can be brought up to date for free. Only the ones that
  // actually moved are repainted, and never the row being edited --
  // rebuilding that would take the focus out of the widget in use.
  if (result.branch) {
    for (const [name, fresh] of Object.entries(result.branch)) {
      if (name === meta.name) continue;
      if (values[name] === fresh) continue;
      values[name] = fresh;
      const sibling = rows.get(name);
      if (sibling) renderValueCell(sibling);
    }
  }

  if (result.ok) {
    note(entry, result.reason || 'saved', result.reason ? 'info' : 'success');
    if (entry.editor && result.actual != null && entry.editor.value !== result.actual) {
      entry.editor.value = result.actual;
    }
    setTimeout(() => {
      if (entry.noteNode.textContent === 'saved') note(entry, '');
    }, 2500);
  } else {
    note(entry, result.reason || 'the printer rejected this value', 'error');
    if (entry.editor && result.actual != null) entry.editor.value = result.actual;
    toast(`${meta.name}: ${result.reason}`, 'error');
  }

  markModified(entry);
}

/**
 * A setting kept out of the branch sweep because reading it takes
 * seconds. It has a helper file of its own; fetch that on request.
 */
const DRIVE_LISTING = 'file.drive_listing';

/**
 * Show the shared copy of the drive listing in its row. It is read after
 * the sweep, or by another mode, rather than by the row's own button.
 */
function paintDriveListing() {
  const cached = cachedDriveListing();
  if (cached) values[DRIVE_LISTING] = cached.raw;
  const entry = rows.get(DRIVE_LISTING);
  if (entry) renderValueCell(entry);
  applyFilter();
}

function slowFileFor(name) {
  return (printer.schema.slowFiles || {})[name] || null;
}

async function loadSlowSetting(name, button) {
  const stem = slowFileFor(name);
  if (!stem) {
    toast(`${name} has no helper file on this printer.`, 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'reading\u2026';
  try {
    if (name === DRIVE_LISTING) {
      // Through the shared copy, so the other modes see this read too.
      await refreshDriveListing({ force: true });
      paintDriveListing();
      return;
    }
    Object.assign(values, await readSlowSetting(stem));
    const entry = rows.get(name);
    if (entry) renderValueCell(entry);
  } catch (err) {
    toast(`Could not read ${name}: ${err.message}`, 'error');
    button.disabled = false;
    button.textContent = 'Read now';
  }
}

/* ------------------------------------------------------------------ *
 * Filtering and rendering
 * ------------------------------------------------------------------ */

/**
 * Whether a setting passes the filter: every whitespace-separated word
 * must appear, in any order, in its name or its value.
 */
export function matchesFilter(filter, name, value) {
  const haystacks = [name.toLowerCase()];
  if (value !== undefined) haystacks.push(String(value).toLowerCase());
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
    .every((word) => haystacks.some((h) => h.includes(word)));
}

function matches(meta) {
  if (modifiedOnly && rows.get(meta.name)?.row.dataset.modified !== 'true') return false;
  return matchesFilter(filterText, meta.name, values[meta.name]);
}

function applyFilter() {
  let shown = 0;
  for (const group of groups) {
    let groupShown = 0;
    for (const entry of group.entries) {
      const visible = matches(entry.meta);
      entry.row.hidden = !visible;
      if (visible) groupShown++;
    }
    group.header.hidden = groupShown === 0;
    group.countNode.textContent = String(groupShown);
    shown += groupShown;
  }
  countNode.textContent =
    shown === rows.size ? `${rows.size} settings` : `${shown} of ${rows.size} settings`;
  qs('#settings-empty').hidden = shown !== 0;
}

/**
 * Group rows by top-level branch. With 647 settings a flat list is hard to
 * scan, and the branch is also the unit the helper files are fetched in.
 */
function buildGroups() {
  const byBranch = new Map();
  for (const meta of allSettings()) {
    const branch = meta.name.split('.')[0];
    if (!byBranch.has(branch)) byBranch.set(branch, []);
    byBranch.get(branch).push(meta);
  }

  const nodes = [];
  for (const [branch, metas] of byBranch) {
    const groupCount = el('span', { class: 'text-ink-400' });
    const header = el(
      'div',
      {
        class:
          'sticky top-0 z-10 flex items-baseline gap-2 border-y border-ink-200 bg-ink-100/95 px-3 py-1.5' +
          ' text-[11px] font-semibold uppercase tracking-wide text-ink-600 backdrop-blur',
      },
      [branch, groupCount],
    );

    const entries = [];
    nodes.push(header);
    for (const meta of metas) {
      nodes.push(buildRow(meta));
      entries.push(rows.get(meta.name));
    }
    groups.push({ branch, header, countNode: groupCount, entries });
  }
  return nodes;
}

/* ------------------------------------------------------------------ *
 * Refresh
 * ------------------------------------------------------------------ */

/** How many settings a full sweep can read, for the progress count. */
function readableCount() {
  const slow = new Set(printer.schema.slow || []);
  return allSettings().filter((m) => m.readable && !slow.has(m.name)).length;
}

/**
 * Read every live value.
 *
 * One request for the lot, read as it streams: the values arrive a few
 * at a time and are painted as they land, the same as when this walked
 * the branch files, but without paying 95 ms of request overhead
 * thirty-two times over.
 */
async function refresh() {
  const total = readableCount();
  refreshBtn.disabled = true;

  // Start from nothing rather than leaving the previous sweep's values on
  // screen: until a setting is re-read, what it now holds is unknown.
  for (const name of Object.keys(values)) delete values[name];
  for (const entry of rows.values()) renderValueCell(entry);
  applyFilter();

  const progress = toast(`Reading SGD values… 0/${total}`, 'busy', { timeout: 0 });
  let read = 0;

  const paint = (batch) => {
    Object.assign(values, batch);
    for (const name of Object.keys(batch)) {
      const entry = rows.get(name);
      if (entry) renderValueCell(entry);
      read++;
    }
    progress.update(`Reading SGD values… ${read}/${total}`, 'busy', { timeout: 0 });
  };

  let failure = null;
  try {
    await readAllSettings(printer.schema.allFile || 'V_ALL', paint);
  } catch (err) {
    failure = err;
  }

  applyFilter();
  refreshBtn.disabled = false;

  if (failure) {
    progress.update(
      `Read ${read} of ${total} values before the read failed: ${failure.message}`,
      'error',
      { timeout: 8000 },
    );
  } else {
    progress.update(`Read ${read} SGD values`, 'success');
  }

  // Now the printer is free, read the drive listing for the modes that
  // need it: nine seconds spent here is nine seconds they do not wait.
  // A copy that is still recent is shown rather than re-read.
  refreshDriveListing()
    .then(paintDriveListing)
    .catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export function mountSettings(panel) {
  if (!printer.schema) {
    panel.append(
      el('p', { class: 'text-red-700' }, ['No settings catalogue was inlined into this page.']),
    );
    return;
  }

  const filterInput = el('input', {
    class: 'field w-full sm:w-72',
    type: 'search',
    placeholder: 'Filter by name or value…',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  filterInput.addEventListener(
    'input',
    debounce(() => {
      filterText = filterInput.value.trim();
      applyFilter();
    }, 120),
  );

  const toggle = (labelText, onChange) => {
    const box = el('input', { type: 'checkbox', class: 'h-3.5 w-3.5 accent-ink-900' });
    box.addEventListener('change', () => {
      onChange(box.checked);
      applyFilter();
    });
    return el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, [box, labelText]);
  };

  const sortSelect = el(
    'select',
    {
      class: 'field w-auto',
      title: 'How the settings are ordered within each branch',
    },
    SORT_MODES.map(([value, label]) => el('option', { value }, [label])),
  );
  sortSelect.addEventListener('change', () => {
    sortMode = sortSelect.value;
    applySort();
  });

  refreshBtn = el(
    'button',
    {
      class: 'btn-secondary btn-sm',
      onclick: () => refresh(),
    },
    ['Refresh values'],
  );

  countNode = el('span', { class: 'text-[11px] text-ink-500' });

  listNode = el('div');
  listNode.append(...buildGroups());

  // Above the table, and read once the sweep is done so it does not hold
  // the printer up for the settings.
  const maintenance = createMaintenanceCard();
  panel.append(el('div', { class: 'mb-3' }, [maintenance.node]));

  panel.append(
    el('div', { class: 'card overflow-hidden' }, [
      sourceNotice(),
      el('div', { class: 'toolbar' }, [
        filterInput,
        sortSelect,
        toggle('changed from default', (v) => {
          modifiedOnly = v;
        }),
        el('div', { class: 'ml-auto flex items-center gap-3' }, [countNode, refreshBtn]),
      ]),
      el(
        'p',
        {
          id: 'settings-empty',
          class: 'px-3 py-6 text-center text-ink-400',
          hidden: true,
        },
        ['No settings match this filter.'],
      ),
      listNode,
    ]),
  );

  onDriveListing(paintDriveListing);
  applyFilter();
  refresh().then(() => maintenance.refresh());
}
