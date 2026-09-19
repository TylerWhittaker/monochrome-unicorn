/*
 * format.js -- Mode 3: fill in the fields of a stored label format.
 *
 * A format on the printer marks its variable parts with ^FN. Recalling it
 * with ^XF and following that with one ^FN/^FD pair per field lets the
 * printer do the layout, so this mode never has to understand the format
 * itself -- it only has to find the field numbers and collect values.
 */

import { el, toast, confirmDialog, debounce, formatBytes, replaceChildren } from './ui.js';
import { printer } from './state.js';
import { listFiles, readScript } from './printer.js';
import { findFieldNumbers, buildFormatCall } from './zpl.js';
import { createPreview } from './preview.js';

const formatState = {
  formats: [],
  current: null,
  source: '',
  fields: [],
  /** Field number -> current value. */
  values: new Map(),
  copies: 1,
};

let formatSelect = null;
let fieldsHost = null;
let sourceHost = null;
let formatPreview = null;
let printBtn = null;
let summaryNode = null;

/* ------------------------------------------------------------------ *
 * ZPL for the current selection
 * ------------------------------------------------------------------ */

function formatZpl() {
  if (!formatState.current) return '';
  const name = `${formatState.current.oname}.${formatState.current.otype}`;
  const pairs = formatState.fields.map((f) => [f.number, formatState.values.get(f.number) ?? '']);
  let zpl = buildFormatCall(formatState.current.dev, name, pairs);
  if (formatState.copies > 1) zpl = zpl.replace('^XZ', `^PQ${formatState.copies}\n^XZ`);
  return zpl;
}

const scheduleFormatPreview = debounce(() => {
  if (formatState.current) formatPreview.update(formatZpl());
}, 600);

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function fieldLabel(field) {
  return field.name ? `${field.name}  (^FN${field.number})` : `Field ${field.number}`;
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

  if (formatState.fields.length === 0) {
    replaceChildren(fieldsHost, [
      el('div', { class: 'px-3 py-6 text-center' }, [
        el('p', { class: 'text-ink-500' }, ['This format has no ^FN fields, so there is nothing to fill in.']),
        el('p', { class: 'mt-1 text-[11px] text-ink-400' }, ['You can still preview and print it as it stands.']),
      ]),
    ]);
    return;
  }

  const rows = formatState.fields.map((field) => {
    const input = el('input', {
      class: 'field',
      type: 'text',
      value: formatState.values.get(field.number) ?? '',
      placeholder: field.initial ? `default: ${field.initial}` : '',
      autocomplete: 'off',
    });
    input.addEventListener('input', () => {
      formatState.values.set(field.number, input.value);
      scheduleFormatPreview();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        // Enter moves to the next field, and prints from the last one.
        const inputs = [...fieldsHost.querySelectorAll('input')];
        const next = inputs[inputs.indexOf(input) + 1];
        if (next) next.focus(); else printFormatLabel();
      }
    });

    return el('label', { class: 'block space-y-1 px-3 py-2' }, [
      el('span', { class: 'label-text' }, [fieldLabel(field)]),
      input,
    ]);
  });

  replaceChildren(fieldsHost, [
    el('div', { class: 'divide-y divide-ink-100' }, rows),
    el('div', { class: 'flex items-center justify-between gap-3 border-t border-ink-200 px-3 py-2' }, [
      el('button', {
        class: 'btn-secondary btn-sm',
        onclick: () => {
          for (const field of formatState.fields) formatState.values.set(field.number, field.initial || '');
          renderFields();
          scheduleFormatPreview();
        },
      }, ['Reset to defaults']),
      el('button', {
        class: 'btn-secondary btn-sm',
        onclick: () => { formatPreview.update(formatZpl()); },
      }, ['Preview now']),
    ]),
  ]);
}

function renderSource() {
  if (!formatState.current) { replaceChildren(sourceHost, []); return; }

  const pre = el('pre', {
    class: 'max-h-64 overflow-auto bg-ink-50 px-3 py-2 font-mono text-[11px] leading-snug text-ink-700',
  }, [formatState.source]);

  const details = el('details', { class: 'border-t border-ink-200' }, [
    el('summary', { class: 'cursor-pointer px-3 py-2 text-[12px] text-ink-600' }, ['Format source']),
    pre,
  ]);
  replaceChildren(sourceHost, [details]);
}

function renderSummary() {
  if (!formatState.current) { summaryNode.textContent = ''; return; }
  const count = formatState.fields.length;
  summaryNode.textContent = `${count} field${count === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function refreshFormats() {
  try {
    const files = await listFiles({ dev: 'E', otype: 'ZPL' });
    formatState.formats = files;
  } catch (err) {
    toast(`Could not list stored formats: ${err.message}`, 'error');
    return;
  }

  const selected = formatState.current ? `${formatState.current.dev}:${formatState.current.oname}` : '';
  formatSelect.replaceChildren(el('option', { value: '' }, ['— choose a format —']));
  for (const file of formatState.formats) {
    formatSelect.append(el('option', {
      value: `${file.dev}:${file.oname}`,
      selected: `${file.dev}:${file.oname}` === selected,
    }, [`${file.name}  (${formatBytes(file.bytes)})`]));
  }

  if (formatState.formats.length === 0) {
    toast('No .ZPL formats are stored on this printer yet.', 'info');
  }
}

async function selectFormat(value) {
  if (!value) {
    formatState.current = null;
    formatState.fields = [];
    formatState.values.clear();
    renderFields();
    renderSource();
    renderSummary();
    formatPreview.idle('Choose a format to see it rendered.');
    return;
  }

  const [dev, oname] = value.split(':');
  const busy = toast(`Reading ${dev}:${oname}.ZPL…`, 'busy', { timeout: 0 });
  try {
    const source = await readScript({ dev, oname, otype: 'ZPL' });
    formatState.current = { dev, oname, otype: 'ZPL' };
    formatState.source = source;
    formatState.fields = findFieldNumbers(source);
    formatState.values = new Map(formatState.fields.map((f) => [f.number, f.initial || '']));
    busy.close();
  } catch (err) {
    busy.update(`Could not read ${oname}: ${err.message}`, 'error');
    return;
  }

  renderFields();
  renderSource();
  renderSummary();
  formatPreview.update(formatZpl());

  const first = fieldsHost.querySelector('input');
  if (first) first.focus();
}

async function printFormatLabel() {
  if (!formatState.current) return;
  const ok = await confirmDialog(
    'Print this label?',
    formatState.copies > 1
      ? `${formatState.copies} copies of ${formatState.current.oname}.ZPL will be printed.`
      : `One copy of ${formatState.current.oname}.ZPL will be printed.`,
    'Print'
  );
  if (!ok) return;
  formatPreview.print(formatZpl());
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export function mountFormat(panel) {
  formatSelect = el('select', { class: 'field w-full min-w-0 sm:w-72' });
  formatSelect.addEventListener('change', () => selectFormat(formatSelect.value));

  const copiesInput = el('input', {
    class: 'field field-mono w-20', type: 'number', min: '1', max: '999', value: '1',
  });
  copiesInput.addEventListener('change', () => {
    formatState.copies = Math.max(1, Math.round(Number(copiesInput.value) || 1));
    copiesInput.value = String(formatState.copies);
  });

  printBtn = el('button', { class: 'btn-primary btn-sm', onclick: () => printFormatLabel(), disabled: true }, ['Print']);
  summaryNode = el('span', { class: 'text-[11px] text-ink-500' });

  fieldsHost = el('div');
  sourceHost = el('div');
  formatPreview = createPreview();

  panel.append(el('div', { class: 'grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]' }, [
    el('div', { class: 'card min-w-0 overflow-hidden' }, [
      el('div', { class: 'toolbar' }, [
        formatSelect,
        el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, ['Copies', copiesInput]),
        el('div', { class: 'ml-auto flex items-center gap-3' }, [summaryNode, printBtn]),
      ]),
      fieldsHost,
      sourceHost,
    ]),
    el('div', { class: 'min-w-0' }, [formatPreview.node]),
  ]));

  renderFields();
  formatPreview.idle('Choose a format to see it rendered.');
  refreshFormats();
}

/** Stored formats can change from the Label Editor, so re-read the list. */
export function onFormatShown() {
  refreshFormats();
}
