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

import { el, qs, qsa, toast } from './ui.js';
import { printer, initState } from './state.js';
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
  paused: 'bg-amber-500/15 text-amber-300',
  unknown: 'bg-ink-800 text-ink-400',
};

function renderHeader() {
  qs('#hdr-name').textContent = printer.name;
  qs('#hdr-model').textContent = printer.model;
  qs('#hdr-ip').textContent = printer.ip;

  const status = qs('#hdr-status');
  status.textContent = printer.status;
  status.className = `pill ${STATUS_STYLES[printer.status] || STATUS_STYLES.unknown}`;

  const meta = [
    printer.serial && `S/N ${printer.serial}`,
    printer.firmware,
    `${printer.dpi} dpi`,
  ].filter(Boolean).join('  ·  ');
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
      panel.replaceChildren(el('div', { class: 'card p-4 text-red-700' }, [
        el('p', { class: 'font-semibold' }, ['This mode failed to start.']),
        el('pre', { class: 'mt-2 overflow-auto whitespace-pre-wrap text-[11px]' }, [
          `${err.name}: ${err.message}\n${err.stack || ''}`,
        ]),
      ]));
    }
  } else if (mode.onShow) {
    mode.onShow(panel);
  }

  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
}

function start() {
  initState(document);

  if (!printer.schema) {
    toast('The settings catalogue did not load; the Settings tab will be empty.', 'error', { timeout: 0 });
  }

  renderHeader();

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
