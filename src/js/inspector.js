/*
 * inspector.js -- property panels for the label and for the selected element.
 *
 * Positions and sizes are stored in dots (what ZPL wants) but edited in
 * whatever unit the user picked, so every numeric field converts on the
 * way in and out.
 */

import { el, replaceChildren } from './ui.js';
import { printer, toDots, fromDots, unitStep, UNITS } from './state.js';
import { SYMBOLOGIES, ROTATIONS, FONTS } from './zpl.js';

/* ------------------------------------------------------------------ *
 * Field builders
 * ------------------------------------------------------------------ */

function row(labelText, control, { wide = false } = {}) {
  return el('label', { class: wide ? 'block space-y-1' : 'block space-y-1' }, [
    el('span', { class: 'label-text' }, [labelText]),
    control,
  ]);
}

function numberField(value, onCommit, { min, max, step = 1, suffix } = {}) {
  const input = el('input', {
    class: 'field field-mono', type: 'number', value: String(value ?? ''), step: String(step),
  });
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  const fire = () => {
    const n = parseFloat(input.value);
    if (Number.isFinite(n)) onCommit(n);
  };
  input.addEventListener('change', fire);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fire(); } });
  if (!suffix) return input;
  return el('div', { class: 'flex items-center gap-1' }, [
    input, el('span', { class: 'text-[11px] text-ink-400' }, [suffix]),
  ]);
}

/** A number field that stores dots but shows the document's unit. */
function dotsField(dots, unit, onCommit) {
  return numberField(fromDots(dots, unit), (n) => onCommit(toDots(n, unit)), {
    min: 0, step: unitStep(unit), suffix: unit,
  });
}

function selectField(value, options, onCommit) {
  const select = el('select', { class: 'field' });
  for (const opt of options) {
    const [optValue, optLabel] = Array.isArray(opt) ? opt : [opt.value, opt.label];
    select.append(el('option', { value: optValue, selected: String(optValue) === String(value) }, [optLabel]));
  }
  select.addEventListener('change', () => onCommit(select.value));
  return select;
}

function textField(value, onCommit, { multiline = false, placeholder = '' } = {}) {
  const node = multiline
    ? el('textarea', { class: 'field field-mono', rows: '3', spellcheck: 'false', placeholder }, [value ?? ''])
    : el('input', { class: 'field field-mono', type: 'text', value: value ?? '', placeholder, spellcheck: 'false' });
  node.addEventListener('change', () => onCommit(node.value));
  node.addEventListener('blur', () => onCommit(node.value));
  if (!multiline) {
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); node.blur(); } });
  }
  return node;
}

function checkField(labelText, checked, onCommit) {
  const box = el('input', { type: 'checkbox', class: 'h-3.5 w-3.5 accent-ink-900', checked });
  box.addEventListener('change', () => onCommit(box.checked));
  return el('label', { class: 'flex items-center gap-2 pt-5 text-ink-700' }, [box, labelText]);
}

function grid(children) {
  return el('div', { class: 'grid grid-cols-2 gap-3' }, children);
}

function section(title, children) {
  return el('div', { class: 'space-y-3 border-b border-ink-200 px-3 py-3 last:border-b-0' }, [
    el('h3', { class: 'text-[11px] font-semibold uppercase tracking-wide text-ink-500' }, [title]),
    ...children,
  ]);
}

/* ------------------------------------------------------------------ *
 * Label setup
 * ------------------------------------------------------------------ */

/**
 * Panel for the label itself: size, orientation and the print settings
 * that ride along in the ZPL rather than being changed on the printer.
 */
export function renderLabelPanel(host, { doc, onChange }) {
  const unit = doc.unit;
  const commit = (fn) => (value) => { fn(value); onChange(); };

  replaceChildren(host, [
    section('Label', [
      grid([
        row('Units', selectField(unit, UNITS.map((u) => [u, u]), commit((v) => { doc.unit = v; }))),
        row('Orientation', selectField(doc.orientation, [
          ['N', 'Normal'], ['I', 'Inverted 180°'],
        ], commit((v) => { doc.orientation = v; }))),
      ]),
      grid([
        row('Width', dotsField(doc.width, unit, commit((v) => { doc.width = Math.max(8, v); }))),
        row('Height', dotsField(doc.height, unit, commit((v) => { doc.height = Math.max(8, v); }))),
      ]),
      el('p', { class: 'text-[11px] text-ink-400' }, [
        `${doc.width} × ${doc.height} dots at ${printer.dpi} dpi`,
      ]),
    ]),

    section('Print', [
      grid([
        // ^MD is an adjustment to the printer's configured darkness, not
        // an absolute value, so it is signed and centred on zero.
        row('Darkness adj.', numberField(doc.darkness ?? '', commit((v) => { doc.darkness = v; }), { min: -30, max: 30 })),
        row('Speed', numberField(doc.speed ?? '', commit((v) => { doc.speed = v; }), { min: 1, max: 14, suffix: 'ips' })),
      ]),
      grid([
        row('Media', selectField(doc.mediaType ?? '', [
          ['', 'Printer setting'], ['N', 'Continuous'], ['Y', 'Web / gap'], ['M', 'Black mark'],
        ], commit((v) => { doc.mediaType = v || null; }))),
        row('Copies', numberField(doc.copies, commit((v) => { doc.copies = Math.max(1, Math.round(v)); }), { min: 1, max: 999 })),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Element properties
 * ------------------------------------------------------------------ */

/** Panel for the selected element, or a hint when nothing is selected. */
export function renderElementPanel(host, { doc, item, images, onChange, onDelete, onDuplicate }) {
  if (!item) {
    replaceChildren(host, [
      el('p', { class: 'px-3 py-4 text-ink-400' }, [
        'Select an element on the label to edit it, or add one from the toolbar.',
      ]),
    ]);
    return;
  }

  const unit = doc.unit;
  const commit = (fn) => (value) => { fn(value); onChange(); };

  const common = section('Position', [
    grid([
      row('X', dotsField(item.x, unit, commit((v) => { item.x = Math.max(0, v); }))),
      row('Y', dotsField(item.y, unit, commit((v) => { item.y = Math.max(0, v); }))),
    ]),
    item.type !== 'box' && item.type !== 'line'
      ? row('Rotation', selectField(item.rotation, ROTATIONS, commit((v) => { item.rotation = v; })))
      : null,
  ].filter(Boolean));

  const specific = [];

  if (item.type === 'text') {
    specific.push(section('Text', [
      row('Content', textField(item.text, commit((v) => { item.text = v; }), { multiline: true })),
      grid([
        row('Font', selectField(item.font, FONTS, commit((v) => { item.font = v; }))),
        row('Height', dotsField(item.height, unit, commit((v) => { item.height = Math.max(4, v); }))),
      ]),
      grid([
        row('Char width', dotsField(item.width || 0, unit, commit((v) => { item.width = v; }))),
        checkField('Reverse (white on black)', item.reverse, commit((v) => { item.reverse = v; })),
      ]),
      grid([
        // ^FB wraps the field into a block; zero means no wrapping.
        row('Wrap width', dotsField(item.blockWidth || 0, unit, commit((v) => { item.blockWidth = v; }))),
        row('Max lines', numberField(item.blockLines || 1, commit((v) => { item.blockLines = Math.max(1, Math.round(v)); }), { min: 1, max: 9999 })),
      ]),
      item.blockWidth > 0
        ? row('Justify', selectField(item.justify || 'L', [['L', 'Left'], ['C', 'Centre'], ['R', 'Right'], ['J', 'Justified']], commit((v) => { item.justify = v; })))
        : null,
    ].filter(Boolean)));
  }

  if (item.type === 'field') {
    specific.push(section('Variable field', [
      grid([
        row('Field number', numberField(item.number, commit((v) => { item.number = Math.max(0, Math.round(v)); }), { min: 0, max: 9999 })),
        row('Name', textField(item.name, commit((v) => { item.name = v.replace(/"/g, ''); }), { placeholder: 'optional' })),
      ]),
      grid([
        row('Font', selectField(item.font, FONTS, commit((v) => { item.font = v; }))),
        row('Height', dotsField(item.height, unit, commit((v) => { item.height = Math.max(4, v); }))),
      ]),
      row('Default value', textField(item.initial, commit((v) => { item.initial = v; }), { placeholder: 'used when no data is supplied' })),
      el('p', { class: 'text-[11px] text-ink-400' }, [
        'Saved as ^FN. Fill it in from the Format Printer tab, or from a host that recalls this format.',
      ]),
    ]));
  }

  if (item.type === 'barcode') {
    const spec = SYMBOLOGIES[item.symbology] || SYMBOLOGIES.code128;
    const fields = [
      row('Symbology', selectField(item.symbology,
        Object.entries(SYMBOLOGIES).map(([key, s]) => [key, s.label]),
        commit((v) => { item.symbology = v; }))),
      row('Data', textField(item.data, commit((v) => { item.data = v; }), { multiline: true })),
    ];

    if (spec.kind === '1d') {
      fields.push(grid([
        row('Bar height', dotsField(item.height, unit, commit((v) => { item.height = Math.max(4, v); }))),
        row('Module width', numberField(item.moduleWidth, commit((v) => { item.moduleWidth = Math.min(10, Math.max(1, Math.round(v))); }), { min: 1, max: 10, suffix: 'dots' })),
      ]));
      fields.push(grid([
        row('Wide:narrow', numberField(item.ratio, commit((v) => { item.ratio = v; }), { min: 2, max: 3, step: 0.1 })),
        checkField('Print interpretation line', item.showText, commit((v) => { item.showText = v; })),
      ]));
    } else {
      fields.push(grid([
        row('Magnification', numberField(item.magnification, commit((v) => { item.magnification = Math.min(20, Math.max(1, Math.round(v))); }), { min: 1, max: 20 })),
        item.symbology === 'qr'
          ? row('Error correction', selectField(item.errorLevel, [['H', 'H — 30%'], ['Q', 'Q — 25%'], ['M', 'M — 15%'], ['L', 'L — 7%']], commit((v) => { item.errorLevel = v; })))
          : row('Module width', numberField(item.moduleWidth, commit((v) => { item.moduleWidth = Math.max(1, Math.round(v)); }), { min: 1, max: 20 })),
      ]));
    }
    specific.push(section('Barcode', fields));
  }

  if (item.type === 'image') {
    const options = [['', '— choose a stored image —']];
    for (const file of images) options.push([file.name, file.name]);
    if (item.source && !images.some((f) => f.name === item.source)) {
      options.push([item.source, `${item.source} (not on this printer)`]);
    }
    specific.push(section('Image', [
      row('Stored object', selectField(item.source, options, commit((v) => {
        item.source = v;
        delete item.naturalWidth;
        delete item.naturalHeight;
      }))),
      el('p', { class: 'text-[11px] text-ink-400' }, [
        '^IM places a stored image at its own size. Upload images to the printer, then pick one here.',
      ]),
    ]));
  }

  if (item.type === 'box') {
    specific.push(section('Box', [
      grid([
        row('Width', dotsField(item.w, unit, commit((v) => { item.w = Math.max(1, v); }))),
        row('Height', dotsField(item.h, unit, commit((v) => { item.h = Math.max(1, v); }))),
      ]),
      grid([
        row('Line thickness', numberField(item.thickness, commit((v) => { item.thickness = Math.max(1, Math.round(v)); }), { min: 1, max: 200, suffix: 'dots' })),
        row('Corner rounding', numberField(item.rounding, commit((v) => { item.rounding = Math.min(8, Math.max(0, Math.round(v))); }), { min: 0, max: 8 })),
      ]),
      checkField('White (knock out)', item.invert, commit((v) => { item.invert = v; })),
    ]));
  }

  if (item.type === 'line') {
    specific.push(section('Line', [
      grid([
        row('Length', dotsField(item.length, unit, commit((v) => { item.length = Math.max(1, v); }))),
        row('Thickness', numberField(item.thickness, commit((v) => { item.thickness = Math.max(1, Math.round(v)); }), { min: 1, max: 200, suffix: 'dots' })),
      ]),
      checkField('Vertical', item.vertical, commit((v) => { item.vertical = v; })),
    ]));
  }

  const actions = el('div', { class: 'flex gap-2 px-3 py-3' }, [
    el('button', { class: 'btn-secondary btn-sm', onclick: onDuplicate }, ['Duplicate']),
    el('button', { class: 'btn-danger btn-sm', onclick: onDelete }, ['Delete']),
  ]);

  replaceChildren(host, [common, ...specific, actions]);
}
