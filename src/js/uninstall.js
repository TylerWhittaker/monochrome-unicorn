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
 * uninstall.js -- take the console off the printer, from the bottom of
 * Printer Settings.
 *
 * What an install puts on the printer is INDEX.SHTML and its helper
 * files, every one an .SHTML on E:, so uninstalling is one file.delete
 * of E:*.SHTML (the SGD takes a wildcard, and needs no password). With
 * E:INDEX.SHTML gone the printer's web server serves its own factory
 * pages at / again. Nothing else is touched: settings, stored labels,
 * pictures and fonts stay as they are.
 */

import { el, modal, toast } from './ui.js';
import { uninstallConsole } from './printer.js';

/** The card at the bottom of Printer Settings. */
export function createUninstallCard() {
  const button = el(
    'button',
    { class: 'btn-danger btn-sm', id: 'uninstall', onclick: () => openUninstallDialog() },
    ['Uninstall…'],
  );
  return el('div', { class: 'card flex flex-wrap items-center gap-3 px-3 py-2.5' }, [
    el('div', { class: 'min-w-0 flex-1' }, [
      el('p', { class: 'text-[12px] font-semibold text-ink-700' }, ['Uninstall the web interface']),
      el('p', { class: 'text-[12px] text-ink-500' }, [
        'Removes this console from the printer, every .SHTML file on its E: drive, ' +
          'and puts back the printer’s factory web pages. Settings, labels and ' +
          'pictures are kept.',
      ]),
    ]),
    button,
  ]);
}

/** Ask, and make sure the person knows what they are agreeing to. */
async function openUninstallDialog() {
  const understood = el('input', {
    type: 'checkbox',
    id: 'uninstall-understood',
    class: 'mt-0.5 h-3.5 w-3.5 shrink-0 accent-red-700',
  });
  const go = el('button', { class: 'btn-danger', id: 'uninstall-confirm', disabled: true }, [
    'Uninstall',
  ]);
  understood.addEventListener('change', () => {
    go.disabled = !understood.checked;
  });

  const confirmed = await modal('Uninstall Monochrome Unicorn?', (close) => {
    go.addEventListener('click', () => close(understood.checked));
    return el('div', { class: 'space-y-3 text-[13px]' }, [
      el('p', { class: 'text-ink-700' }, [
        'This deletes every .SHTML file on the printer’s E: drive: this console ' +
          '(INDEX.SHTML), its helper files, and any other .SHTML stored there. The ' +
          'printer’s web server then serves its factory default pages again.',
      ]),
      el('p', { class: 'text-ink-700' }, [
        'Nothing else changes: the printer’s settings, stored labels, pictures and ' +
          'fonts stay as they are. To use this console again, run the installer.',
      ]),
      el('label', { class: 'flex items-start gap-2 text-ink-800', for: 'uninstall-understood' }, [
        understood,
        'I understand that this uninstalls the web interface and returns the ' +
          'printer’s web pages to their factory default.',
      ]),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(false) }, ['Cancel']),
        go,
      ]),
    ]);
  });
  if (confirmed !== true) return;

  toast('Uninstalling…', 'info');
  try {
    await uninstallConsole();
  } catch (err) {
    toast(`Uninstall failed: ${err.message}`, 'error', { timeout: 10000 });
    return;
  }
  showUninstalled();
}

/*
 * The console is no longer on the printer, so nothing on this page can
 * work: say so in its place. printer.js has stopped sending requests.
 */
function showUninstalled() {
  const home = `${location.protocol}//${location.host}/`;
  document.body.replaceChildren(
    el('main', { class: 'mx-auto max-w-xl px-4 py-16', id: 'uninstalled' }, [
      el('h1', { class: 'text-lg font-semibold text-ink-900' }, [
        'Monochrome Unicorn is uninstalled',
      ]),
      el('p', { class: 'mt-3 text-ink-700' }, [
        'Every .SHTML file is gone from the printer’s E: drive, and its web server ' +
          'serves its factory pages again at ',
        el('a', { class: 'underline', href: home }, [home]),
        '. Your browser may show this console from its cache until you reload.',
      ]),
      el('p', { class: 'mt-3 text-ink-700' }, [
        'To put it back, run the installer again: ',
        el(
          'a',
          {
            class: 'underline',
            href: 'https://github.com/TylerWhittaker/monochrome-unicorn#installing',
            target: '_blank',
            rel: 'noreferrer',
          },
          ['how to install'],
        ),
        '.',
      ]),
    ]),
  );
}
