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
 * layers.js -- the Label Editor's list of elements, top-most first.
 *
 * The printer draws a label's fields in the order the ZPL gives them, so
 * a later one lands on top of an earlier one, and the list is that order
 * upside down. Clicking a row selects the element -- the way to reach one
 * buried under others -- and the order can be changed by dragging a row
 * or with the buttons, which is the order the ZPL is written in.
 *
 * Hide and Lock are the editor's own: a hidden element is not drawn on
 * the canvas (it still prints), a locked one is not dragged, nudged or
 * caught by a band. Neither is written into the ZPL, so they last until
 * the label is opened again.
 *
 * The card starts collapsed to its header, and stays as it was left for
 * the rest of the visit.
 */

import { el, replaceChildren } from './ui.js';
import { SYMBOLOGIES } from './zpl.js';

const clip = (text, n = 28) => {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** A row's words for an element: what it is, and what it says. */
export function describeElement(item) {
  switch (item.type) {
    case 'text':
      return item.serial ? `Serial ${clip(item.text)}` : `Text “${clip(item.text)}”`;
    case 'barcode': {
      const spec = SYMBOLOGIES[item.symbology];
      return `${spec ? spec.label : item.symbology} ${clip(item.data, 20)}`;
    }
    case 'field':
      return `Field ${item.name ? `${item.name} ` : ''}(^FN${item.number})`;
    case 'date':
      return `Date ${clip(item.format, 20)}`;
    case 'image':
      return `Image ${item.source || '(none)'}`;
    case 'box':
      return `Box ${item.w} × ${item.h}`;
    case 'ellipse':
      return `${item.w === item.h ? 'Circle' : 'Ellipse'} ${item.w} × ${item.h}`;
    case 'line':
      return item.diagonal
        ? `Diagonal line ${item.w} × ${item.h}`
        : `${item.vertical ? 'Vertical' : 'Horizontal'} line ${item.length}`;
    default:
      return item.type;
  }
}

/**
 * The elements in a new order: the ids in `ids` brought to the front
 * (drawn last), sent to the back (first), or moved one place forward or
 * backward, keeping their order among themselves.
 */
export function reorder(elements, ids, how) {
  const chosen = new Set(ids);
  const picked = elements.filter((e) => chosen.has(e.id));
  const rest = elements.filter((e) => !chosen.has(e.id));
  if (!picked.length) return elements.slice();
  if (how === 'front') return [...rest, ...picked];
  if (how === 'back') return [...picked, ...rest];
  const out = elements.slice();
  if (how === 'forward') {
    for (let i = out.length - 2; i >= 0; i--) {
      if (chosen.has(out[i].id) && !chosen.has(out[i + 1].id)) {
        [out[i], out[i + 1]] = [out[i + 1], out[i]];
      }
    }
    return out;
  }
  if (how === 'backward') {
    for (let i = 1; i < out.length; i++) {
      if (chosen.has(out[i].id) && !chosen.has(out[i - 1].id)) {
        [out[i], out[i - 1]] = [out[i - 1], out[i]];
      }
    }
    return out;
  }
  throw new Error(`Unknown order: ${how}`);
}

/**
 * Move one element so it sits just above `target` in the list (drawn just
 * after it), or at the very bottom of the list (drawn first) when target
 * is null.
 */
export function moveAbove(elements, id, targetId) {
  const item = elements.find((e) => e.id === id);
  if (!item || id === targetId) return elements.slice();
  const rest = elements.filter((e) => e.id !== id);
  if (targetId === null) return [item, ...rest];
  const at = rest.findIndex((e) => e.id === targetId);
  if (at === -1) return elements.slice();
  return [...rest.slice(0, at + 1), item, ...rest.slice(at + 1)];
}

/** Whether the card is open; the panel is redrawn whole, so it lives here. */
let expanded = false;

/**
 * Draw the panel. `selection` is the selected ids; `onSelect(id, adding)`,
 * `onOrder(elements)` and `onFlag(id, flag, on)` report what was done.
 */
export function renderLayers(host, options) {
  const { doc, selection, onSelect, onOrder, onFlag } = options;
  const chosen = new Set(selection);
  const elements = doc.elements;
  const button = (label, title, how) =>
    el(
      'button',
      {
        class: 'btn-secondary btn-sm px-2',
        title,
        disabled: !chosen.size,
        onclick: () => onOrder(reorder(elements, [...chosen], how)),
      },
      [label],
    );
  const toggle = (item, flag, on, off, title) =>
    el(
      'button',
      {
        class:
          'rounded px-1.5 py-0.5 text-[11px] ' +
          (item[flag] ? 'bg-ink-800 text-white' : 'text-ink-500 hover:bg-ink-100'),
        'aria-pressed': String(Boolean(item[flag])),
        title,
        dataset: { flag },
        onclick: (event) => {
          event.stopPropagation();
          onFlag(item.id, flag, !item[flag]);
        },
      },
      [item[flag] ? on : off],
    );

  let dragged = null;
  const rows = [...elements].reverse().map((item) => {
    const selected = chosen.has(item.id);
    const row = el(
      'li',
      {
        class:
          'flex cursor-pointer items-center gap-2 px-3 py-1 text-[12px] ' +
          (selected ? 'bg-sky-50 text-ink-900' : 'text-ink-700 hover:bg-ink-50') +
          (item.hidden ? ' opacity-50' : ''),
        draggable: 'true',
        dataset: { layer: item.id },
        onclick: (event) => onSelect(item.id, event.shiftKey || event.ctrlKey || event.metaKey),
        ondragstart: (event) => {
          dragged = item.id;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', item.id);
        },
        ondragover: (event) => {
          if (dragged && dragged !== item.id) event.preventDefault();
        },
        ondrop: (event) => {
          event.preventDefault();
          if (!dragged || dragged === item.id) return;
          // Dropped on a row: it goes just above that one in the list.
          onOrder(moveAbove(elements, dragged, item.id));
          dragged = null;
        },
      },
      [
        el('span', { class: 'cursor-grab select-none text-ink-300', title: 'Drag to reorder' }, [
          '⋮⋮',
        ]),
        el('span', { class: 'min-w-0 flex-1 truncate' }, [describeElement(item)]),
        toggle(item, 'hidden', 'Hidden', 'Hide', 'Hide it on the canvas (it still prints)'),
        toggle(item, 'locked', 'Locked', 'Lock', 'Stop it being dragged or nudged'),
      ],
    );
    return row;
  });

  const header = el(
    'button',
    {
      class: 'mr-auto flex items-center gap-1.5 text-[12px] font-semibold text-ink-700',
      'aria-expanded': String(expanded),
      title: expanded ? 'Collapse the layers' : 'Show the layers',
      dataset: { layersToggle: '' },
      onclick: () => {
        expanded = !expanded;
        renderLayers(host, options);
      },
    },
    [
      el('span', { class: 'w-3 text-ink-400', 'aria-hidden': 'true' }, [expanded ? '▾' : '▸']),
      'Layers',
      el('span', { class: 'font-normal text-ink-400' }, [`(${elements.length})`]),
    ],
  );

  if (!expanded) {
    replaceChildren(host, [el('div', { class: 'flex items-center px-3 py-2' }, [header])]);
    return;
  }

  replaceChildren(host, [
    el('div', { class: 'flex flex-wrap items-center gap-1.5 border-b border-ink-200 px-3 py-2' }, [
      header,
      button('To front', 'Draw the selection on top of everything', 'front'),
      button('Forward', 'One place nearer the top', 'forward'),
      button('Backward', 'One place nearer the bottom', 'backward'),
      button('To back', 'Draw the selection under everything', 'back'),
    ]),
    elements.length
      ? el('ul', { class: 'max-h-64 divide-y divide-ink-100 overflow-auto' }, rows)
      : el('p', { class: 'px-3 py-3 text-[12px] text-ink-400' }, ['No elements yet.']),
    el('p', { class: 'px-3 py-1.5 text-[11px] text-ink-400' }, [
      'Top of the list is drawn last, on top. Hide and Lock are not saved with the label.',
    ]),
  ]);
}
