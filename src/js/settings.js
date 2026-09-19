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
import { readBranch, readAllBranches, writeSetting, valuesMatch } from './printer.js';

/** Live values, keyed by SGD name. Filled in by refresh(). */
const values = Object.create(null);

/** Rows currently built, keyed by SGD name, so a refresh can update in place. */
const rows = new Map();

let filterText = '';
let writableOnly = false;
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

  // bool and enum both present as a picker when we know the options.
  if ((meta.type === 'bool' || meta.type === 'enum') && choices) {
    const select = el('select', { class: 'field w-full sm:w-56' });
    // A value outside the advertised range still has to be selectable,
    // or opening the picker would silently rewrite it.
    const options = choices.includes(current) || current == null ? choices : [current, ...choices];
    for (const choice of options) {
      select.append(el('option', { value: choice, selected: choice === current }, [choice]));
    }
    select.addEventListener('change', () => commit(select.value));
    return select;
  }

  if (meta.type === 'integer' || meta.type === 'double') {
    const input = el('input', {
      class: 'field w-full sm:w-40 field-mono',
      type: 'number',
      value: current ?? '',
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
      placeholder: '0.0.0.0',
    });
    wireTextCommit(input, current, commit);
    return input;
  }

  if (meta.type === 'json') {
    const area = el('textarea', {
      class: 'field field-mono w-full', rows: '3', spellcheck: 'false',
    }, [current ?? '']);
    wireTextCommit(area, current, commit);
    return area;
  }

  // Strings: the range is a "min-max" length, not a value range.
  const input = el('input', {
    class: 'field w-full sm:w-72 field-mono',
    type: meta.name.includes('password') || meta.name.includes('_pin') ? 'password' : 'text',
    value: current ?? '',
  });
  if (numeric && numeric.max > 0) input.maxLength = numeric.max;
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

const TYPE_BADGE = {
  bool: 'bg-sky-100 text-sky-800',
  enum: 'bg-violet-100 text-violet-800',
  integer: 'bg-amber-100 text-amber-800',
  double: 'bg-amber-100 text-amber-800',
  string: 'bg-ink-100 text-ink-700',
  'ipv4-address': 'bg-teal-100 text-teal-800',
  json: 'bg-rose-100 text-rose-800',
};

function buildRow(meta) {
  const current = values[meta.name];

  const nameNode = el('code', {
    class: 'break-all text-[12px] text-ink-800',
  }, [meta.name]);

  const noteNode = el('span', { class: 'text-[11px] text-ink-400' });

  const valueCell = el('div', { class: 'flex flex-wrap items-center gap-2' });

  const row = el('div', {
    class: 'grid grid-cols-1 gap-1 border-b border-ink-100 px-3 py-2 sm:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] sm:gap-3 sm:py-1.5',
    dataset: { name: meta.name },
  }, [
    el('div', { class: 'flex min-w-0 items-center gap-2' }, [
      nameNode,
      el('span', { class: `pill ${TYPE_BADGE[meta.type] || TYPE_BADGE.string}` }, [meta.type]),
      !meta.writable && el('span', { class: 'pill bg-ink-100 text-ink-500' }, ['read-only']),
      !meta.readable && el('span', { class: 'pill bg-ink-100 text-ink-500' }, ['write-only']),
    ]),
    el('div', { class: 'min-w-0' }, [valueCell, noteNode]),
  ]);

  const entry = { meta, row, valueCell, noteNode, nameNode, editor: null };
  renderValueCell(entry);
  rows.set(meta.name, entry);
  return row;
}

function renderValueCell(entry) {
  const { meta } = entry;
  const current = values[meta.name];

  if (!meta.writable) {
    const isSlow = (printer.schema.slow || []).includes(meta.name);
    replaceChildren(entry.valueCell, [
      el('span', {
        class: 'whitespace-pre-wrap break-all font-mono text-[12px] text-ink-600',
      }, [displayValue(current, isSlow)]),
      isSlow && el('button', {
        class: 'btn-secondary btn-sm',
        onclick: (event) => loadSlowSetting(meta.name, event.currentTarget),
      }, ['Read now']),
    ]);
    entry.editor = null;
  } else {
    const editor = buildEditor(meta, current, (value) => applyChange(entry, value));
    entry.editor = editor;
    replaceChildren(entry.valueCell, [
      editor,
      meta.default !== null && el('button', {
        class: 'btn-secondary btn-sm',
        title: `Factory default: ${meta.default}`,
        onclick: () => applyChange(entry, meta.default),
      }, ['Default']),
    ]);
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

/** file.dir and file.drive_listing are excluded from the helper files. */
async function loadSlowSetting(name, button) {
  button.disabled = true;
  button.textContent = 'reading…';
  try {
    const branchValues = await readBranch(name.split('.')[0]);
    Object.assign(values, branchValues);
    // The helper omits it, so ask the printer directly through the /dir page
    // only if the branch read did not produce it.
    if (values[name] === undefined) {
      toast(`${name} is not exposed by the helper files.`, 'error');
    }
    const entry = rows.get(name);
    if (entry) renderValueCell(entry);
  } catch (err) {
    toast(`Could not read ${name}: ${err.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Read now';
  }
}

/* ------------------------------------------------------------------ *
 * Filtering and rendering
 * ------------------------------------------------------------------ */

function matches(meta) {
  if (writableOnly && !meta.writable) return false;
  if (modifiedOnly && rows.get(meta.name)?.row.dataset.modified !== 'true') return false;
  if (!filterText) return true;
  const needle = filterText.toLowerCase();
  if (meta.name.toLowerCase().includes(needle)) return true;
  const value = values[meta.name];
  return value !== undefined && String(value).toLowerCase().includes(needle);
}

function applyFilter() {
  let shown = 0;
  for (const [name, entry] of rows) {
    const visible = matches(entry.meta);
    entry.row.hidden = !visible;
    if (visible) shown++;
  }
  countNode.textContent = shown === rows.size
    ? `${rows.size} settings`
    : `${shown} of ${rows.size} settings`;
  qs('#settings-empty').hidden = shown !== 0;
}

/* ------------------------------------------------------------------ *
 * Refresh
 * ------------------------------------------------------------------ */

async function refresh() {
  const branches = printer.schema.helperBranches || printer.schema.branches;
  refreshBtn.disabled = true;
  const progress = toast('Reading live values…', 'busy', { timeout: 0 });

  const { values: live, failed } = await readAllBranches(branches, (done, total, branch) => {
    progress.update(`Reading live values… ${done}/${total} (${branch})`, 'busy', { timeout: 0 });
  });

  Object.assign(values, live);
  for (const entry of rows.values()) renderValueCell(entry);
  applyFilter();

  refreshBtn.disabled = false;
  if (failed.length) {
    progress.update(`Read ${Object.keys(live).length} values; ${failed.length} branch(es) failed: ${failed.join(', ')}`, 'error', { timeout: 8000 });
  } else {
    progress.update(`Read ${Object.keys(live).length} live values`, 'success');
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

  listNode = el('div', { class: 'divide-y divide-ink-100' });
  for (const meta of allSettings()) listNode.append(buildRow(meta));

  panel.append(el('div', { class: 'card overflow-hidden' }, [
    el('div', { class: 'toolbar' }, [
      filterInput,
      toggle('Writable only', (v) => { writableOnly = v; }),
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
