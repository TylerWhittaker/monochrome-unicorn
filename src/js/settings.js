/*
 * settings.js -- Mode 1: browse and edit every SGD on the printer.
 *
 * Modelled on about:config. The catalogue (name, type, range, access,
 * factory default) is inlined at build time; live values are read from the
 * V_*.SHTML helper files, one request per branch.
 *
 * setvars.cgi answers 200 with an empty body whether or not it liked the
 * value, so every write is followed by a read-back of that branch and the
 * row reports what the printer actually kept.
 */

import { el, qs, replaceChildren, toast, debounce } from './ui.js';
import { printer, allSettings } from './state.js';
import { readBranch, readAllBranches, readSlowSetting, writeSetting, valuesMatch } from './printer.js';

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
  const choices = range.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return choices.length > 1 ? choices : null;
}

/* ------------------------------------------------------------------ *
 * Editors
 * ------------------------------------------------------------------ */

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
    const area = el('textarea', {
      class: 'field field-mono w-full', rows: '3', spellcheck: 'false',
      placeholder: known ? '' : UNKNOWN,
    }, [current ?? '']);
    wireTextCommit(area, current, commit);
    return area;
  }

  // Strings: the range is a "min-max" length, not a value range. A handful
  // of settings advertise 0-4294967295, which is really "no limit"; those
  // hold log dumps and the like, so they get a box you can actually read.
  const maxLen = numeric ? numeric.max : 0;
  if (maxLen > 512 || (current && current.includes('\n'))) {
    const area = el('textarea', {
      class: 'field field-mono w-full', rows: '3', spellcheck: 'false',
      placeholder: known ? '' : UNKNOWN,
    }, [current ?? '']);
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
};

/** Outlined, because unlike the others this tag is a button. */
const NOT_DEFAULT_BADGE = 'border border-red-400 bg-red-50 text-red-700';

function buildRow(meta) {
  const nameNode = el('code', {
    class: 'break-all text-[12px] leading-tight text-ink-800',
  }, [meta.name]);

  const noteNode = el('span', { class: 'text-[11px] text-ink-400' });

  const valueCell = el('div', { class: 'flex flex-wrap items-center gap-2' });

  const row = el('div', {
    class: 'grid grid-cols-1 gap-1 px-3 py-2 odd:bg-ink-50/40 hover:bg-ink-100/60'
      + ' sm:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] sm:items-start sm:gap-3 sm:py-1.5',
    dataset: { name: meta.name },
  }, [
    el('div', { class: 'min-w-0 sm:pt-1.5' }, [nameNode]),
    el('div', { class: 'min-w-0' }, [valueCell, noteNode]),
  ]);

  const entry = { meta, row, valueCell, noteNode, nameNode, editor: null, resetBtn: null };
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

  entry.resetBtn = meta.writable && meta.default !== null
    ? el('button', {
      class: `pill shrink-0 ${NOT_DEFAULT_BADGE} hover:bg-red-100`,
      title: `Restore the factory default: ${meta.default}`,
      onclick: () => applyChange(entry, meta.default),
    }, ['not default'])
    : el('span', { class: `pill shrink-0 ${NOT_DEFAULT_BADGE}` }, ['not default']);

  // ml-auto pushes the group to the right edge of the row, away from the
  // value, so the tags line up into their own column down the table.
  return el('div', { class: 'ml-auto flex shrink-0 items-center gap-2' }, [
    el('span', { class: `pill ${TYPE_BADGE[meta.type] || TYPE_BADGE.string}` }, [meta.type]),
    el('span', { class: `pill ${accessClass}` }, [accessText]),
    entry.resetBtn,
  ]);
}

function renderValueCell(entry) {
  const { meta } = entry;
  const current = values[meta.name];

  // Slow settings are skipped by the sweep, so they stay unknown until
  // asked for -- whether or not they are also writable.
  const isSlow = current === undefined && slowFileFor(meta.name) !== null;
  const readNow = isSlow && el('button', {
    class: 'btn-secondary btn-sm',
    title: 'Reading this one takes a few seconds, so it is left out of the sweep',
    onclick: (event) => loadSlowSetting(meta.name, event.currentTarget),
  }, ['Read now']);

  if (!meta.writable) {
    entry.editor = null;
    replaceChildren(entry.valueCell, [
      // Boxed like an input so it reads as a value, but filled and
      // borderless-looking enough to say you cannot type in it.
      el('div', { class: 'field-static field-mono' }, [displayValue(current, isSlow)]),
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

/** about:config bolds anything that differs from its factory default. */
function markModified(entry) {
  const { meta } = entry;
  const current = values[meta.name];
  const differs = meta.default !== null
    && current !== undefined
    && !valuesMatch(current, meta.default);
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

  if (result.ok) {
    note(entry, result.reason || 'saved', result.reason ? 'info' : 'success');
    if (entry.editor && result.actual != null && entry.editor.value !== result.actual) {
      entry.editor.value = result.actual;
    }
    setTimeout(() => { if (entry.noteNode.textContent === 'saved') note(entry, ''); }, 2500);
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

function matches(meta) {
  if (modifiedOnly && rows.get(meta.name)?.row.dataset.modified !== 'true') return false;
  if (!filterText) return true;
  const needle = filterText.toLowerCase();
  if (meta.name.toLowerCase().includes(needle)) return true;
  const value = values[meta.name];
  return value !== undefined && String(value).toLowerCase().includes(needle);
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
  countNode.textContent = shown === rows.size
    ? `${rows.size} settings`
    : `${shown} of ${rows.size} settings`;
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
    const header = el('div', {
      class: 'sticky top-0 z-10 flex items-baseline gap-2 border-y border-ink-200 bg-ink-100/95 px-3 py-1.5'
        + ' text-[11px] font-semibold uppercase tracking-wide text-ink-600 backdrop-blur',
    }, [branch, groupCount]);

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

async function refresh() {
  const branches = printer.schema.helperBranches || printer.schema.branches;
  const total = readableCount();
  refreshBtn.disabled = true;

  // Start from nothing rather than leaving the previous sweep's values on
  // screen: until a setting is re-read, what it now holds is unknown.
  for (const name of Object.keys(values)) delete values[name];
  for (const entry of rows.values()) renderValueCell(entry);
  applyFilter();

  const progress = toast(`Reading live values… 0/${total}`, 'busy', { timeout: 0 });

  const { failed, read } = await readAllBranches(branches, ({ values: branchValues, read: soFar }) => {
    if (branchValues) {
      Object.assign(values, branchValues);
      // Repaint only the rows this branch just filled in.
      for (const name of Object.keys(branchValues)) {
        const entry = rows.get(name);
        if (entry) renderValueCell(entry);
      }
    }
    progress.update(`Reading live values… ${soFar}/${total}`, 'busy', { timeout: 0 });
  });

  applyFilter();
  refreshBtn.disabled = false;

  if (failed.length) {
    progress.update(
      `Read ${read} of ${total} values; ${failed.length} branch(es) failed: ${failed.join(', ')}`,
      'error', { timeout: 8000 }
    );
  } else {
    progress.update(`Read ${read} live values`, 'success');
  }
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export function mountSettings(panel) {
  if (!printer.schema) {
    panel.append(el('p', { class: 'text-red-700' }, ['No settings catalogue was inlined into this page.']));
    return;
  }

  const filterInput = el('input', {
    class: 'field w-full sm:w-72',
    type: 'search',
    placeholder: 'Filter by name or value…',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  filterInput.addEventListener('input', debounce(() => {
    filterText = filterInput.value.trim();
    applyFilter();
  }, 120));

  const toggle = (labelText, onChange) => {
    const box = el('input', { type: 'checkbox', class: 'h-3.5 w-3.5 accent-ink-900' });
    box.addEventListener('change', () => { onChange(box.checked); applyFilter(); });
    return el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, [box, labelText]);
  };

  refreshBtn = el('button', {
    class: 'btn-secondary btn-sm',
    onclick: () => refresh(),
  }, ['Refresh values']);

  countNode = el('span', { class: 'text-[11px] text-ink-500' });

  listNode = el('div');
  listNode.append(...buildGroups());

  panel.append(el('div', { class: 'card overflow-hidden' }, [
    el('div', { class: 'toolbar' }, [
      filterInput,
      toggle('Changed from default', (v) => { modifiedOnly = v; }),
      el('div', { class: 'ml-auto flex items-center gap-3' }, [countNode, refreshBtn]),
    ]),
    el('p', {
      id: 'settings-empty',
      class: 'px-3 py-6 text-center text-ink-400',
      hidden: true,
    }, ['No settings match this filter.']),
    listNode,
  ]));

  applyFilter();
  refresh();
}
