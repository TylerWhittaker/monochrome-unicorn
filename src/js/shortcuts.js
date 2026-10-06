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
 * shortcuts.js -- every keyboard and pointer shortcut, in one list.
 *
 * Press ? anywhere outside a text box, or the Label Editor's Shortcuts
 * button, for the sheet. The list is the one place they are written
 * down: anything new that has a key goes here too.
 */

import { el, modal } from './ui.js';

/** [where, [[keys, what it does], ...]] -- keys joined by " / " are alternatives. */
export const SHORTCUTS = [
  [
    'Label Editor',
    [
      ['Ctrl+Z', 'Undo'],
      ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
      ['Ctrl+A', 'Select every element'],
      ['Shift-click / Ctrl-click', 'Add an element to the selection, or take it out'],
      ['Drag on empty space', 'Select every element the band touches (Shift adds)'],
      ['Ctrl+C', 'Copy the selection, as ZPL'],
      ['Ctrl+X', 'Cut the selection'],
      ['Ctrl+V', 'Paste a copy, or ZPL copied from anywhere'],
      ['Delete / Backspace', 'Delete the selection'],
      ['Arrow keys', 'Nudge the selection one dot'],
      ['Shift+arrow keys', 'Nudge it ten dots'],
      ['Alt while dragging', 'Leave the grid'],
    ],
  ],
  [
    'Printer Settings',
    [
      ['Enter', 'Write the value being edited'],
      ['Esc', 'Put the value back as it was'],
    ],
  ],
  ['Anywhere', [['?', 'This list']]],
];

const kbd = (text) =>
  el(
    'kbd',
    {
      class:
        'rounded border border-ink-300 bg-ink-50 px-1.5 py-0.5 font-mono text-[11px] text-ink-800',
    },
    [text],
  );

/** One key combination, its alternatives separated by "or". */
function keysCell(keys) {
  const parts = [];
  keys.split(' / ').forEach((alt, i) => {
    if (i) parts.push(el('span', { class: 'px-1 text-ink-400' }, ['or']));
    parts.push(kbd(alt));
  });
  return el('td', { class: 'whitespace-nowrap py-1 pr-3 align-top' }, parts);
}

let open = false;

/** Show the sheet. */
export async function openShortcuts() {
  if (open) return;
  open = true;
  try {
    await modal('Keyboard shortcuts', (close) =>
      el('div', { class: 'space-y-4', dataset: { shortcuts: '1' } }, [
        ...SHORTCUTS.map(([where, rows]) =>
          el('div', {}, [
            el(
              'h3',
              {
                class: 'mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-500',
              },
              [where],
            ),
            el(
              'table',
              { class: 'text-[12px]' },
              rows.map(([keys, what]) =>
                el('tr', {}, [keysCell(keys), el('td', { class: 'py-1 text-ink-700' }, [what])]),
              ),
            ),
          ]),
        ),
        el('div', { class: 'flex justify-end' }, [
          el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Close']),
        ]),
      ]),
    );
  } finally {
    open = false;
  }
}

/** ? opens the sheet, unless it is being typed into something. */
export function installShortcutKey() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = document.activeElement;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (target && (target.isContentEditable || target.closest('.ace_editor'))) return;
    event.preventDefault();
    openShortcuts();
  });
}
