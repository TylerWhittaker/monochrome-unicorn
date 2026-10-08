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
 * preview.js -- the label preview pane.
 *
 * The printer renders ZPL to a bitmap for free through its own /zpl form,
 * so the preview is a real render rather than an approximation. htmx does
 * the round-trip and the swap: it posts the fields, pulls the <IMG> out of
 * the reply and puts it in the pane. The temp object the printer draws
 * into is named on the fly (__TMP001, __TMP004, ...), which is exactly why
 * the image element has to come from the response instead of being built
 * here from a guessed name.
 *
 * htmx.ajax is used rather than a real <form>: a form only becomes an htmx
 * form once htmx has processed it, and a submit that arrives first
 * navigates the whole page away to the printer's reply.
 */

import { el, toast } from './ui.js';
import { extractPrinterError, printerTurn } from './printer.js';

let seq = 0;

/**
 * The label's own size, in dots, from the last ^PW and ^LL in its ZPL,
 * or null for a part the ZPL does not give (a recalled format, say).
 */
export function labelSizeOf(zpl) {
  const last = (re) => {
    const all = [...String(zpl).matchAll(re)];
    return all.length ? parseInt(all[all.length - 1][1], 10) || null : null;
  };
  return { width: last(/\^PW(\d+)/g), height: last(/\^LL(\d+)/g) };
}

/**
 * Issue one htmx request and resolve with its response detail. It takes
 * its turn with the printer like any other request (printer.js).
 */
function htmxPost(path, values, options) {
  return printerTurn(() => htmxSend(path, values, options));
}

function htmxSend(path, values, options) {
  return new Promise((resolve, reject) => {
    const settle = (event) => {
      const info = event.detail.pathInfo;
      if (!info || info.requestPath !== path) return;
      document.body.removeEventListener('htmx:afterRequest', settle);
      resolve(event.detail);
    };
    document.body.addEventListener('htmx:afterRequest', settle);

    window.htmx.ajax('POST', path, { ...options, values }).catch((err) => {
      document.body.removeEventListener('htmx:afterRequest', settle);
      reject(err);
    });
  });
}

/**
 * Mount a preview pane.
 *
 * Returns {node, update(zpl), print(zpl)}. `update` is safe to call often;
 * callers debounce it, and a superseded render is simply overwritten.
 */
export function createPreview({ onPrinted, onPrint } = {}) {
  const id = `preview-${++seq}`;

  const imageHost = el(
    'div',
    {
      id: `${id}-host`,
      class:
        'preview-surface flex max-h-[60vh] min-h-[12rem] items-start justify-center overflow-auto p-3',
    },
    [el('p', { class: 'text-[12px] text-ink-400' }, ['The rendered label will appear here.'])],
  );

  const status = el('span', { class: 'text-[11px] text-ink-400' });

  const refreshBtn = el(
    'button',
    {
      class: 'btn-secondary btn-sm',
      type: 'button',
      onclick: () => run('preview'),
    },
    ['Refresh'],
  );

  // Printing is the thing you do after looking at the preview, so the
  // pane offers it where you are already looking. The caller supplies
  // the action rather than this pane calling print() itself: it is the
  // caller that knows what is being printed and asks before doing it.
  const printBtn =
    onPrint &&
    el(
      'button',
      {
        class: 'btn-primary btn-sm',
        type: 'button',
        onclick: () => onPrint(),
      },
      ['Print'],
    );

  const node = el('div', { class: 'card flex flex-col self-start overflow-hidden' }, [
    el('div', { class: 'toolbar' }, [
      el('span', { class: 'text-[12px] font-medium text-ink-700' }, ['Preview']),
      el('div', { class: 'ml-auto flex items-center gap-2' }, [status, refreshBtn, printBtn]),
    ]),
    imageHost,
  ]);

  let lastZpl = '';
  let inFlight = 0;

  /** Replace the image with a message. */
  function showMessage(text) {
    imageHost.classList.add('min-h-[12rem]');
    imageHost.replaceChildren(el('p', { class: 'py-6 text-[12px] text-ink-400' }, [text]));
  }

  /*
   * The printer draws a preview on the whole of the media it is set up
   * for -- 960 x 1800 dots on a printer configured for 4x6 -- whatever
   * ^PW and ^LL the label asks for, with the label in its top-left
   * corner. A 3x1 label would sit at the top of a tall white page, all
   * of it looking like margin. So the image is shown through a frame the
   * label's own shape, one image pixel to a dot, and the pane drops its
   * minimum height so the grey round it is the same on every side.
   */
  function frameToLabel(img, size) {
    imageHost.classList.remove('min-h-[12rem]');
    if (!size.width && !size.height) return;
    const fit = () => {
      const w = Math.min(size.width || img.naturalWidth, img.naturalWidth);
      const h = Math.min(size.height || img.naturalHeight, img.naturalHeight);
      if (!w || !h) return;
      const frame = el('div', {
        class: 'relative w-full shrink-0 overflow-hidden bg-white shadow-sm ring-1 ring-ink-300',
        style: `aspect-ratio:${w} / ${h};`,
      });
      img.className = 'absolute left-0 top-0 max-w-none';
      img.style.width = `${(img.naturalWidth / w) * 100}%`;
      img.replaceWith(frame);
      frame.append(img);
    };
    if (img.complete && img.naturalWidth) fit();
    else img.addEventListener('load', fit, { once: true });
  }

  async function run(mode) {
    if (!lastZpl.trim()) return;
    const token = ++inFlight;
    // htmx copies any <title> in a response into the document, and every
    // reply from the printer carries its own; keep ours.
    const pageTitle = document.title;
    status.textContent = mode === 'print' ? 'sending to printer…' : 'rendering…';

    // The printer tells the two actions apart by which submit button's
    // name arrives, so only one of prev/print is sent.
    const values = { data: lastZpl, dev: 'R', oname: 'UNKNOWN', otype: 'ZPL' };
    if (mode === 'print') values.print = 'Print Label';
    else values.prev = 'Preview Label';

    let detail;
    try {
      detail = await htmxPost(
        '/zpl',
        values,
        mode === 'print'
          ? { swap: 'none', source: node }
          : { target: imageHost, select: 'img', swap: 'innerHTML', source: node },
      );
    } catch (err) {
      if (token === inFlight) status.textContent = 'request failed';
      toast(`Preview request failed: ${err.message || err}`, 'error');
      return;
    }

    document.title = pageTitle;

    // A later render already answered; leave its result alone.
    if (token !== inFlight) return;

    const body = (detail.xhr && detail.xhr.responseText) || '';
    if (!detail.successful) {
      status.textContent = 'printer unreachable';
      toast('The printer did not answer the preview request.', 'error');
      return;
    }

    const printerError = extractPrinterError(body);
    if (printerError) {
      status.textContent = 'rejected';
      toast(printerError, 'error');
      return;
    }

    if (mode === 'print') {
      status.textContent = 'sent to printer';
      toast('Label sent to the printer.', 'success');
      if (onPrinted) onPrinted();
      return;
    }

    if (!/<IMG\s/i.test(body)) {
      status.textContent = 'nothing to render';
      showMessage('This label produces no printable output.');
      return;
    }

    // The printer sizes the image with HTML attributes; restyle it so it
    // fits the pane rather than the page it was written for.
    const img = imageHost.querySelector('img');
    if (img) {
      img.removeAttribute('width');
      img.removeAttribute('border');
      img.className = 'max-w-full bg-white shadow-sm ring-1 ring-ink-300';
      img.alt = 'Rendered label';
      frameToLabel(img, labelSizeOf(lastZpl));
      // The printer only writes the temp bitmap when the format draws
      // something, so an empty label leaves the promised URL 404.
      img.addEventListener(
        'error',
        () => {
          if (token !== inFlight) return;
          status.textContent = 'nothing to render';
          showMessage('This label produces no printable output.');
        },
        { once: true },
      );
    }
    status.textContent = 'up to date';
  }

  return {
    node,
    update(zpl) {
      lastZpl = zpl;
      run('preview');
    },
    /** Show a placeholder without asking the printer for anything. */
    idle(text) {
      inFlight++;
      lastZpl = '';
      status.textContent = '';
      showMessage(text);
    },
    print(zpl) {
      lastZpl = zpl;
      run('print');
    },
    setStatus(text) {
      status.textContent = text;
    },
  };
}
