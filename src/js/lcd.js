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
 * 20x6 character grid, padding and all, which is what this mode draws
 * -- unless lcd_display_helper.sh is running on a machine that can reach
 * port 9100. That copies the real bitmap into the printer's RAM each
 * second, as R:LCD.GRF, and /png hands it back; then this mode draws the
 * actual pixels instead.
 */

import { el, replaceChildren } from './ui.js';
import { readLcd, readPanelFrame, pressPanelButton } from './printer.js';

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

/*
 * The helper's frames. With none on the printer, look again now and
 * then rather than on every poll; a frame whose counter has stood still
 * this long means the helper has stopped without cleaning up.
 */
const HELPER_RECHECK_MS = 10000;
const FRAME_STALE_MS = 5000;

/** The panel's colours, lit and unlit, as in .lcd-screen. */
const LCD_COLOURS = {
  lit: { glass: [0xb3, 0xe2, 0x63], ink: [0x1a, 0x24, 0x11] },
  unlit: { glass: [0xc6, 0xcd, 0xba], ink: [0x46, 0x4f, 0x3c] },
};

const state = {
  intervalMs: 1000,
  running: true,
  lastOk: 0,
  lastError: null,
  inFlight: false,
  visible: false,
  /** 'image' while drawing the helper's frames, 'text' otherwise. */
  mode: 'text',
  /** What became of the last look for a frame: absent, stale or live. */
  helper: 'absent',
  helperCheckedAt: 0,
  frameSeq: null,
  frameChangedAt: 0,
};

let screenNode = null;
let ageNode = null;
let metaNode = null;
let helpNode = null;
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
      cells.push(
        el(
          'span',
          {
            class: 'opacity-50',
            title: `unmapped icon byte 0x${code.toString(16)}`,
          },
          ['▫'],
        ),
      );
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
  renderMeta();
}

/**
 * Read one of the helper's frames from the pixels of the PNG /png made
 * of it. The last row is not screen but a stamp the helper adds: "LCD",
 * a version byte, a 32-bit frame counter and the backlight. Returns null
 * for a picture without one.
 */
export function decodeFrame(rgba, width, height) {
  const dark = (x, y) => rgba[(y * width + x) * 4] < 128;
  const stampRow = height - 1;
  const byte = (k) => {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) | (dark(k * 8 + bit, stampRow) ? 1 : 0);
    return value;
  };
  if (height < 2 || byte(0) !== 0x4c || byte(1) !== 0x43 || byte(2) !== 0x44) return null;

  const pixels = new Uint8Array(width * stampRow);
  for (let y = 0; y < stampRow; y++) {
    for (let x = 0; x < width; x++) pixels[y * width + x] = dark(x, y) ? 1 : 0;
  }
  return {
    width,
    height: stampRow,
    pixels,
    seq: byte(4) * 0x1000000 + (byte(5) << 16) + (byte(6) << 8) + byte(7),
    backlight: byte(8) === 1,
  };
}

/** The PNG's pixels, by way of a canvas. */
async function frameFromBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return decodeFrame(data, bitmap.width, bitmap.height);
}

/** The real screen, pixel for pixel, in the panel's own green. */
function drawFrame(frame) {
  let canvas = screenNode.querySelector('canvas');
  if (!canvas || canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas = el('canvas', {
      width: String(frame.width),
      height: String(frame.height),
      class: 'block',
      style: `width:${frame.width * 2}px;max-width:100%;image-rendering:pixelated;`,
      role: 'img',
      'aria-label': 'The printer\u2019s front panel',
    });
    replaceChildren(screenNode, [canvas]);
  }

  const { glass, ink } = frame.backlight ? LCD_COLOURS.lit : LCD_COLOURS.unlit;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(frame.width, frame.height);
  for (let i = 0; i < frame.pixels.length; i++) {
    const [r, g, b] = frame.pixels[i] ? ink : glass;
    image.data.set([r, g, b, 255], i * 4);
  }
  ctx.putImageData(image, 0, 0);
  screenNode.classList.toggle('lcd-lit', frame.backlight);
  renderMeta();
}

/**
 * Draw the helper's latest frame, if it is running. False means there
 * is none to draw -- no helper, or one that has stopped -- and the
 * caller falls back to display.text.
 */
async function pollFrame() {
  const now = Date.now();
  if (state.helper !== 'live' && now - state.helperCheckedAt < HELPER_RECHECK_MS) return false;
  state.helperCheckedAt = now;

  const blob = await readPanelFrame();
  const frame = blob ? await frameFromBlob(blob) : null;
  if (!frame) {
    state.helper = 'absent';
    state.mode = 'text';
    return false;
  }

  if (frame.seq !== state.frameSeq) {
    state.frameSeq = frame.seq;
    state.frameChangedAt = now;
  }
  if (now - state.frameChangedAt > FRAME_STALE_MS + state.intervalMs) {
    state.helper = 'stale';
    state.mode = 'text';
    return false;
  }

  state.helper = 'live';
  state.mode = 'image';
  drawFrame(frame);
  return true;
}

/** The line under the panel saying what it shows, and the way to more. */
function renderMeta() {
  const text =
    state.mode === 'image'
      ? 'the printer\u2019s own screen, via lcd_display_helper.sh'
      : state.helper === 'stale'
        ? 'lcd_display_helper.sh has stopped updating \u2014 showing display.text'
        : 'generated via display.text \u2014 not an exact screenshot';
  if (metaNode.textContent !== text) metaNode.textContent = text;
  helpNode.hidden = state.mode === 'image';
}

/** How to get the real screen: the helper, with this printer's address in. */
function buildHelperHelp() {
  const command = `./lcd_display_helper.sh ${location.hostname}`;
  return el('details', { class: 'mt-3 w-0 min-w-full text-[12px] text-ink-600' }, [
    el('summary', { class: 'cursor-pointer text-ink-700' }, ['Show the real screen']),
    el('div', { class: 'mt-2 space-y-2' }, [
      el('p', {}, [
        'The printer\u2019s web server cannot pass on the screen\u2019s bitmap, but a ' +
          'computer that can reach its port 9100 can. From a copy of this project, run:',
      ]),
      el(
        'pre',
        { class: 'overflow-auto rounded bg-ink-50 px-2 py-1.5 font-mono text-[11px] text-ink-800' },
        [command],
      ),
      el('p', {}, [
        'It copies the screen into the printer\u2019s RAM every second, where this page ' +
          'picks it up \u2014 there is nothing to set here, and it switches over on its own. ' +
          'It also saves each frame as lcd.bmp. Ctrl-C stops it and takes the copy away. ' +
          'Needs bash, nc, od and awk.',
      ]),
    ]),
  ]);
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
  ageNode.className = overdue ? 'text-[11px] text-amber-600' : 'text-[11px] text-ink-400';
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
    if (!(await pollFrame())) render(await readLcd());
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
    // The helper takes a frame a second, so look again once it has.
    if (state.mode === 'image') {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await poll();
    }
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
    const node = el(
      'button',
      {
        class: 'btn-secondary h-9 w-full font-mono text-[13px] leading-none',
        title: spec.title,
        'aria-label': spec.title,
      },
      [spec.label],
    );
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
    class: 'field field-mono w-20',
    type: 'number',
    min: '0.5',
    max: '60',
    step: '0.5',
    value: '1',
  });
  intervalInput.addEventListener('change', () => {
    const seconds = Math.min(60, Math.max(0.5, Number(intervalInput.value) || 1));
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
  metaNode = el('span', { class: 'text-[11px] text-ink-400' });
  helpNode = buildHelperHelp();

  panel.append(
    el('div', { class: 'card w-fit max-w-full overflow-hidden' }, [
      el('div', { class: 'toolbar' }, [
        el('span', { class: 'text-[12px] font-medium text-ink-700' }, ['Front panel']),
        el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, [
          'Every',
          intervalInput,
          's',
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
        el(
          'div',
          {
            class:
              'mt-1.5 flex w-0 min-w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1',
          },
          [ageNode, metaNode],
        ),
        buildKeypad(),
        helpNode,
      ]),
    ]),
  );

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
