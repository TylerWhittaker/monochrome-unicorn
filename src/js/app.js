/*
 * app.js -- entry point. Wires the header, the tab bar and the three modes.
 *
 * Each mode exposes mount(panel), called the first time its tab is opened
 * so a cold page only pays for what the user actually looks at.
 */

import { qs, qsa, toast } from './ui.js';
import { printer, initState } from './state.js';
import { mountSettings } from './settings.js';
import { mountEditor, onEditorShown } from './editor.js';
import { mountFormat, onFormatShown } from './format.js';

const MODES = {
  settings: { mount: mountSettings },
  editor: { mount: mountEditor, onShow: onEditorShown },
  format: { mount: mountFormat, onShow: onFormatShown },
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

  const panel = qs(`[data-panel="${id}"]`);
  const mode = MODES[id];
  if (!mounted.has(id)) {
    mounted.add(id);
    try {
      mode.mount(panel);
    } catch (err) {
      console.error(`Failed to mount ${id}`, err);
      panel.innerHTML = '<p class="text-red-700">This mode failed to start. See the browser console.</p>';
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
