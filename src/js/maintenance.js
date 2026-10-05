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
 * maintenance.js -- the printer's odometers, at the top of Printer Settings.
 *
 * How far media has run since the head was last cleaned and since it
 * was replaced, labels and cuts over the printer's life, and the rest of
 * what someone looking after a printer asks first -- with buttons to
 * reset the head counters after cleaning or replacing it. Read from a
 * helper file of its own (MAINT.SHTML).
 */

import { el, confirmDialog, replaceChildren, toast } from './ui.js';
import { readMaintenance, sendCommandSetting, sendControl } from './printer.js';

/** "2026 INCHES, 5147 CENTIMETERS" -> { inches: 2026, cm: 5147 }, or null. */
export function parseOdometerLength(text) {
  const m = /([\d.]+)\s*INCHES?\s*,\s*([\d.]+)\s*CENTIMETERS?/i.exec(String(text ?? ''));
  return m ? { inches: Number(m[1]), cm: Number(m[2]) } : null;
}

/** A distance in inches and metres: "2,026 in · 51.5 m". */
export function describeLength(text) {
  const length = parseOdometerLength(text);
  if (!length) return text || '—';
  const metres = length.cm / 100;
  return `${length.inches.toLocaleString('en-US')} in · ${metres.toLocaleString('en-US', {
    maximumFractionDigits: metres < 10 ? 2 : 1,
  })} m`;
}

/** "00 days 02 hours 56 mins 32 secs" -> "2 h 56 min"; "3 d 2 h" past a day. */
export function describeUptime(text) {
  const m = /(\d+)\s*days?\s*(\d+)\s*hours?\s*(\d+)\s*mins?\s*(\d+)\s*secs?/i.exec(
    String(text ?? ''),
  );
  if (!m) return text || '—';
  const [d, h, min, sec] = m.slice(1).map(Number);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${min} min`;
  return min ? `${min} min` : `${sec} s`;
}

/** The card, and a refresh() to re-read it. */
export function createMaintenanceCard() {
  const body = el('div', { class: 'grid gap-x-6 gap-y-1 px-3 py-2 sm:grid-cols-2' }, [
    el('p', { class: 'text-[12px] text-ink-400' }, ['Reading the odometers…']),
  ]);
  const node = el('details', { class: 'card overflow-hidden', open: true, id: 'maintenance' }, [
    el(
      'summary',
      {
        class:
          'cursor-pointer border-b border-ink-200 bg-ink-50/70 px-3 py-2 text-[12px] font-semibold text-ink-700',
      },
      ['Maintenance'],
    ),
    body,
  ]);

  const row = (label, value, title = '') =>
    el('div', { class: 'flex items-baseline justify-between gap-3 py-0.5', title }, [
      el('span', { class: 'text-[12px] text-ink-500' }, [label]),
      el('span', { class: 'font-mono text-[12px] text-ink-900' }, [value]),
    ]);

  async function reset(names, what) {
    const ok = await confirmDialog(
      `${what}?`,
      `The counter${names.length > 1 ? 's' : ''} for ${names.join(' and ')} go back to 0.`,
      'Reset',
    );
    if (!ok) return;
    try {
      for (const name of names) await sendCommandSetting(name, '0');
      await refresh();
      toast('Counter reset.', 'success');
    } catch (err) {
      toast(`Could not reset it: ${err.message}`, 'error');
    }
  }

  async function refresh() {
    let v;
    try {
      v = await readMaintenance();
    } catch (err) {
      replaceChildren(body, [
        el('p', { class: 'text-[12px] text-red-700' }, [
          `Could not read the odometers: ${err.message}`,
        ]),
      ]);
      return;
    }
    const has = (name) => v[name] !== undefined && v[name] !== '?' && v[name] !== '';
    const rows = [
      has('odometer.headclean') &&
        row(
          'Since the head was cleaned',
          describeLength(v['odometer.headclean']),
          'odometer.headclean',
        ),
      has('odometer.headnew') &&
        row(
          'Since the head was replaced',
          describeLength(v['odometer.headnew']),
          'odometer.headnew',
        ),
      has('odometer.total_label_count') &&
        row('Labels printed', Number(v['odometer.total_label_count']).toLocaleString('en-US')),
      has('odometer.total_print_length') &&
        row('Media moved, in all', describeLength(v['odometer.total_print_length'])),
      has('odometer.total_cuts') &&
        row('Cuts', Number(v['odometer.total_cuts']).toLocaleString('en-US')),
      has('odometer.latch_open_count') &&
        row('Times the head was opened', v['odometer.latch_open_count']),
      has('sensor.head.temp_celsius') &&
        row('Head temperature', `${v['sensor.head.temp_celsius']} °C`),
      has('device.uptime') && row('On for', describeUptime(v['device.uptime'])),
      has('log.reboot.reason') && row('Last restart', v['log.reboot.reason']),
    ].filter(Boolean);
    const buttons = el(
      'div',
      { class: 'col-span-full flex flex-wrap gap-2 pt-2' },
      [
        has('odometer.headclean') &&
          el(
            'button',
            {
              class: 'btn-secondary btn-sm',
              onclick: () => reset(['odometer.headclean'], 'Head cleaned'),
            },
            ['Head cleaned'],
          ),
        has('odometer.headnew') &&
          el(
            'button',
            {
              class: 'btn-secondary btn-sm',
              // A new head is a clean head too.
              onclick: () => reset(['odometer.headnew', 'odometer.headclean'], 'Head replaced'),
            },
            ['Head replaced'],
          ),
        el(
          'button',
          {
            class: 'btn-secondary btn-sm',
            onclick: async () => {
              const ok = await confirmDialog(
                'Print the configuration label?',
                'One label listing the printer’s settings is printed.',
                'Print',
              );
              if (!ok) return;
              try {
                await sendControl('~WC');
                toast('Printing the configuration label.', 'success');
              } catch (err) {
                toast(`The printer did not take ~WC: ${err.message}`, 'error');
              }
            },
          },
          ['Print configuration label'],
        ),
        el('button', { class: 'btn-secondary btn-sm ml-auto', onclick: () => refresh() }, [
          'Refresh',
        ]),
      ].filter(Boolean),
    );
    replaceChildren(body, [...rows, buttons]);
  }

  return { node, refresh };
}
