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
 * lcd.js -- Mode 4: watch the printer's front panel.
 *
 * The real framebuffer lives in the undocumented `display.image` SGD,
 * which returns a 240x110 1-bit BMP. It cannot be reached from a page the
 * printer serves: getvar.cgi truncates every value at its first NUL byte,
 * and a BMP has one at offset four, so the CGI hands back exactly
 * "BM\xfd\x0d" and stops. The raw port that does return it whole is not
 * something a browser can speak to. tools/lcd-shot.mjs grabs the bitmap
 * from a machine that can.
 *
 * What does come through intact is `display.text`: the same screen as a
 * 20x6 character grid, padding and all, which is what this mode draws.
 */

import { el, replaceChildren } from './ui.js';
import { readLcd, pressPanelButton } from './printer.js';

/** The front panel is twenty characters across and six rows down. */
const COLS = 20;
const ROWS = 6;

/**
 * Icon bytes the panel uses in place of characters. Only the home glyph
 * has been confirmed against a real screenshot; anything else high is
 * drawn as a placeholder rather than guessed at, with the byte in the
 * title so it can be identified and added here.
 */
const ICONS = { 0xc2: '⌂' };

const state = {
  intervalMs: 2000,
  running: true,
  lastOk: 0,
  lastError: null,
  inFlight: false,
  visible: false,
};

let screenNode = null;
let ageNode = null;
let metaNode = null;
let pauseBtn = null;
let pollTimer = null;
let tickTimer = null;

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

/** Split the flat grid string into rows, padding short reads. */
export function gridRows(text) {
  const padded = String(text ?? '').padEnd(COLS * ROWS, ' ');
  const rows = [];
  for (let r = 0; r < ROWS; r++) {
    rows.push(padded.slice(r * COLS, (r + 1) * COLS));
  }
  return rows;
}

function drawRow(row) {
  const cells = [];
  for (const ch of row) {
    const code = ch.codePointAt(0);
    if (code < 0x7f) {
      cells.push(ch === ' ' ? ' ' : ch);
    } else if (ICONS[code]) {
      cells.push(el('span', { title: `icon 0x${code.toString(16)}` }, [ICONS[code]]));
    } else {
      cells.push(el('span', {
        class: 'opacity-50',
        title: `unmapped icon byte 0x${code.toString(16)}`,
      }, ['▫']));
    }
  }
  return el('div', { class: 'whitespace-pre' }, cells);
}

function render(values) {
  const text = values ? values['display.text'] : null;
  const backlight = values ? values['display.backlight'] : null;

  replaceChildren(screenNode, gridRows(text).map(drawRow));
  // Lit glass while the backlight is on, dull grey-green when it is not.
  screenNode.classList.toggle('lcd-lit', backlight !== 'off');
}

/** Small grey line under the panel, so a stalled poll is obvious. */
function tick() {
  if (state.lastError) {
    ageNode.textContent = state.lastError;
    ageNode.className = 'text-[11px] text-red-600';
    return;
  }
  if (!state.lastOk) {
    ageNode.textContent = 'waiting for the first read…';
    ageNode.className = 'text-[11px] text-ink-400';
    return;
  }

  const age = (Date.now() - state.lastOk) / 1000;
  ageNode.textContent = state.running
    ? `updated ${age.toFixed(1)}s ago`
    : `paused — updated ${age.toFixed(1)}s ago`;

  // Overdue by more than one whole interval means something is wrong.
  const overdue = state.running && age > (state.intervalMs / 1000) * 2 + 1;
  ageNode.className = overdue
    ? 'text-[11px] text-amber-600'
    : 'text-[11px] text-ink-400';
}

/* ------------------------------------------------------------------ *
 * Polling
 * ------------------------------------------------------------------ */

async function poll() {
  // One request at a time: the printer's web server serves one anyway,
  // and piling up would starve whatever else the page is doing.
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const values = await readLcd();
    render(values);
    state.lastOk = Date.now();
    state.lastError = null;
  } catch (err) {
    state.lastError = `last read failed: ${err.message}`;
  } finally {
    state.inFlight = false;
    tick();
  }
}

function schedule() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!state.running || !state.visible) return;
  pollTimer = setInterval(poll, state.intervalMs);
}

/** Poll only while this tab is on screen and the browser tab is visible. */
function updateActivity() {
  const active = state.visible && !document.hidden;
  if (active && !pollTimer && state.running) {
    poll();
    schedule();
  } else if (!active) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

/*
 * The buttons
 * ------------------------------------------------------------------
 * diag.simulate_event presses the printer's own front-panel keys, so
 * the mirror becomes a remote control: the menus, the values, the lot.
 * Laid out as the panel is -- the arrows around Select, with the two
 * soft keys under the corners of the screen they belong to.
 *
 * Up and Down change the setting on screen, not just the highlight, so
 * this is a real front panel and not a viewer with decoration.
 */
const LCD_BUTTONS = [
  { key: 'ButtonP1', label: 'P1', title: 'Left soft key, under the screen' },
  { key: 'ButtonUp', label: '\u25b2', title: 'Up' },
  { key: 'ButtonP2', label: 'P2', title: 'Right soft key, under the screen' },
  { key: 'ButtonLeft', label: '\u25c0', title: 'Left' },
  { key: 'ButtonSelect', label: 'OK', title: 'Select' },
  { key: 'ButtonRight', label: '\u25b6', title: 'Right' },
  null,
  { key: 'ButtonDown', label: '\u25bc', title: 'Down' },
  null,
];

/**
 * Press a key, then look at the screen.
 *
 * The read is immediate rather than left to the next poll: a front
 * panel that answers a keypress two seconds later does not feel like
 * one. The panel needs a moment to repaint first.
 */
async function pressButton(button, node) {
  node.disabled = true;
  try {
    await pressPanelButton(button);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await poll();
  } catch (err) {
    state.lastError = `button press failed: ${err.message}`;
    tick();
  } finally {
    node.disabled = false;
  }
}

/** The keypad, in the shape of the printer's own. */
function buildKeypad() {
  const cells = LCD_BUTTONS.map((spec) => {
    if (!spec) return el('span');
    const node = el('button', {
      class: 'btn-secondary h-9 w-full font-mono text-[13px] leading-none',
      title: spec.title,
      'aria-label': spec.title,
    }, [spec.label]);
    node.addEventListener('click', () => pressButton(spec.key, node));
    return node;
  });

  return el('div', { class: 'mt-3 w-0 min-w-full' }, [
    el('div', { class: 'grid grid-cols-3 gap-1.5' }, cells),
    el('p', { class: 'mt-1.5 text-[11px] text-ink-400' }, [
      'These press the printer\u2019s own buttons. Up and Down change the value on screen.',
    ]),
  ]);
}

export function mountLcd(panel) {
  const intervalInput = el('input', {
    class: 'field field-mono w-20', type: 'number',
    min: '0.5', max: '60', step: '0.5', value: '2',
  });
  intervalInput.addEventListener('change', () => {
    const seconds = Math.min(60, Math.max(0.5, Number(intervalInput.value) || 2));
    intervalInput.value = String(seconds);
    state.intervalMs = seconds * 1000;
    schedule();
  });

  pauseBtn = el('button', { class: 'btn-secondary btn-sm' }, ['Pause']);
  pauseBtn.addEventListener('click', () => {
    state.running = !state.running;
    pauseBtn.textContent = state.running ? 'Pause' : 'Resume';
    if (state.running) poll();
    schedule();
    tick();
  });

  // w-fit, or the block would stretch to the card and leave the grid
  // sitting in a wide empty panel.
  screenNode = el('div', {
    class: 'lcd-screen lcd-lit',
    style: 'font-size:clamp(12px,2.4vw,19px);line-height:1.2;letter-spacing:0.08em;',
  });

  ageNode = el('p', { class: 'text-[11px] text-ink-400' });
  metaNode = el('span', { class: 'text-[11px] text-ink-400' }, [
    'generated via display.text \u2014 not an exact screenshot',
  ]);

  panel.append(el('div', { class: 'card w-fit max-w-full overflow-hidden' }, [
    el('div', { class: 'toolbar' }, [
      el('span', { class: 'text-[12px] font-medium text-ink-700' }, ['Front panel']),
      el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, [
        'Every', intervalInput, 's',
      ]),
      el('div', { class: 'ml-auto' }, [pauseBtn]),
    ]),
    el('div', { class: 'w-fit p-3' }, [
      // A bezel, so the grid reads as a device rather than a code block.
      el('div', { class: 'w-fit rounded-lg bg-ink-800 p-2 shadow-inner' }, [screenNode]),
      // w-0 min-w-full keeps the caption out of the intrinsic width of
      // the column -- otherwise this line, which is wider than the
      // screen, would set the width and stretch the bezel to match --
      // and then lets it fill and wrap inside whatever the screen needs.
      el('div', {
        class: 'mt-1.5 flex w-0 min-w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1',
      }, [ageNode, metaNode]),
      buildKeypad(),
    ]),
  ]));

  render(null);
  tick();

  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 200);
  document.addEventListener('visibilitychange', updateActivity);

  state.visible = true;
  updateActivity();
}

/** The tab came into view: resume polling. */
export function onLcdShown() {
  state.visible = true;
  updateActivity();
}

/** The tab went away: stop asking the printer for screens nobody is watching. */
export function onLcdHidden() {
  state.visible = false;
  updateActivity();
}
