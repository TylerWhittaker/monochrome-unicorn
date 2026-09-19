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
import { readLcd } from './printer.js';

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
  intervalMs: 2500,
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
        class: 'text-white/50',
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
  // A dark panel with the backlight off is what you would actually see.
  screenNode.classList.toggle('opacity-40', backlight === 'off');

  if (values) {
    metaNode.textContent = [
      backlight ? `backlight ${backlight}` : null,
      values['display.contrast'] ? `contrast ${values['display.contrast']}` : null,
    ].filter(Boolean).join('  ·  ');
  }
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

export function mountLcd(panel) {
  const intervalInput = el('input', {
    class: 'field field-mono w-20', type: 'number',
    min: '0.5', max: '60', step: '0.5', value: '2.5',
  });
  intervalInput.addEventListener('change', () => {
    const seconds = Math.min(60, Math.max(0.5, Number(intervalInput.value) || 2.5));
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

  screenNode = el('div', {
    class: 'rounded bg-ink-950 px-3 py-2 font-mono text-white transition-opacity',
    style: 'font-size:clamp(11px,2.6vw,20px);line-height:1.5;letter-spacing:0.08em;',
  });

  ageNode = el('p', { class: 'text-[11px] text-ink-400' });
  metaNode = el('span', { class: 'text-[11px] text-ink-500' });

  panel.append(el('div', { class: 'grid gap-3 lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)]' }, [
    el('div', { class: 'card min-w-0 overflow-hidden' }, [
      el('div', { class: 'toolbar' }, [
        el('span', { class: 'text-[12px] font-medium text-ink-700' }, ['Front panel']),
        el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, [
          'Every', intervalInput, 's',
        ]),
        el('button', {
          class: 'btn-secondary btn-sm',
          onclick: () => poll(),
        }, ['Refresh now']),
        el('div', { class: 'ml-auto' }, [pauseBtn]),
      ]),
      el('div', { class: 'p-3' }, [
        // A bezel, so the grid reads as a device rather than a code block.
        el('div', { class: 'rounded-lg bg-ink-800 p-2 shadow-inner' }, [screenNode]),
        el('div', { class: 'mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3' }, [
          ageNode, metaNode,
        ]),
      ]),
    ]),

    el('div', { class: 'card min-w-0 self-start p-3 text-[12px] leading-relaxed text-ink-600' }, [
      el('h3', { class: 'mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-500' }, [
        'Why this is text, not a screenshot',
      ]),
      el('p', {}, [
        'The printer does hold a real picture of its screen, in the undocumented ',
        el('code', { class: 'font-mono text-[11px]' }, ['display.image']),
        ' setting — a 240×110 1-bit BMP. It cannot be fetched from a page the '
        + 'printer serves: getvar.cgi cuts every value at its first NUL byte, and a BMP '
        + 'has one four bytes in, so the four bytes "BMý\\r" are all that arrive.',
      ]),
      el('p', { class: 'mt-2' }, [
        'What you see above is ',
        el('code', { class: 'font-mono text-[11px]' }, ['display.text']),
        ', the same screen as a 20×6 character grid, which survives the trip intact. '
        + 'For the actual bitmap, run ',
        el('code', { class: 'font-mono text-[11px]' }, ['node tools/lcd-shot.mjs <ip>']),
        ' from a machine that can reach port 9100.',
      ]),
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
