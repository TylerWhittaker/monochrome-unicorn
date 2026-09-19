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
import { SYMBOLOGIES } from './zpl.js';

/** Rough advance width of the scalable font, as a fraction of cap height. */
const FONT_ASPECT = 0.58;

/** Estimate an element's footprint in dots, for hit-testing and handles. */
export function elementBounds(item) {
  if (item.type === 'box') return { w: item.w, h: item.h };
  if (item.type === 'line') {
    return item.vertical
      ? { w: item.thickness, h: item.length }
      : { w: item.length, h: item.thickness };
  }
  if (item.type === 'image') {
    return { w: item.naturalWidth || 200, h: item.naturalHeight || 200 };
  }
  if (item.type === 'text') {
    const charWidth = (item.width || item.height) * FONT_ASPECT;
    const lines = String(item.text).split('\n');
    const longest = lines.reduce((n, l) => Math.max(n, l.length), 1);
    const w = item.blockWidth > 0 ? item.blockWidth : Math.max(8, longest * charWidth);
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

function renderText(item, scale) {
  const node = el('div', {
    class: 'whitespace-pre leading-none text-black',
    style: `font-size:${item.height * scale}px;`
      + `font-family:${item.font === '0' ? 'Helvetica, Arial, sans-serif' : 'ui-monospace, monospace'};`
      + (item.width && item.width !== item.height ? `transform-origin:left top;transform:scaleX(${item.width / item.height});` : '')
      + (item.reverse ? 'background:#000;color:#fff;' : ''),
  }, [item.text]);
  return node;
}

function renderBarcode(item, scale) {
  const spec = SYMBOLOGIES[item.symbology] || SYMBOLOGIES.code128;
  const bounds = elementBounds(item);

  if (spec.kind === '2d') {
    return el('div', {
      class: 'h-full w-full',
      style: 'background-image:'
        + 'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%),'
        + 'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%);'
        + `background-size:${Math.max(3, (item.magnification || 4) * scale * 2)}px ${Math.max(3, (item.magnification || 4) * scale * 2)}px;`
        + `background-position:0 0,${Math.max(1.5, (item.magnification || 4) * scale)}px ${Math.max(1.5, (item.magnification || 4) * scale)}px;`,
    });
  }

  const barsHeight = item.height * scale;
  const bars = el('div', {
    style: `height:${barsHeight}px;`
      + 'background-image:repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 3px,#000 3px,#000 6px,transparent 6px,transparent 8px);',
  });
  const children = [bars];
  if (item.showText) {
    children.push(el('div', {
      class: 'text-center font-mono leading-none text-black',
      style: `font-size:${Math.max(6, item.height * 0.25 * scale)}px;`,
    }, [item.data]));
  }
  return el('div', { class: 'h-full w-full', style: `width:${bounds.w * scale}px;` }, children);
}

function renderImage(item, scale, onMeasured) {
  const match = /^([A-Z]):(.+)\.([A-Z]+)$/i.exec(item.source || '');
  if (!match) {
    return el('div', {
      class: 'flex h-full w-full items-center justify-center border border-dashed border-ink-400 text-[10px] text-ink-500',
    }, ['no image selected']);
  }
  const [, dev, oname, otype] = match;
  const img = el('img', {
    src: `/png?dev=${dev}&oname=${encodeURIComponent(oname)}&otype=${otype}`,
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
  return img;
}

function renderBox(item, scale) {
  return el('div', {
    class: 'h-full w-full',
    style: item.invert
      ? `border:${Math.max(1, item.thickness * scale)}px solid #fff;background:#fff;`
      : `border:${Math.max(1, item.thickness * scale)}px solid #000;`
        + (item.rounding ? `border-radius:${item.rounding * 2 * scale}px;` : ''),
  });
}

function renderLine(item) {
  return el('div', { class: 'h-full w-full bg-black' });
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
export function createCanvas(container, { getDoc, onChange, onSelect }) {
  let selectedId = null;
  let scale = 1;
  let zoom = 'fit';

  const surface = el('div', {
    class: 'preview-surface relative shrink-0 border border-ink-300 shadow-sm',
  });
  const scroller = el('div', {
    class: 'flex-1 overflow-auto bg-ink-100 p-4',
    onpointerdown: (event) => {
      if (event.target === scroller || event.target === surface) select(null);
    },
  }, [surface]);
  container.append(scroller);

  /**
   * "fit" shows the whole label at once, which is what you want while
   * placing things; an explicit zoom takes over when you need detail.
   */
  function computeScale() {
    if (zoom !== 'fit') { scale = zoom; return; }
    const doc = getDoc();
    const availableW = Math.max(160, scroller.clientWidth - 32);
    const availableH = Math.max(160, scroller.clientHeight - 32);
    scale = Math.min(1, availableW / Math.max(1, doc.width), availableH / Math.max(1, doc.height));
  }

  /** Set the zoom: a number for a fixed scale, or "fit". */
  function setZoom(next) {
    zoom = next === 'fit' ? 'fit' : Number(next);
    render();
  }

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    render();
    onSelect(id);
  }

  function setSelected(id) {
    selectedId = id;
    render();
  }

  /* -- dragging ---------------------------------------------------- */

  function beginDrag(event, item, mode) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { ...item };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
      const dx = Math.round((moveEvent.clientX - startX) / scale);
      const dy = Math.round((moveEvent.clientY - startY) / scale);
      if (mode === 'move') {
        item.x = Math.max(0, origin.x + dx);
        item.y = Math.max(0, origin.y + dy);
      } else {
        applyResize(item, origin, dx, dy);
      }
      render();
    };
    const end = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      onChange('drag');
    };

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  /** What the corner handle means differs per element type. */
  function applyResize(item, origin, dx, dy) {
    if (item.type === 'box') {
      item.w = Math.max(item.thickness, origin.w + dx);
      item.h = Math.max(item.thickness, origin.h + dy);
    } else if (item.type === 'line') {
      item.length = Math.max(4, origin.length + (item.vertical ? dy : dx));
    } else if (item.type === 'text') {
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

    for (const item of doc.elements) {
      const bounds = elementBounds(item);
      const selected = item.id === selectedId;

      let body;
      if (item.type === 'text') body = renderText(item, scale);
      else if (item.type === 'barcode') body = renderBarcode(item, scale);
      else if (item.type === 'image') body = renderImage(item, scale, () => render());
      else if (item.type === 'box') body = renderBox(item, scale);
      else body = renderLine(item);

      const node = el('div', {
        class: 'absolute touch-none'
          + (selected ? ' outline outline-2 outline-offset-1 outline-sky-500' : ' hover:outline hover:outline-1 hover:outline-sky-300'),
        style: `left:${item.x * scale}px;top:${item.y * scale}px;`
          + `width:${Math.max(2, bounds.w * scale)}px;height:${Math.max(2, bounds.h * scale)}px;`
          + `transform:rotate(${ROTATION_DEG[item.rotation] || 0}deg);transform-origin:left top;`
          + 'cursor:move;',
        dataset: { id: item.id },
        onpointerdown: (event) => { select(item.id); beginDrag(event, item, 'move'); },
      }, [body]);

      if (selected && item.type !== 'image') {
        node.append(el('div', {
          class: 'absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-se-resize rounded-sm border border-white bg-sky-500',
          style: 'touch-action:none;',
          onpointerdown: (event) => beginDrag(event, item, 'resize'),
        }));
      }

      surface.append(node);
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
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
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
      scroller.remove();
    },
  };
}
