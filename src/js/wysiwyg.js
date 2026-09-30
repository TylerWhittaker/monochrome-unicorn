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
 * wysiwyg.js -- the drag-and-drop label canvas.
 *
 * This is an editing proxy, not a renderer: it draws each element roughly
 * where and how the printer will, so positions can be dragged, while the
 * preview pane next to it shows what the printer actually produces. That
 * split is deliberate -- only the printer knows how its fonts and
 * symbologies rasterize, and it will tell us for free.
 */

import { el } from './ui.js';
import { loadStoredImage } from './printer.js';
import { SYMBOLOGIES, expandClock } from './zpl.js';
import { printer, fromDots } from './state.js';

/** Rough advance width of the bitmap fonts, as a fraction of their height. */
const FONT_ASPECT = 0.58;

/*
 * ZPL font 0 (CG Triumvirate Bold Condensed) is drawn in Inter Bold,
 * fetched from jsdelivr the first time a canvas is shown -- like Ace, it
 * is not worth its weight in a page served at 56 KB/s -- and Helvetica
 * or Arial until then, or for good on a network with no internet.
 *
 * Fitted to the printer's own render of ^A0N,100,100: capitals 75 dots
 * tall starting at the field origin, "The quick brown" 663 dots wide.
 * Inter's capitals are 0.73 em, so it is set at 1.027 times the field
 * height, squeezed to 0.79 of its width, and raised 0.122 em so the
 * capitals start where the printer's do.
 */
const INTER_URL =
  'https://cdn.jsdelivr.net/npm/@fontsource/inter@5/files/inter-latin-700-normal.woff2';
const FONT0_FAMILY = "'ZPL Font 0', Helvetica, Arial, sans-serif";
const FONT0 = { size: 1.027, squeeze: 0.79, rise: 0.122 };

/** Canvases to redraw once Inter arrives, since text changes width. */
const font0Waiters = new Set();
let font0Requested = false;

function loadFont0() {
  if (font0Requested || typeof FontFace === 'undefined') return;
  font0Requested = true;
  new FontFace('ZPL Font 0', `url(${INTER_URL})`, { weight: '700' })
    .load()
    .then((face) => {
      document.fonts.add(face);
      for (const redraw of font0Waiters) redraw();
    })
    .catch(() => {
      // Offline, or the CDN blocked: the fallback stays, which is fine.
    });
}

let measureContext = null;

/** How wide a line of font 0 prints, in dots, at a height and char width. */
function font0Width(text, height, width) {
  if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
  measureContext.font = `700 100px ${FONT0_FAMILY}`;
  const em = measureContext.measureText(text).width / 100;
  return em * height * FONT0.size * FONT0.squeeze * ((width || height) / height);
}

/** How wide a line of text prints, in dots. */
function textWidth(item, text) {
  if (item.font === '0' && typeof document !== 'undefined') {
    return font0Width(text, item.height, item.width);
  }
  return text.length * (item.width || item.height) * FONT_ASPECT;
}

/** Estimate an element's footprint in dots, for hit-testing and handles. */
export function elementBounds(item) {
  if (item.type === 'box') return { w: item.w, h: item.h };
  if (item.type === 'line') {
    return item.vertical
      ? { w: item.thickness, h: item.length }
      : { w: item.length, h: item.thickness };
  }
  if (item.type === 'image') {
    // ^XG magnifies a stored GRF; ^IM always places it 1:1.
    const grf = /\.GRF$/i.test(item.source || '');
    const sx = grf ? Math.max(1, Math.round(item.scaleX || 1)) : 1;
    const sy = grf ? Math.max(1, Math.round(item.scaleY || sx)) : 1;
    return { w: (item.naturalWidth || 200) * sx, h: (item.naturalHeight || 200) * sy };
  }
  if (item.type === 'field') {
    const charWidth = (item.width || item.height) * FONT_ASPECT;
    const caption = item.name || `FN${item.number}`;
    return { w: Math.max(60, (caption.length + 2) * charWidth), h: item.height };
  }
  if (item.type === 'date') {
    return elementBounds({ ...item, type: 'text', text: dateSample(item) });
  }
  if (item.type === 'text') {
    const lines = String(item.text).split('\n');
    const longest = lines.reduce((n, l) => Math.max(n, textWidth(item, l)), 0);
    const w = item.blockWidth > 0 ? item.blockWidth : Math.max(8, longest);
    return { w, h: item.height * lines.length };
  }
  if (item.type === 'barcode') {
    const spec = SYMBOLOGIES[item.symbology];
    if (spec && spec.kind === '2d') {
      const modules = item.symbology === 'qr' ? 29 : 24;
      const size = modules * (item.magnification || item.moduleWidth || 4);
      return { w: size, h: size };
    }
    // 1D: roughly 11 modules per character plus quiet zones.
    const chars = Math.max(1, String(item.data).length);
    return {
      w: (chars + 4) * 11 * (item.moduleWidth || 2),
      h: item.height + (item.showText ? Math.round(item.height * 0.25) + 10 : 0),
    };
  }
  return { w: 50, h: 50 };
}

const ROTATION_DEG = { N: 0, R: 90, I: 180, B: 270 };

/* ------------------------------------------------------------------ *
 * Element rendering
 * ------------------------------------------------------------------ */

/** How much narrower (or wider) a text element is drawn than laid out. */
function textSqueeze(item) {
  const stretch = (item.width || item.height) / item.height;
  return item.font === '0' ? FONT0.squeeze * stretch : stretch;
}

function renderText(item, scale) {
  const stretch = (item.width || item.height) / item.height;
  // ^FB wraps at its width, which the squeeze would otherwise shrink.
  const wrap =
    item.blockWidth > 0
      ? `width:${(item.blockWidth * scale) / textSqueeze(item)}px;white-space:pre-wrap;overflow-wrap:anywhere;`
      : 'width:max-content;';
  const style =
    item.font === '0'
      ? `font-family:${FONT0_FAMILY};font-weight:700;` +
        `font-size:${item.height * scale * FONT0.size}px;` +
        `line-height:${item.height * scale}px;margin-top:-${FONT0.rise}em;` +
        `transform-origin:left top;transform:scaleX(${FONT0.squeeze * stretch});`
      : `font-family:ui-monospace, monospace;font-size:${item.height * scale}px;` +
        'line-height:1;' +
        (stretch !== 1 ? `transform-origin:left top;transform:scaleX(${stretch});` : '');
  return el(
    'div',
    {
      class: 'whitespace-pre text-black',
      style: style + wrap + (item.reverse ? 'background:#000;color:#fff;' : ''),
    },
    [item.text],
  );
}

/** A clock field as it would print right now, by this computer's clock. */
function dateSample(item) {
  return expandClock(item.format, item.clock);
}

/**
 * A clock field drawn as today's date, outlined so it reads as live
 * rather than typed. The printer fills it from its own clock, which the
 * preview shows.
 */
function renderDate(item, scale) {
  const node = renderText({ ...item, text: dateSample(item) }, scale);
  node.classList.add('outline', 'outline-1', 'outline-dotted', 'outline-amber-500');
  return node;
}

/** A ^FN placeholder has no content yet, so show what will land there. */
function renderField(item, scale) {
  return el(
    'div',
    {
      class:
        'flex h-full w-full items-center overflow-hidden border border-dashed border-violet-500 bg-violet-50/70 px-1',
      style: `font-size:${Math.max(7, item.height * scale * 0.7)}px;`,
    },
    [
      el('span', { class: 'truncate font-mono text-violet-700' }, [
        item.name || `FN${item.number}`,
      ]),
    ],
  );
}

function renderBarcode(item, scale) {
  const spec = SYMBOLOGIES[item.symbology] || SYMBOLOGIES.code128;
  const bounds = elementBounds(item);

  if (spec.kind === '2d') {
    return el('div', {
      class: 'h-full w-full',
      style:
        'background-image:' +
        'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%),' +
        'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%);' +
        `background-size:${Math.max(3, (item.magnification || 4) * scale * 2)}px ${Math.max(3, (item.magnification || 4) * scale * 2)}px;` +
        `background-position:0 0,${Math.max(1.5, (item.magnification || 4) * scale)}px ${Math.max(1.5, (item.magnification || 4) * scale)}px;`,
    });
  }

  const barsHeight = item.height * scale;
  const bars = el('div', {
    style:
      `height:${barsHeight}px;` +
      'background-image:repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 3px,#000 3px,#000 6px,transparent 6px,transparent 8px);',
  });
  const children = [bars];
  if (item.showText) {
    children.push(
      el(
        'div',
        {
          class: 'text-center font-mono leading-none text-black',
          style: `font-size:${Math.max(6, item.height * 0.25 * scale)}px;`,
        },
        [item.data],
      ),
    );
  }
  return el('div', { class: 'h-full w-full', style: `width:${bounds.w * scale}px;` }, children);
}

/**
 * Draw a stored graphic. The bytes come through loadStoredImage rather
 * than a plain src, because /png returns stored PNGs with their first
 * four bytes missing and no browser will render that.
 */
function renderImage(item, scale, onMeasured) {
  const match = /^([A-Z]):(.+)\.([A-Z]+)$/i.exec(item.source || '');
  if (!match) {
    return el(
      'div',
      {
        class:
          'flex h-full w-full items-center justify-center border border-dashed border-ink-400 text-[10px] text-ink-500',
      },
      ['no image selected'],
    );
  }
  const [, dev, oname, otype] = match;

  const img = el('img', {
    alt: item.source,
    class: 'block h-full w-full',
    style: 'image-rendering:pixelated;',
    draggable: 'false',
  });
  img.addEventListener('load', () => {
    if (item.naturalWidth !== img.naturalWidth || item.naturalHeight !== img.naturalHeight) {
      item.naturalWidth = img.naturalWidth;
      item.naturalHeight = img.naturalHeight;
      onMeasured();
    }
  });

  const holder = el('div', { class: 'h-full w-full' }, [img]);
  loadStoredImage({ dev, oname, otype })
    .then((url) => {
      img.src = url;
    })
    .catch(() => {
      holder.replaceChildren(
        el(
          'div',
          {
            class:
              'flex h-full w-full items-center justify-center border border-dashed border-red-400 text-[10px] text-red-600',
            title: `Could not read ${item.source} from the printer`,
          },
          [item.source],
        ),
      );
    });
  return holder;
}

function renderBox(item, scale) {
  return el('div', {
    class: 'h-full w-full',
    style: item.invert
      ? `border:${Math.max(1, item.thickness * scale)}px solid #fff;background:#fff;`
      : `border:${Math.max(1, item.thickness * scale)}px solid #000;` +
        (item.rounding ? `border-radius:${item.rounding * 2 * scale}px;` : ''),
  });
}

function renderLine(item) {
  return el('div', { class: 'h-full w-full bg-black' });
}

/* ------------------------------------------------------------------ *
 * Rulers
 * ------------------------------------------------------------------ */

const RULER = 20;

/** A mark every this many dots, whatever unit the label is shown in. */
const RULER_STEP = 100;

/**
 * Where a ruler's marks go for a length in dots: one every 100 dots,
 * numbered at the smallest multiple of that at least `gap` pixels apart
 * so the numbers never run into each other when zoomed out.
 */
export function rulerTicks(lengthDots, scale, gap = 32) {
  const every = [1, 2, 5, 10, 20, 50].find((n) => n * RULER_STEP * scale >= gap) || 100;
  const ticks = [];
  for (let i = 0; i * RULER_STEP <= lengthDots; i++) {
    const labelled = i % every === 0;
    ticks.push({ at: i * RULER_STEP, major: labelled, label: labelled ? i * RULER_STEP : null });
  }
  return ticks;
}

/** One ruler, drawn crisp at the device's pixel ratio. */
function drawRuler(canvas, { lengthDots, scale, vertical }) {
  const length = Math.max(1, Math.round(lengthDots * scale));
  const ratio = window.devicePixelRatio || 1;
  const ticks = rulerTicks(lengthDots, scale);
  const ctx = canvas.getContext('2d');
  const font = '9px ui-sans-serif, system-ui, sans-serif';

  // The side ruler is as wide as its longest number needs.
  ctx.font = font;
  const widest = ticks.reduce(
    (n, tick) => (tick.label === null ? n : Math.max(n, ctx.measureText(String(tick.label)).width)),
    0,
  );
  const [w, h] = vertical ? [Math.ceil(12 + widest), length] : [length, RULER];
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#64748b';
  ctx.strokeStyle = '#94a3b8';
  ctx.font = font;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const tick of ticks) {
    const at = Math.round(tick.at * scale) + 0.5;
    const size = tick.major ? 8 : 4;
    if (vertical) {
      // Against the label's left edge, numbers outside the ticks.
      ctx.moveTo(w, at);
      ctx.lineTo(w - size, at);
      if (tick.label !== null && tick.at > 0) {
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillText(String(tick.label), w - 10, Math.min(h - 5, Math.max(5, at)));
      }
    } else {
      // Along the label's top edge, numbers above the ticks.
      ctx.moveTo(at, h);
      ctx.lineTo(at, h - size);
      if (tick.label !== null && tick.at > 0) {
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        ctx.fillText(String(tick.label), Math.min(w - 10, at), 1);
      }
    }
  }
  ctx.stroke();
}

/* ------------------------------------------------------------------ *
 * Canvas
 * ------------------------------------------------------------------ */

/**
 * Mount the editing canvas.
 *
 * `onChange(reason)` fires after any edit the user made by direct
 * manipulation; `onSelect(id)` after the selection changes.
 */
export function createCanvas(
  container,
  { getDoc, onChange, onSelect, getGrid = () => 0, getRulers = () => false },
) {
  let selectedId = null;
  let scale = 1;
  let zoom = 'fit';
  /** Element id -> its node on the surface, so edits can skip a rebuild. */
  const nodes = new Map();
  /**
   * Element id -> the size its text actually took, in dots, where that
   * came out bigger than elementBounds() predicted. Text is laid out by
   * the browser, which rounds glyph advances differently by platform,
   * zoom and pixel density, and a glyph's ink can reach past its advance;
   * the outline is fitted to what was drawn, so it always encloses it.
   */
  const fitted = new Map();

  /** Grow a text element's box to the text as drawn, and remember it. */
  function fitText(node, item) {
    const body = node.firstElementChild;
    if (!body || !body.offsetWidth) return;
    const style = getComputedStyle(body);
    if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
    measureContext.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    // Ink as well as advance: a glyph can reach past its advance to the
    // right, and a descender below the line box.
    let right = 0;
    let inkDescent = 0;
    for (const line of String(body.textContent).split('\n')) {
      const m = measureContext.measureText(line);
      right = Math.max(right, m.width, m.actualBoundingBoxRight);
      inkDescent = Math.max(inkDescent, m.actualBoundingBoxDescent);
    }
    // Where the last line's baseline sits: the line box centres the
    // font's own ascent and descent in the line height.
    const font = measureContext.measureText('');
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize);
    const lines = Math.max(1, Math.round(body.offsetHeight / lineHeight));
    const baseline =
      (lines - 1) * lineHeight +
      (lineHeight - font.fontBoundingBoxAscent - font.fontBoundingBoxDescent) / 2 +
      font.fontBoundingBoxAscent;
    const inkBottom = baseline + inkDescent;
    const top = parseFloat(style.marginTop) || 0;

    const width = ((Math.max(body.offsetWidth, right) + 1) * textSqueeze(item)) / scale;
    const height = (Math.max(body.offsetHeight, inkBottom) + top + 1) / scale;
    const bounds = elementBounds(item);
    if (width <= bounds.w && height <= bounds.h) return;
    const size = { w: Math.max(width, bounds.w), h: Math.max(height, bounds.h) };
    fitted.set(item.id, size);
    node.style.width = `${size.w * scale}px`;
    node.style.height = `${size.h * scale}px`;
  }

  /** The box an element occupies on the canvas: predicted, or as drawn. */
  function boxOf(item) {
    const bounds = elementBounds(item);
    const drawn = fitted.get(item.id);
    return drawn ? { w: Math.max(bounds.w, drawn.w), h: Math.max(bounds.h, drawn.h) } : bounds;
  }

  const surface = el('div', {
    class: 'preview-surface relative shrink-0 border border-ink-300 shadow-sm',
  });
  // Rulers along the top and down the left, in dots, when asked for.
  const topRuler = el('canvas', { class: 'block' });
  const sideRuler = el('canvas', { class: 'block' });
  const corner = el('span');
  const frame = el('div', { class: 'grid w-fit', style: 'grid-template-columns:auto auto;' }, [
    corner,
    topRuler,
    sideRuler,
    surface,
  ]);
  // The grey field hugs the label: the same 16px of it shows on all four
  // sides, and it only starts scrolling once a label (or a zoom) is
  // taller than the budget computeScale() fits to.
  const scroller = el(
    'div',
    {
      class: 'min-h-0 min-w-0 max-h-[70vh] overflow-auto bg-ink-100 p-4 pt-1',
      onpointerdown: (event) => {
        if (event.target === scroller || event.target === surface || event.target === frame) {
          select(null);
        }
      },
    },
    [frame],
  );
  container.append(scroller);

  // Where a drag has got to, beside the pointer.
  const readout = el('div', {
    class:
      'pointer-events-none fixed z-50 rounded bg-ink-900/90 px-1.5 py-0.5 font-mono text-[11px] text-white shadow',
    hidden: true,
  });
  document.body.append(readout);

  /**
   * "fit" shows the whole label at once, which is what you want while
   * placing things; an explicit zoom takes over when you need detail.
   */
  function computeScale() {
    if (zoom !== 'fit') {
      scale = zoom;
      return;
    }
    const doc = getDoc();
    const ruler = getRulers() ? RULER : 0;
    const availableW = Math.max(160, scroller.clientWidth - 32 - ruler - 16);
    // Height comes from the viewport rather than from the scroller,
    // which now takes its height from the label: measuring the box we
    // are about to resize would feed its own last answer back in.
    const availableH = Math.max(160, Math.round(window.innerHeight * 0.7) - 20 - ruler);
    scale = Math.min(1, availableW / Math.max(1, doc.width), availableH / Math.max(1, doc.height));
  }

  /** Set the zoom: a number for a fixed scale, or "fit". */
  function setZoom(next) {
    zoom = next === 'fit' ? 'fit' : Number(next);
    render();
  }

  /**
   * Change the selection without rebuilding the surface. A rebuild here
   * would detach the very node a pointerdown is about to start dragging,
   * which silently kills the drag before it begins.
   */
  function paintSelection(previousId) {
    for (const id of [previousId, selectedId]) {
      if (!id) continue;
      const node = nodes.get(id);
      if (node)
        decorate(
          node,
          getDoc().elements.find((e) => e.id === id),
        );
    }
  }

  function select(id) {
    if (selectedId === id) return;
    const previous = selectedId;
    selectedId = id;
    paintSelection(previous);
    onSelect(id);
  }

  function setSelected(id) {
    const previous = selectedId;
    selectedId = id;
    if (nodes.has(id) || nodes.has(previous)) paintSelection(previous);
    else render();
  }

  /** Apply selection styling and the resize handle to one element node. */
  function decorate(node, item) {
    if (!item) return;
    const selected = item.id === selectedId;
    node.className =
      'absolute touch-none' +
      (selected
        ? ' outline outline-2 outline-offset-1 outline-sky-500'
        : ' hover:outline hover:outline-1 hover:outline-sky-300');

    const existing = node.querySelector('[data-handle]');
    if (selected && item.type !== 'image') {
      if (!existing) {
        node.append(
          el('div', {
            class:
              'absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-se-resize rounded-sm border border-white bg-sky-500',
            style: 'touch-action:none;',
            dataset: { handle: '1' },
            onpointerdown: (event) => beginDrag(event, item, 'resize'),
          }),
        );
      }
    } else if (existing) {
      existing.remove();
    }
  }

  /** Move/resize the live node without rebuilding the whole surface. */
  function reposition(item) {
    const node = nodes.get(item.id);
    if (!node) return;
    const bounds = boxOf(item);
    node.style.left = `${item.x * scale}px`;
    node.style.top = `${item.y * scale}px`;
    node.style.width = `${Math.max(2, bounds.w * scale)}px`;
    node.style.height = `${Math.max(2, bounds.h * scale)}px`;
  }

  /* -- dragging ---------------------------------------------------- */

  function beginDrag(event, item, mode) {
    event.preventDefault();
    event.stopPropagation();
    // A resize changes what the text looks like; it is refitted after.
    if (mode === 'resize') fitted.delete(item.id);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { ...item };
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch (err) {
      /* mouse without capture support */
    }

    const move = (moveEvent) => {
      const dx = Math.round((moveEvent.clientX - startX) / scale);
      const dy = Math.round((moveEvent.clientY - startY) / scale);
      if (mode === 'move') {
        item.x = Math.max(0, origin.x + dx);
        item.y = Math.max(0, origin.y + dy);
      } else {
        applyResize(item, origin, dx, dy);
      }
      reposition(item);
      showReadout(moveEvent, item, mode);
    };
    const end = () => {
      readout.hidden = true;
      try {
        target.releasePointerCapture(event.pointerId);
      } catch (err) {
        /* already released */
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      // A resize can change how the element is drawn, not just its box.
      render();
      onChange('drag');
    };

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  /** Where the element is (or how big, while resizing), by the pointer. */
  function showReadout(event, item, mode) {
    const unit = getDoc().unit;
    const show = (dots) => String(fromDots(dots, unit));
    const suffix = unit === 'dots' ? '' : ` ${unit}`;
    let text;
    if (mode === 'move') {
      text = `x ${show(item.x)}  y ${show(item.y)}${suffix}`;
    } else {
      const bounds = boxOf(item);
      text = `${show(bounds.w)} \u00d7 ${show(bounds.h)}${suffix}`;
    }
    readout.textContent = text;
    readout.style.left = `${event.clientX + 14}px`;
    readout.style.top = `${event.clientY + 14}px`;
    readout.hidden = false;
  }

  /** What the corner handle means differs per element type. */
  function applyResize(item, origin, dx, dy) {
    if (item.type === 'box') {
      item.w = Math.max(item.thickness, origin.w + dx);
      item.h = Math.max(item.thickness, origin.h + dy);
    } else if (item.type === 'line') {
      item.length = Math.max(4, origin.length + (item.vertical ? dy : dx));
    } else if (item.type === 'text' || item.type === 'field' || item.type === 'date') {
      item.height = Math.max(6, origin.height + dy);
      if (origin.width) item.width = Math.max(4, origin.width + dx);
    } else if (item.type === 'barcode') {
      const spec = SYMBOLOGIES[item.symbology];
      if (spec && spec.kind === '2d') {
        item.magnification = Math.min(20, Math.max(1, origin.magnification + Math.round(dx / 20)));
      } else {
        item.height = Math.max(10, origin.height + dy);
        item.moduleWidth = Math.min(10, Math.max(1, origin.moduleWidth + Math.round(dx / 40)));
      }
    }
  }

  /* -- rendering --------------------------------------------------- */

  function render() {
    const doc = getDoc();
    computeScale();

    surface.style.width = `${doc.width * scale}px`;
    surface.style.height = `${doc.height * scale}px`;
    surface.replaceChildren();
    nodes.clear();
    fitted.clear();

    for (const item of doc.elements) {
      const bounds = elementBounds(item);

      let body;
      if (item.type === 'field') body = renderField(item, scale);
      else if (item.type === 'text') body = renderText(item, scale);
      else if (item.type === 'date') body = renderDate(item, scale);
      else if (item.type === 'barcode') body = renderBarcode(item, scale);
      else if (item.type === 'image') body = renderImage(item, scale, () => render());
      else if (item.type === 'box') body = renderBox(item, scale);
      else body = renderLine(item);

      const node = el(
        'div',
        {
          style:
            `left:${item.x * scale}px;top:${item.y * scale}px;` +
            `width:${Math.max(2, bounds.w * scale)}px;height:${Math.max(2, bounds.h * scale)}px;` +
            `transform:rotate(${ROTATION_DEG[item.rotation] || 0}deg);transform-origin:left top;` +
            'cursor:move;',
          dataset: { id: item.id },
          onpointerdown: (event) => {
            select(item.id);
            beginDrag(event, item, 'move');
          },
        },
        [body],
      );

      nodes.set(item.id, node);
      surface.append(node);
      if (item.type === 'text' || item.type === 'date') fitText(node, item);
      decorate(node, item);
    }

    // A grid over everything, which the pointer passes straight through.
    const gridDots = getGrid();
    if (gridDots > 0 && gridDots * scale >= 3) {
      const size = gridDots * scale;
      surface.append(
        el('div', {
          class: 'pointer-events-none absolute inset-0',
          style:
            'background-image:' +
            'linear-gradient(to right, rgba(14,165,233,.35) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgba(14,165,233,.35) 1px, transparent 1px);' +
            `background-size:${size}px ${size}px;`,
        }),
      );
    }

    const rulers = getRulers();
    // By style, not `hidden`: the canvases' `block` class would win over it.
    for (const node of [corner, topRuler, sideRuler]) node.style.display = rulers ? '' : 'none';
    // The top ruler stands in for most of the field above the label.
    scroller.classList.toggle('pt-1', rulers);
    if (rulers) {
      drawRuler(topRuler, { lengthDots: doc.width, scale, vertical: false });
      drawRuler(sideRuler, { lengthDots: doc.height, scale, vertical: true });
    }
  }

  /* -- keyboard ---------------------------------------------------- */

  const onKey = (event) => {
    if (!selectedId) return;
    // Ignore keys typed into the property inspector.
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const doc = getDoc();
    const item = doc.elements.find((e) => e.id === selectedId);
    if (!item) return;

    const step = event.shiftKey ? 10 : 1;
    const nudge = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (nudge) {
      event.preventDefault();
      item.x = Math.max(0, item.x + nudge[0]);
      item.y = Math.max(0, item.y + nudge[1]);
      render();
      onChange('nudge');
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      doc.elements = doc.elements.filter((e) => e.id !== selectedId);
      select(null);
      onChange('delete');
    }
  };
  document.addEventListener('keydown', onKey);

  const onResize = () => render();
  window.addEventListener('resize', onResize);

  // Font 0's stand-in changes every text width when it arrives.
  font0Waiters.add(render);
  loadFont0();

  render();

  return {
    render,
    setSelected,
    setZoom,
    getScale: () => scale,
    getSelected: () => selectedId,
    destroy() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      font0Waiters.delete(render);
      readout.remove();
      scroller.remove();
    },
  };
}
