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
 * imagedialog.js -- pick a picture, see what the printer will make of
 * it, and send it.
 *
 * The preview is the point: a photograph reduced to one bit looks very
 * little like the photograph, and it is better to find that out here
 * than on a label.
 */

import { el, modal, toast } from './ui.js';
import { printer, toDots, fromDots, unitStep } from './state.js';
import { uploadGraphic } from './printer.js';
import { loadImageFile, prepareGraphic, objectNameFrom } from './imageprep.js';

/** Hex doubles the byte count, and it all goes over a ~56 KB/s link. */
function describeCost(totalBytes) {
  const kb = (totalBytes * 2) / 1024;
  const seconds = kb / 56;
  return (
    `${(totalBytes / 1024).toFixed(1)} KB stored, ${kb.toFixed(0)} KB to send` +
    (seconds > 2 ? ` (about ${seconds.toFixed(0)}s)` : '')
  );
}

/**
 * Ask for an image and upload it as a .GRF.
 *
 * Resolves with the stored object's name, or null if cancelled.
 */
export function uploadImageDialog({ doc }) {
  return modal('Add an image', (close) => {
    const unit = doc.unit;

    let img = null;
    let prepared = null;
    let ratio = 1;

    const fileInput = el('input', {
      class: 'field',
      type: 'file',
      accept: 'image/*',
    });
    const nameInput = el('input', {
      class: 'field field-mono',
      type: 'text',
      maxlength: '16',
      placeholder: 'IMAGE',
    });
    const widthInput = el('input', {
      class: 'field field-mono w-28',
      type: 'number',
      min: '0',
      step: String(unitStep(unit)),
    });
    const ditherBox = el('input', {
      type: 'checkbox',
      class: 'h-3.5 w-3.5 accent-ink-900',
      checked: true,
    });

    const previewImg = el('img', {
      class: 'max-h-48 max-w-full bg-white ring-1 ring-ink-300',
      style: 'image-rendering:pixelated;',
      alt: 'One-bit preview',
      hidden: true,
    });
    const costNode = el('p', { class: 'text-[11px] text-ink-400' });
    const hintNode = el('p', { class: 'text-[12px] text-ink-500' }, [
      'Pick an image. It will be reduced to one bit per pixel, which is all the printer can store.',
    ]);
    const uploadBtn = el('button', { class: 'btn-primary', disabled: true }, ['Upload to printer']);

    function regenerate() {
      if (!img) return;
      const widthDots = Math.max(8, toDots(Number(widthInput.value) || 0, unit));
      const heightDots = Math.max(1, Math.round(widthDots * ratio));

      prepared = prepareGraphic(img, widthDots, heightDots, { dither: ditherBox.checked });
      previewImg.src = prepared.preview;
      previewImg.hidden = false;
      costNode.textContent = `${prepared.width} × ${prepared.height} dots — ${describeCost(prepared.totalBytes)}`;
      uploadBtn.disabled = false;
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        img = await loadImageFile(file);
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
      ratio = img.naturalHeight / img.naturalWidth;
      if (!nameInput.value) nameInput.value = objectNameFrom(file.name);

      // Default to a third of the label, which is a useful size for a
      // logo and keeps the upload small.
      const target = Math.min(img.naturalWidth, Math.round(doc.width / 3));
      widthInput.value = String(fromDots(target, unit));
      hintNode.textContent = `${file.name} — ${img.naturalWidth} × ${img.naturalHeight} source pixels`;
      regenerate();
    });

    widthInput.addEventListener('change', regenerate);
    ditherBox.addEventListener('change', regenerate);

    uploadBtn.addEventListener('click', async () => {
      const oname = objectNameFrom(nameInput.value || 'IMAGE');
      if (!prepared) return;

      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Uploading…';
      const busy = toast(`Sending ${oname}.GRF to the printer…`, 'busy', { timeout: 0 });
      try {
        const stored = await uploadGraphic({
          oname,
          hex: prepared.hex,
          totalBytes: prepared.totalBytes,
          bytesPerRow: prepared.bytesPerRow,
        });
        busy.update(`Stored ${stored.name}`, 'success');
        close(stored.name);
      } catch (err) {
        busy.close();
        toast(`Upload failed: ${err.message}`, 'error');
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload to printer';
      }
    });

    return el('div', { class: 'space-y-3' }, [
      fileInput,
      hintNode,
      el('div', { class: 'grid grid-cols-2 gap-3' }, [
        el('label', { class: 'block space-y-1' }, [
          el('span', { class: 'label-text' }, ['Object name']),
          nameInput,
        ]),
        el('label', { class: 'block space-y-1' }, [
          el('span', { class: 'label-text' }, [`Width (${unit})`]),
          widthInput,
        ]),
      ]),
      el('label', { class: 'flex items-center gap-2 text-ink-700' }, [
        ditherBox,
        'Dither (better for photographs, worse for line art)',
      ]),
      el(
        'div',
        { class: 'flex items-center justify-center rounded border border-ink-200 bg-ink-50 p-2' },
        [previewImg],
      ),
      costNode,
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Cancel']),
        uploadBtn,
      ]),
    ]);
  });
}
