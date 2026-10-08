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
 * gallery.js -- stored pictures as thumbnails.
 *
 * The Label Editor's Choose… and File System's Pictures view both draw
 * the printer's graphics as a grid of tiles. Each picture comes from
 * /png, one at a time (the printer serves one request at a time), in the
 * order shown, and is cached for the rest of the visit, so a second look
 * is instant.
 */

import { el, modal, formatBytes } from './ui.js';
import { loadStoredImage } from './printer.js';
import { objectNameFrom } from './imageprep.js';

/** The types /png will draw for us. */
export const PICTURE_TYPES = ['PNG', 'GRF', 'BMP', 'PCX'];

export const isPicture = (file) => PICTURE_TYPES.includes(String(file.otype).toUpperCase());

/**
 * The new name a rename would give, or why it cannot: object names are
 * up to 16 letters, digits and underscores, and keep their type.
 */
export function renameTarget(file, wanted, existing = []) {
  const oname = objectNameFrom(String(wanted || '').trim());
  if (!String(wanted || '').trim()) return { error: 'Give it a name.' };
  if (oname === file.oname) return { error: 'That is its name already.' };
  const name = `${file.dev}:${oname}.${file.otype}`;
  if (existing.some((f) => f.name === name)) return { error: `${name} is already there.` };
  return { oname, name };
}

/**
 * A grid of tiles, one per file. `onPick(file)` makes each tile a button;
 * `actions(file)` adds buttons under it; `selected` is the name of a file
 * to mark.
 */
export function pictureGrid(files, { onPick = null, actions = null, selected = '' } = {}) {
  const tiles = files.map((file) => {
    const img = el('img', {
      alt: file.name,
      class: 'max-h-full max-w-full object-contain [image-rendering:pixelated]',
      hidden: true,
    });
    const status = el('span', { class: 'text-[11px] text-ink-400' }, ['loading…']);
    const size = el('span', {}, [file.bytes ? formatBytes(file.bytes) : '']);
    img.addEventListener('load', () => {
      status.remove();
      img.hidden = false;
      size.textContent = [`${img.naturalWidth} × ${img.naturalHeight}`, size.textContent]
        .filter(Boolean)
        .join(' · ');
    });
    const picture = el(
      'div',
      {
        class:
          'flex h-28 items-center justify-center overflow-hidden rounded border border-ink-200 bg-white p-1',
      },
      [img, status],
    );
    const caption = el('div', { class: 'min-w-0 px-0.5 pt-1' }, [
      el('div', { class: 'truncate font-mono text-[11px] text-ink-900', title: file.name }, [
        file.name,
      ]),
      el('div', { class: 'text-[10px] text-ink-400' }, [size]),
    ]);
    const marked = file.name === selected;
    const body = onPick
      ? el(
          'button',
          {
            type: 'button',
            class:
              'block w-full rounded p-1 text-left hover:bg-sky-50 focus:outline focus:outline-2 focus:outline-sky-500' +
              (marked ? ' bg-sky-50 outline outline-2 outline-sky-500' : ''),
            onclick: () => onPick(file),
          },
          [picture, caption],
        )
      : el('div', { class: 'p-1' }, [picture, caption]);
    const extra = actions ? actions(file) : null;
    return {
      file,
      img,
      status,
      node: el('div', { class: 'min-w-0', dataset: { picture: file.name } }, [
        body,
        extra ? el('div', { class: 'flex flex-wrap gap-1 px-1 pb-1' }, extra) : null,
      ]),
    };
  });

  // One after another, in the order shown, until the grid leaves the
  // page (a dialog closed, a list redrawn). It is attached by the caller,
  // so start a tick later.
  (async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const tile of tiles) {
      if (!tile.node.isConnected) return;
      try {
        tile.img.src = await loadStoredImage(tile.file);
      } catch (err) {
        tile.status.textContent = 'could not be drawn';
      }
    }
  })();

  return el(
    'div',
    { class: 'grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2' },
    tiles.map((t) => t.node),
  );
}

/** Pick one of `files` from their thumbnails; resolves to the file, or null. */
export function chooseStoredImage(files, current = '') {
  return modal('Choose a stored image', (close) =>
    el('div', { class: 'space-y-3', dataset: { gallery: '1' } }, [
      files.length
        ? pictureGrid(files, { onPick: (file) => close(file), selected: current })
        : el('p', { class: 'text-ink-500' }, ['There are no pictures on E: yet.']),
      el('div', { class: 'flex justify-end' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Cancel']),
      ]),
    ]),
  );
}

/** Ask for a new name for `file`; resolves to the renameTarget result, or null. */
export function askRename(file, existing) {
  return modal(`Rename ${file.name}`, (close) => {
    const input = el('input', {
      class: 'field field-mono w-full',
      value: file.oname,
      maxlength: '16',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    const error = el('p', { class: 'text-[12px] text-red-700' });
    const submit = () => {
      const target = renameTarget(file, input.value, existing);
      if (target.error) error.textContent = target.error;
      else close(target);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    setTimeout(() => input.select(), 0);
    return el('div', { class: 'space-y-3' }, [
      el('label', { class: 'block space-y-1' }, [
        el('span', { class: 'label-text' }, [`New name (keeps .${file.otype})`]),
        input,
      ]),
      error,
      el('p', { class: 'text-[11px] text-ink-400' }, [
        'Up to 16 letters, digits and underscores. Labels that place it by its old name ' +
          'will need changing.',
      ]),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Cancel']),
        el('button', { class: 'btn-primary', onclick: submit }, ['Rename']),
      ]),
    ]);
  });
}
