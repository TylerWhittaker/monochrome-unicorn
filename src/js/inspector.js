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
 * inspector.js -- property panels for the label and for the selected element.
 *
 * Positions and sizes are stored in dots (what ZPL wants) but edited in
 * whatever unit the user picked, so every numeric field converts on the
 * way in and out.
 */

import { el, replaceChildren } from './ui.js';
import { printer, toDots, fromDots, unitStep, unitStepFine, saveUnitPreference } from './state.js';
import {
  SYMBOLOGIES,
  ROTATIONS,
  FONTS,
  DATE_FORMATS,
  CLOCK_CODES,
  DATABAR_TYPES,
  TEXT_DIRECTIONS,
  expandClock,
  primaryClockIndicator,
  isStoredFont,
} from './zpl.js';

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

/** TrueType fonts stored on the printer, as {value, label}. */
let storedFontList = [];

/** Take the printer's stored fonts, from its drive listing. */
export function setStoredFonts(list) {
  storedFontList = list || [];
}

/**
 * The font list for one element: the built-in fonts, the printer's
 * stored ones, and the element's own if it names one this printer does
 * not have -- it still prints somewhere, so it is not quietly changed.
 */
function fontOptions(current) {
  const options = [...FONTS, ...storedFontList];
  if (current && !options.some((f) => f.value === current)) {
    options.push({
      value: current,
      label: isStoredFont(current) ? `${current} (not on this printer)` : `Font ${current}`,
    });
  }
  return options;
}

/* ------------------------------------------------------------------ *
 * Field builders
 * ------------------------------------------------------------------ */

function row(labelText, control, { wide = false } = {}) {
  return el('label', { class: wide ? 'block space-y-1' : 'block space-y-1' }, [
    el('span', { class: 'label-text' }, [labelText]),
    control,
  ]);
}

/**
 * A number box. `optional` ones may be left empty, which commits null --
 * "leave it to the printer" -- and says so in grey.
 */
function numberField(value, onCommit, { min, max, step = 1, suffix, optional = false } = {}) {
  const input = el('input', {
    class: 'field field-mono',
    type: 'number',
    value: String(value ?? ''),
    step: String(step),
    placeholder: optional ? 'default' : '',
  });
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  const fire = () => {
    if (optional && input.value.trim() === '') {
      onCommit(null);
      return;
    }
    const n = parseFloat(input.value);
    if (Number.isFinite(n)) onCommit(n);
  };
  input.addEventListener('change', fire);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fire();
    }
  });
  if (!suffix) return input;
  return el('div', { class: 'flex items-center gap-1' }, [
    input,
    el('span', { class: 'text-[11px] text-ink-400' }, [suffix]),
  ]);
}

/**
 * A number field that stores dots but shows the document's unit.
 *
 * `fine` is for the fields only a few dots across -- module widths, line
 * thicknesses -- where the normal step would move them in huge jumps.
 */
function dotsField(dots, unit, onCommit, { fine = false, maxDots } = {}) {
  return numberField(fromDots(dots, unit), (n) => onCommit(toDots(n, unit)), {
    min: 0,
    max: maxDots === undefined ? undefined : fromDots(maxDots, unit),
    step: fine ? unitStepFine(unit) : unitStep(unit),
    suffix: unit,
  });
}

/**
 * A set of radio buttons. Used for the unit choice, which drives every
 * length in the editor and so deserves to be visible rather than folded
 * into a dropdown.
 */
function radioField(groupName, value, options, onCommit) {
  const buttons = options.map(([optValue, optLabel]) => {
    const input = el('input', {
      class: 'h-3.5 w-3.5 accent-ink-900',
      type: 'radio',
      name: groupName,
      value: optValue,
      checked: String(optValue) === String(value),
    });
    input.addEventListener('change', () => {
      if (input.checked) onCommit(optValue);
    });
    return el('label', { class: 'flex cursor-pointer items-center gap-1.5 text-ink-700' }, [
      input,
      optLabel,
    ]);
  });
  return el('div', { class: 'flex flex-wrap items-center gap-x-4 gap-y-1' }, buttons);
}

function selectField(value, options, onCommit, { emptyIsDefault = false } = {}) {
  const select = el('select', { class: 'field' });
  for (const opt of options) {
    const [optValue, optLabel] = Array.isArray(opt) ? opt : [opt.value, opt.label];
    select.append(
      el(
        'option',
        {
          value: optValue,
          selected: String(optValue) === String(value),
          // The grey is for the closed box; the open list stays readable.
          class: emptyIsDefault ? 'text-ink-900' : null,
        },
        [optLabel],
      ),
    );
  }
  // Where empty means "default", grey it like an empty box's placeholder.
  const shade = () =>
    select.classList.toggle('text-ink-400', emptyIsDefault && select.value === '');
  shade();
  select.addEventListener('change', () => {
    shade();
    onCommit(select.value);
  });
  return select;
}

function textField(value, onCommit, { multiline = false, placeholder = '' } = {}) {
  const node = multiline
    ? el('textarea', { class: 'field field-mono', rows: '3', spellcheck: 'false', placeholder }, [
        value ?? '',
      ])
    : el('input', {
        class: 'field field-mono',
        type: 'text',
        value: value ?? '',
        placeholder,
        spellcheck: 'false',
      });
  node.addEventListener('change', () => onCommit(node.value));
  node.addEventListener('blur', () => onCommit(node.value));
  if (!multiline) {
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        node.blur();
      }
    });
  }
  return node;
}

function checkField(labelText, checked, onCommit) {
  const box = el('input', { type: 'checkbox', class: 'h-3.5 w-3.5 accent-ink-900', checked });
  box.addEventListener('change', () => onCommit(box.checked));
  return el('label', { class: 'flex items-center gap-2 pt-5 text-ink-700' }, [box, labelText]);
}

/**
 * Whether a field counts up (or down) from label to label: ^SN, with its
 * step and whether it keeps its leading zeros. The value in the content
 * box is where it starts.
 */
function serialRows(item, commit) {
  const rows = [
    checkField(
      'Serial number (changes each label)',
      !!item.serial,
      commit((v) => {
        item.serial = v ? { step: 1, zeros: true } : null;
      }),
    ),
  ];
  if (item.serial) {
    rows.push(
      grid([
        row(
          'Step',
          numberField(
            item.serial.step,
            commit((v) => {
              item.serial.step = Math.round(v) || 1;
            }),
            { min: -999999, max: 999999 },
          ),
        ),
        checkField(
          'Keep leading zeros',
          item.serial.zeros,
          commit((v) => {
            item.serial.zeros = v;
          }),
        ),
      ]),
      el('p', { class: 'text-[11px] text-ink-400' }, [
        'Saved as ^SN. The printer counts from the last number in the value; a negative ' +
          'step counts down. Commas, ^ and ~ cannot be part of it.',
      ]),
    );
  }
  // The checkbox row carries a top pad for sitting beside a box; alone, not.
  rows[0].classList.remove('pt-5');
  return rows;
}

function grid(children) {
  return el('div', { class: 'grid grid-cols-2 gap-3' }, children);
}

/** Radio labels for the unit choice. */
const UNIT_LABELS = [
  ['in', 'inches'],
  ['mm', 'mm'],
  ['dots', 'dots'],
];

/** The heading strip that names one of the two property boxes. */
export function panelHeading(title, subtitle) {
  return el('div', { class: 'border-b border-ink-200 bg-ink-50/70 px-3 py-2' }, [
    el('h2', { class: 'text-[12px] font-semibold text-ink-700' }, [title]),
    subtitle ? el('p', { class: 'text-[11px] text-ink-400' }, [subtitle]) : null,
  ]);
}

function section(title, children) {
  return el('div', { class: 'space-y-3 border-b border-ink-200 px-3 py-3 last:border-b-0' }, [
    el('h3', { class: 'text-[11px] font-semibold uppercase tracking-wide text-ink-500' }, [title]),
    ...children,
  ]);
}

/**
 * Properties of a clock field: what it prints, in which font.
 *
 * The format is the ^FD, codes and all; the list of common ones is only a
 * way to fill it in, and says "Custom" for anything else.
 */
function dateSection(item, unit, commit) {
  const ind = primaryClockIndicator(item.clock);
  // The presets are written with %, so they follow the indicator in use.
  const withIndicator = (format) => format.replace(/%(?=[A-Za-z])/g, ind);
  const presets = DATE_FORMATS.map((f) => [withIndicator(f.value), f.label]);
  const isPreset = presets.some(([value]) => value === item.format);

  return section('Date / time', [
    row(
      'Common formats',
      selectField(
        isPreset ? item.format : '',
        [...(isPreset ? [] : [['', 'Custom']]), ...presets],
        commit((v) => {
          if (v) item.format = v;
        }),
      ),
    ),
    row(
      'Format',
      textField(
        item.format,
        commit((v) => {
          item.format = v;
        }),
        { placeholder: `${ind}m/${ind}d/${ind}Y` },
      ),
    ),
    el('p', { class: 'text-[11px] text-ink-400' }, [
      `Prints as “${expandClock(item.format, item.clock)}” now, by this computer's clock. ` +
        'The printer uses its own when it prints; the preview shows that. ' +
        'Saved as ^FC with ^FD.',
    ]),
    el('details', { class: 'text-[11px] text-ink-500' }, [
      el('summary', { class: 'cursor-pointer select-none' }, ['Codes']),
      el(
        'dl',
        { class: 'mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5' },
        CLOCK_CODES.flatMap(([code, meaning]) => [
          el('dt', { class: 'font-mono text-ink-700' }, [ind + code]),
          el('dd', {}, [meaning]),
        ]),
      ),
    ]),
    grid([
      row(
        'Font',
        selectField(
          item.font,
          fontOptions(item.font),
          commit((v) => {
            item.font = v;
          }),
        ),
      ),
      row(
        'Height',
        dotsField(
          item.height,
          unit,
          commit((v) => {
            item.height = Math.max(4, v);
          }),
        ),
      ),
    ]),
    grid([
      charWidthRow(item, unit, commit),
      checkField(
        'Reverse (white on black)',
        item.reverse,
        commit((v) => {
          item.reverse = v;
        }),
      ),
    ]),
    row(
      'Clock indicator',
      textField(
        ind,
        commit((v) => {
          const next = v.trim()[0];
          // ^, ~ and , are ZPL's own; _ is ^FH's escape.
          if (!next || '^~,_'.includes(next) || next === ind) return;
          // Only where it starts a code: a literal % elsewhere stays one.
          item.format = [...item.format]
            .map((ch, i, all) => (ch === ind && /[A-Za-z]/.test(all[i + 1] || '') ? next : ch))
            .join('');
          item.clock = next + String(item.clock || '%').slice(1);
        }),
      ),
    ),
  ]);
}

/**
 * Which way a line runs. The diagonals keep the box of the straight line
 * they were: its length across, and a third of that down.
 */
function lineDirectionRow(item, commit) {
  const current = item.diagonal ? `d${item.lean === 'L' ? 'L' : 'R'}` : item.vertical ? 'v' : 'h';
  return row(
    'Direction',
    selectField(
      current,
      [
        ['h', 'Horizontal'],
        ['v', 'Vertical'],
        ['dR', 'Diagonal /'],
        ['dL', 'Diagonal \\'],
      ],
      commit((v) => {
        if (v[0] === 'd') {
          if (!item.diagonal) {
            item.w = item.length;
            item.h = Math.max(1, Math.round(item.length / 3));
          }
          item.diagonal = true;
          item.lean = v[1];
        } else {
          if (item.diagonal) item.length = item.w;
          item.diagonal = false;
          item.vertical = v === 'v';
        }
      }),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Label setup
 * ------------------------------------------------------------------ */

/**
 * Char width follows the height until it is set to something else: 0 in
 * the model, shown as the height it prints at. Setting it back to the
 * height locks the two together again.
 */
function charWidthRow(item, unit, commit) {
  const locked = !item.width;
  return row(
    locked ? 'Char width (= height)' : 'Char width',
    dotsField(
      item.width || item.height,
      unit,
      commit((v) => {
        item.width = v === item.height ? 0 : v;
      }),
    ),
  );
}

/**
 * Panel for the label itself: size, orientation and the print settings
 * that ride along in the ZPL rather than being changed on the printer.
 */
export function renderLabelPanel(host, { doc, onChange }) {
  const unit = doc.unit;
  const commit = (fn) => (value) => {
    fn(value);
    onChange();
  };

  replaceChildren(host, [
    section('Label', [
      // Drives every length in the editor, so it sits on its own row.
      row(
        'Units',
        radioField(
          'label-units',
          unit,
          UNIT_LABELS,
          commit((v) => {
            doc.unit = v;
            saveUnitPreference(v);
          }),
        ),
      ),
      row(
        'Orientation',
        selectField(
          doc.orientation,
          [
            ['N', 'Normal'],
            ['I', 'Inverted 180°'],
          ],
          commit((v) => {
            doc.orientation = v;
          }),
        ),
      ),
      grid([
        row(
          'Width',
          dotsField(
            doc.width,
            unit,
            commit((v) => {
              doc.width = Math.max(8, v);
            }),
          ),
        ),
        row(
          'Height',
          dotsField(
            doc.height,
            unit,
            commit((v) => {
              doc.height = Math.max(8, v);
            }),
          ),
        ),
      ]),
      el('p', { class: 'text-[11px] text-ink-400' }, [
        `${doc.width} × ${doc.height} dots at ${printer.dpi} dpi`,
      ]),
    ]),

    section('Print', [
      grid([
        // ^MD is an adjustment to the printer's configured darkness, not
        // an absolute value, so it is signed and centred on zero.
        row(
          'Darkness adj.',
          numberField(
            doc.darkness ?? '',
            commit((v) => {
              doc.darkness = v;
            }),
            { min: -30, max: 30, optional: true },
          ),
        ),
        row(
          'Speed',
          numberField(
            doc.speed ?? '',
            commit((v) => {
              doc.speed = v;
            }),
            { min: 1, max: 14, suffix: 'ips', optional: true },
          ),
        ),
      ]),
      // How many to print is beside the Print button, not here.
      grid([
        row(
          'Media',
          selectField(
            doc.mediaType ?? '',
            [
              ['', 'default'],
              ['N', 'Continuous'],
              ['Y', 'Web / gap'],
              ['M', 'Black mark'],
            ],
            commit((v) => {
              doc.mediaType = v || null;
            }),
            { emptyIsDefault: true },
          ),
        ),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Element properties
 * ------------------------------------------------------------------ */

/** Panel for the selected element, or a hint when nothing is selected. */
export function renderElementPanel(
  host,
  { doc, item, images, onChange, onDelete, onDuplicate, onUploadImage },
) {
  if (!item) {
    replaceChildren(host, [
      el('p', { class: 'px-3 py-4 text-ink-400' }, [
        'Select an element on the label to edit it, or add one from the toolbar.',
      ]),
    ]);
    return;
  }

  const unit = doc.unit;
  const commit = (fn) => (value) => {
    fn(value);
    onChange();
  };

  const common = section(
    'Position',
    [
      grid([
        row(
          'X',
          dotsField(
            item.x,
            unit,
            commit((v) => {
              item.x = Math.max(0, v);
            }),
          ),
        ),
        row(
          'Y',
          dotsField(
            item.y,
            unit,
            commit((v) => {
              item.y = Math.max(0, v);
            }),
          ),
        ),
      ]),
      !['box', 'line', 'ellipse'].includes(item.type) && item.symbology !== 'maxicode'
        ? row(
            'Rotation',
            selectField(
              item.rotation,
              ROTATIONS,
              commit((v) => {
                item.rotation = v;
              }),
            ),
          )
        : null,
    ].filter(Boolean),
  );

  const specific = [];

  if (item.type === 'text') {
    specific.push(
      section(
        'Text',
        [
          row(
            item.serial ? 'Starting value' : 'Content',
            textField(
              item.text,
              commit((v) => {
                item.text = v;
              }),
              { multiline: !item.serial },
            ),
          ),
          ...serialRows(item, commit),
          grid([
            row(
              'Font',
              selectField(
                item.font,
                fontOptions(item.font),
                commit((v) => {
                  item.font = v;
                }),
              ),
            ),
            row(
              'Height',
              dotsField(
                item.height,
                unit,
                commit((v) => {
                  item.height = Math.max(4, v);
                }),
              ),
            ),
          ]),
          grid([
            charWidthRow(item, unit, commit),
            checkField(
              'Reverse (white on black)',
              item.reverse,
              commit((v) => {
                item.reverse = v;
              }),
            ),
          ]),
          row(
            'Direction',
            selectField(
              item.direction || 'H',
              TEXT_DIRECTIONS,
              commit((v) => {
                item.direction = v;
              }),
            ),
          ),
          grid([
            // ^FB wraps the field into a block; zero means no wrapping.
            row(
              'Wrap width',
              dotsField(
                item.blockWidth || 0,
                unit,
                commit((v) => {
                  item.blockWidth = v;
                }),
              ),
            ),
            row(
              'Max lines',
              numberField(
                item.blockLines || 1,
                commit((v) => {
                  item.blockLines = Math.max(1, Math.round(v));
                }),
                { min: 1, max: 9999 },
              ),
            ),
          ]),
          item.blockWidth > 0
            ? row(
                'Justify',
                selectField(
                  item.justify || 'L',
                  [
                    ['L', 'Left'],
                    ['C', 'Centre'],
                    ['R', 'Right'],
                    ['J', 'Justified'],
                  ],
                  commit((v) => {
                    item.justify = v;
                  }),
                ),
              )
            : null,
        ].filter(Boolean),
      ),
    );
  }

  if (item.type === 'field') {
    specific.push(
      section('Variable field', [
        grid([
          row(
            'Field number',
            numberField(
              item.number,
              commit((v) => {
                item.number = Math.max(0, Math.round(v));
              }),
              { min: 0, max: 9999 },
            ),
          ),
          row(
            'Name',
            textField(
              item.name,
              commit((v) => {
                item.name = v.replace(/"/g, '');
              }),
              { placeholder: 'optional' },
            ),
          ),
        ]),
        grid([
          row(
            'Font',
            selectField(
              item.font,
              fontOptions(item.font),
              commit((v) => {
                item.font = v;
              }),
            ),
          ),
          row(
            'Height',
            dotsField(
              item.height,
              unit,
              commit((v) => {
                item.height = Math.max(4, v);
              }),
            ),
          ),
        ]),
        row(
          'Default value',
          textField(
            item.initial,
            commit((v) => {
              item.initial = v;
            }),
            { placeholder: 'used when no data is supplied' },
          ),
        ),
        el('p', { class: 'text-[11px] text-ink-400' }, [
          'Saved as ^FN. Fill it in from the Stored Formats tab, or from a host that recalls this format.',
        ]),
      ]),
    );
  }

  if (item.type === 'date') specific.push(dateSection(item, unit, commit));

  if (item.type === 'barcode') {
    const spec = SYMBOLOGIES[item.symbology] || SYMBOLOGIES.code128;
    const has = (size) => spec.sizes.includes(size);
    const fields = [
      row(
        'Symbology',
        selectField(
          item.symbology,
          Object.entries(SYMBOLOGIES).map(([key, s]) => [key, s.label]),
          commit((v) => {
            // Data made for one symbology rarely suits another: swap an
            // untouched example for the new one's.
            if (item.data === spec.example && SYMBOLOGIES[v]) item.data = SYMBOLOGIES[v].example;
            // QR carries its own prefix in the data, which ^SN cannot.
            if (v === 'qr') item.serial = null;
            item.symbology = v;
          }),
        ),
      ),
      row(
        item.serial ? 'Starting value' : 'Data',
        textField(
          item.data,
          commit((v) => {
            item.data = v;
          }),
          { multiline: !item.serial },
        ),
      ),
    ];
    if (item.symbology !== 'qr') fields.push(...serialRows(item, commit));

    const sizes = [];
    if (has('height')) {
      sizes.push(
        row(
          ['pdf417', 'micropdf'].includes(item.symbology) ? 'Row height' : 'Bar height',
          dotsField(
            item.height,
            unit,
            commit((v) => {
              item.height = Math.max(1, v);
            }),
          ),
        ),
      );
    }
    if (has('module')) {
      const max = spec.kind === '2d' ? 20 : 10;
      sizes.push(
        row(
          'Module width',
          dotsField(
            item.moduleWidth,
            unit,
            commit((v) => {
              item.moduleWidth = Math.min(max, Math.max(1, Math.round(v)));
            }),
            { fine: true, maxDots: max },
          ),
        ),
      );
    }
    if (has('mag')) {
      const max = item.symbology === 'databar' ? 10 : 20;
      sizes.push(
        row(
          'Magnification',
          numberField(
            item.magnification,
            commit((v) => {
              item.magnification = Math.min(max, Math.max(1, Math.round(v)));
            }),
            { min: 1, max },
          ),
        ),
      );
    }
    if (item.symbology === 'qr') {
      sizes.push(
        row(
          'Error correction',
          selectField(
            item.errorLevel,
            [
              ['H', 'H — 30%'],
              ['Q', 'Q — 25%'],
              ['M', 'M — 15%'],
              ['L', 'L — 7%'],
            ],
            commit((v) => {
              item.errorLevel = v;
            }),
          ),
        ),
      );
    }
    if (item.symbology === 'databar') {
      sizes.push(
        row(
          'Type',
          selectField(
            item.databarType || 1,
            DATABAR_TYPES,
            commit((v) => {
              item.databarType = Number(v);
            }),
          ),
        ),
      );
    }
    if (item.symbology === 'maxicode') {
      sizes.push(
        row(
          'Mode',
          selectField(
            item.maxiMode || 4,
            [
              [2, '2 — US carrier'],
              [3, '3 — international carrier'],
              [4, '4 — standard'],
              [5, '5 — full ECC'],
              [6, '6 — reader programming'],
            ],
            commit((v) => {
              item.maxiMode = Number(v);
            }),
          ),
        ),
      );
    }
    if (has('ratio')) {
      sizes.push(
        row(
          'Wide:narrow',
          numberField(
            item.ratio,
            commit((v) => {
              item.ratio = v;
            }),
            { min: 2, max: 3, step: 0.1 },
          ),
        ),
      );
    }
    if (has('text')) {
      sizes.push(
        checkField(
          'Print interpretation line',
          item.showText,
          commit((v) => {
            item.showText = v;
          }),
        ),
      );
    }
    for (let i = 0; i < sizes.length; i += 2) fields.push(grid(sizes.slice(i, i + 2)));

    const notes = {
      gs1_128:
        'Put each application identifier in brackets, e.g. (01)… — the printer adds FNC1 and ' +
        'the check digit.',
      maxicode:
        'A fixed size, and it cannot be rotated. Modes 2 and 3 need a structured carrier ' +
        'message; mode 4 takes any data.',
      databar: 'Omnidirectional takes a 13-digit GTIN; Expanded takes (AI) data.',
      imb: '20, 25, 29 or 31 digits: tracking code, then the routing ZIP.',
    };
    if (notes[item.symbology]) {
      fields.push(el('p', { class: 'text-[11px] text-ink-400' }, [notes[item.symbology]]));
    }
    specific.push(section('Barcode', fields));
  }

  if (item.type === 'image') {
    const options = [['', '— choose a stored image —']];
    for (const file of images) options.push([file.name, file.name]);
    if (item.source && !images.some((f) => f.name === item.source)) {
      options.push([item.source, `${item.source} (not on this printer)`]);
    }
    const isGrf = /\.GRF$/i.test(item.source || '');
    const fields = [
      row(
        'Stored object',
        selectField(
          item.source,
          options,
          commit((v) => {
            item.source = v;
            delete item.naturalWidth;
            delete item.naturalHeight;
          }),
        ),
      ),
      el(
        'button',
        {
          class: 'btn-secondary btn-sm w-full',
          onclick: () => onUploadImage(item),
        },
        ['Upload an image…'],
      ),
    ];

    if (isGrf) {
      // ^XG scales a stored graphic, but only by whole multiples.
      fields.push(
        grid([
          row(
            'Scale X',
            numberField(
              item.scaleX || 1,
              commit((v) => {
                item.scaleX = Math.min(10, Math.max(1, Math.round(v)));
              }),
              { min: 1, max: 10, suffix: '×' },
            ),
          ),
          row(
            'Scale Y',
            numberField(
              item.scaleY || item.scaleX || 1,
              commit((v) => {
                item.scaleY = Math.min(10, Math.max(1, Math.round(v)));
              }),
              { min: 1, max: 10, suffix: '×' },
            ),
          ),
        ]),
      );
    }

    fields.push(
      el('p', { class: 'text-[11px] text-ink-400' }, [
        isGrf
          ? 'Stored as a .GRF and placed with ^XG, which scales by whole multiples.'
          : 'Placed with ^IM at its own size. Uploading gives you a .GRF, which can be scaled.',
      ]),
    );

    specific.push(section('Image', fields));
  }

  if (item.type === 'box') {
    specific.push(
      section('Box', [
        grid([
          row(
            'Width',
            dotsField(
              item.w,
              unit,
              commit((v) => {
                item.w = Math.max(1, v);
              }),
            ),
          ),
          row(
            'Height',
            dotsField(
              item.h,
              unit,
              commit((v) => {
                item.h = Math.max(1, v);
              }),
            ),
          ),
        ]),
        grid([
          row(
            'Line thickness',
            dotsField(
              item.thickness,
              unit,
              commit((v) => {
                item.thickness = Math.min(200, Math.max(1, Math.round(v)));
              }),
              { fine: true, maxDots: 200 },
            ),
          ),
          row(
            'Corner rounding',
            numberField(
              item.rounding,
              commit((v) => {
                item.rounding = Math.min(8, Math.max(0, Math.round(v)));
              }),
              { min: 0, max: 8 },
            ),
          ),
        ]),
        checkField(
          'White (knock out)',
          item.invert,
          commit((v) => {
            item.invert = v;
          }),
        ),
      ]),
    );
  }

  if (item.type === 'ellipse') {
    specific.push(
      section('Ellipse', [
        grid([
          row(
            'Width',
            dotsField(
              item.w,
              unit,
              commit((v) => {
                item.w = Math.max(3, v);
              }),
            ),
          ),
          row(
            'Height',
            dotsField(
              item.h,
              unit,
              commit((v) => {
                item.h = Math.max(3, v);
              }),
            ),
          ),
        ]),
        grid([
          row(
            'Line thickness',
            dotsField(
              item.thickness,
              unit,
              commit((v) => {
                item.thickness = Math.min(4095, Math.max(1, Math.round(v)));
              }),
              { fine: true },
            ),
          ),
          checkField(
            'White (knock out)',
            item.invert,
            commit((v) => {
              item.invert = v;
            }),
          ),
        ]),
        el('p', { class: 'text-[11px] text-ink-400' }, [
          'Saved as ^GE, or ^GC when the width and height are equal. A thickness of half ' +
            'the smaller side fills it.',
        ]),
      ]),
    );
  }

  if (item.type === 'line' && item.diagonal) {
    specific.push(
      section('Line', [
        lineDirectionRow(item, commit),
        grid([
          row(
            'Width',
            dotsField(
              item.w,
              unit,
              commit((v) => {
                item.w = Math.max(1, v);
              }),
            ),
          ),
          row(
            'Height',
            dotsField(
              item.h,
              unit,
              commit((v) => {
                item.h = Math.max(1, v);
              }),
            ),
          ),
        ]),
        row(
          'Thickness',
          dotsField(
            item.thickness,
            unit,
            commit((v) => {
              item.thickness = Math.min(200, Math.max(1, Math.round(v)));
            }),
            { fine: true, maxDots: 200 },
          ),
        ),
        el('p', { class: 'text-[11px] text-ink-400' }, [
          'Saved as ^GD, corner to corner of the box it spans.',
        ]),
      ]),
    );
  }

  if (item.type === 'line' && !item.diagonal) {
    specific.push(
      section('Line', [
        lineDirectionRow(item, commit),
        grid([
          row(
            'Length',
            dotsField(
              item.length,
              unit,
              commit((v) => {
                item.length = Math.max(1, v);
              }),
            ),
          ),
          row(
            'Thickness',
            dotsField(
              item.thickness,
              unit,
              commit((v) => {
                item.thickness = Math.min(200, Math.max(1, Math.round(v)));
              }),
              { fine: true, maxDots: 200 },
            ),
          ),
        ]),
      ]),
    );
  }

  const actions = el('div', { class: 'flex gap-2 px-3 py-3' }, [
    el('button', { class: 'btn-secondary btn-sm', onclick: onDuplicate }, ['Duplicate']),
    el('button', { class: 'btn-danger btn-sm', onclick: onDelete }, ['Delete']),
  ]);

  replaceChildren(host, [common, ...specific, actions]);
}
