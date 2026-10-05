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
 * app.js -- entry point. Wires the header, the tab bar and the modes.
 *
 * Each mode exposes mount(panel), called the first time its tab is opened
 * so a cold page only pays for what the user actually looks at.
 */

import { el, qs, qsa, toast, confirmDialog } from './ui.js';
import { printer, initState, parseHostStatus } from './state.js';
import { readStatus, sendControl } from './printer.js';
import { openClockDialog } from './clock.js';
import { mountSettings } from './settings.js';
import { mountEditor, onEditorShown } from './editor.js';
import { mountFormat, onFormatShown } from './format.js';
import { mountLcd, onLcdShown, onLcdHidden } from './lcd.js';
import { mountFiles, onFilesShown } from './files.js';

const MODES = {
  settings: { mount: mountSettings },
  editor: { mount: mountEditor, onShow: onEditorShown },
  format: { mount: mountFormat, onShow: onFormatShown },
  files: { mount: mountFiles, onShow: onFilesShown },
  lcd: { mount: mountLcd, onShow: onLcdShown, onHide: onLcdHidden },
};

const mounted = new Set();

const STATUS_STYLES = {
  ready: 'bg-emerald-500/15 text-emerald-300',
  'paper out': 'bg-amber-500/15 text-amber-300',
  'ribbon out': 'bg-amber-500/15 text-amber-300',
  paused: 'bg-amber-500/15 text-amber-300',
  'head open': 'bg-red-500/20 text-red-300',
  unknown: 'bg-ink-800 text-ink-400',
};

function renderStatus() {
  const status = qs('#hdr-status');
  status.textContent = printer.status;
  status.className = `pill ${STATUS_STYLES[printer.status] || STATUS_STYLES.unknown}`;
  if (pauseItem) pauseItem.textContent = printer.status === 'paused' ? 'Resume' : 'Pause';
}

/*
 * The status pill is read once with the page, then kept up to date: a
 * small helper file, every so often, while the page is in view -- so a
 * head left open or a roll run out shows here, not only on the printer.
 */
const STATUS_EVERY_MS = 15000;

async function refreshStatus() {
  try {
    const values = await readStatus();
    printer.status = parseHostStatus(values['device.host_status'], values);
  } catch (err) {
    printer.status = 'unknown';
  }
  renderStatus();
}

function startStatusPolling() {
  setInterval(() => {
    if (!document.hidden) refreshStatus();
  }, STATUS_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshStatus();
  });
}

/*
 * The things otherwise done at the printer itself. All are control
 * commands sent through the label form (sendControl); the ones that feed
 * media or throw jobs away ask first.
 */
let pauseItem = null;

const PRINTER_ACTIONS = [
  { label: 'Feed a label', command: '~PH', done: 'Fed a label.' },
  {
    label: 'Pause',
    command: () => (printer.status === 'paused' ? '~PS' : '~PP'),
    done: () => (printer.status === 'paused' ? 'Paused.' : 'Resumed.'),
    pause: true,
  },
  {
    label: 'Cancel all jobs',
    command: '~JA',
    done: 'Cancelled every job waiting to print.',
    confirm: [
      'Cancel all jobs?',
      'Every format waiting to print is thrown away; the label printing now finishes.',
      'Cancel all',
    ],
  },
  {
    label: 'Calibrate media',
    command: '~JC',
    done: 'Calibrating: the printer feeds labels to measure them.',
    confirm: [
      'Calibrate the media?',
      'The printer feeds one or more labels to measure the label length and set its sensors.',
      'Calibrate',
    ],
  },
  { label: 'Set clock…', run: () => openClockDialog() },
  {
    label: 'Print configuration label',
    command: '~WC',
    done: 'Printing the configuration label.',
    confirm: [
      'Print the configuration label?',
      'One label listing the printer’s settings is printed.',
      'Print',
    ],
  },
];

function buildPrinterMenu() {
  const menu = el('details', { class: 'relative', id: 'printer-menu' });
  const list = el('div', {
    class:
      'absolute left-0 z-30 mt-1 w-56 overflow-hidden rounded-md border border-ink-700 bg-ink-900 py-1 text-[12px] shadow-lg',
    role: 'menu',
  });
  for (const action of PRINTER_ACTIONS) {
    const item = el(
      'button',
      {
        class: 'block w-full px-3 py-1.5 text-left text-ink-200 hover:bg-ink-800 hover:text-white',
        role: 'menuitem',
        onclick: async () => {
          menu.open = false;
          if (action.run) {
            action.run();
            return;
          }
          if (action.confirm && !(await confirmDialog(...action.confirm))) return;
          const command = typeof action.command === 'function' ? action.command() : action.command;
          try {
            await sendControl(command);
            await new Promise((resolve) => setTimeout(resolve, 600));
            await refreshStatus();
            toast(typeof action.done === 'function' ? action.done() : action.done, 'success');
          } catch (err) {
            toast(`The printer did not take ${command}: ${err.message}`, 'error');
          }
        },
      },
      [action.label],
    );
    if (action.pause) pauseItem = item;
    list.append(item);
  }
  menu.append(
    el(
      'summary',
      {
        class:
          'cursor-pointer list-none rounded px-1.5 py-0.5 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-ink-200',
        title: 'Feed, pause, calibrate and other things done at the printer',
      },
      ['Printer ▾'],
    ),
    list,
  );
  // A click anywhere else closes it.
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  return menu;
}

function renderHeader() {
  qs('#hdr-name').textContent = printer.name;
  qs('#hdr-model').textContent = printer.model;
  qs('#hdr-ip').textContent = printer.ip;

  renderStatus();

  const meta = [printer.serial && `S/N ${printer.serial}`, printer.firmware, `${printer.dpi} dpi`]
    .filter(Boolean)
    .join('  ·  ');
  qs('#hdr-meta').textContent = meta;
  document.title = `${printer.name} — Printer Console`;
}

function showTab(id) {
  if (!MODES[id]) id = 'settings';

  for (const btn of qsa('.tab-btn')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === id));
  }
  for (const panel of qsa('[data-panel]')) {
    panel.hidden = panel.dataset.panel !== id;
  }

  // Let a mode that polls know it is off screen, so it can stand down.
  for (const [otherId, other] of Object.entries(MODES)) {
    if (otherId !== id && mounted.has(otherId) && other.onHide) other.onHide();
  }

  const panel = qs(`[data-panel="${id}"]`);
  const mode = MODES[id];
  if (!mounted.has(id)) {
    mounted.add(id);
    try {
      mode.mount(panel);
    } catch (err) {
      console.error(`Failed to mount ${id}`, err);
      panel.replaceChildren(
        el('div', { class: 'card p-4 text-red-700' }, [
          el('p', { class: 'font-semibold' }, ['This mode failed to start.']),
          el('pre', { class: 'mt-2 overflow-auto whitespace-pre-wrap text-[11px]' }, [
            `${err.name}: ${err.message}\n${err.stack || ''}`,
          ]),
        ]),
      );
    }
  } else if (mode.onShow) {
    mode.onShow(panel);
  }

  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
}

function start() {
  initState(document);

  // The build leaves out the tab of a mode this printer cannot support
  // (the LCD Viewer, on a printer with no display); drop the mode too,
  // so a bookmarked #lcd lands on Settings instead of an empty panel.
  for (const id of Object.keys(MODES)) {
    if (!qs(`.tab-btn[data-tab="${id}"]`)) delete MODES[id];
  }

  if (!printer.schema) {
    toast('The settings catalogue did not load; the Settings tab will be empty.', 'error', {
      timeout: 0,
    });
  }

  qs('#hdr-status').after(buildPrinterMenu());
  renderHeader();
  startStatusPolling();

  for (const btn of qsa('.tab-btn')) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  }
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  showTab(location.hash.slice(1) || 'settings');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
