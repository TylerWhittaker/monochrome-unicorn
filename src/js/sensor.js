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
 * sensor.js -- the media sensor, beside Maintenance in Printer Settings.
 *
 * What the printer will say about how it finds the labels: which sensor
 * is in use (the transmissive gap sensor, or the reflective one that
 * looks for black marks on the back), what each reads now, and the two
 * thresholds it compares that with -- one for the edge of a label, one
 * for running out. Watch re-reads it every second, so moving the media
 * by hand shows the reading change.
 *
 * The profile graph itself cannot be shown here: device.sensor_profile
 * and ~JG print it, and nothing hands the samples back to a page.
 * Read from a helper file of its own (SENSOR.SHTML).
 */

import { el, confirmDialog, replaceChildren, toast } from './ui.js';
import { readSensor, sendControl } from './printer.js';

/** The two sensors, by the prefix of their settings. */
export const SENSORS = [
  [
    'gap',
    'Gap (transmissive)',
    'Light through the liner: a label blocks it, the gap between lets it through.',
  ],
  [
    'back_bar',
    'Black mark (reflective)',
    'Light off the back of the media: a black mark reflects less.',
  ],
];

/** Which sensor a media.sense_mode uses: "gap", "back_bar", or null. */
export function activeSensor(mode) {
  const m = String(mode || '').toLowerCase();
  if (m === 'gap' || m === 'web') return 'gap';
  if (m === 'bar' || m === 'mark') return 'back_bar';
  return null;
}

const asNumber = (text) => {
  const n = Number(text);
  return text === '' || text === undefined || text === null || !Number.isFinite(n) ? null : n;
};

/**
 * A sensor's numbers as positions along a 0-255 scale, in percent:
 * { reading, threshold, paperOut } (each null if the printer did not say).
 */
export function gaugeMarks(values, prefix) {
  const at = (name) => {
    const n = asNumber(values[`sensor.${prefix}.${name}`]);
    return n === null ? null : Math.min(100, Math.max(0, (n / 255) * 100));
  };
  return { reading: at('cur'), threshold: at('thold'), paperOut: at('ppr_out_thold') };
}

/** How long Watch keeps reading before it stops by itself. */
export const WATCH_MS = 120000;

/** The card, and a refresh() to re-read it. */
export function createSensorCard() {
  const body = el('div', { class: 'space-y-3 px-3 py-2' }, [
    el('p', { class: 'text-[12px] text-ink-400' }, ['Reading the media sensor…']),
  ]);
  const node = el('details', { class: 'card overflow-hidden', open: true, id: 'media-sensor' }, [
    el(
      'summary',
      {
        class:
          'cursor-pointer border-b border-ink-200 bg-ink-50/70 px-3 py-2 text-[12px] font-semibold text-ink-700',
      },
      ['Media sensor'],
    ),
    body,
  ]);

  let watchUntil = 0;
  let timer = null;
  let reads = 0;

  const line = (label, value) =>
    el('div', { class: 'flex items-baseline justify-between gap-3' }, [
      el('span', { class: 'text-[12px] text-ink-500' }, [label]),
      el('span', { class: 'font-mono text-[12px] text-ink-900' }, [value]),
    ]);

  function gauge(values, [prefix, title, how], inUse) {
    const marks = gaugeMarks(values, prefix);
    if (marks.reading === null && marks.threshold === null) return null;
    const raw = (name) => values[`sensor.${prefix}.${name}`];
    const tick = (pos, cls, label) =>
      pos === null
        ? null
        : el('div', {
            class: `absolute -top-1 -bottom-1 w-0.5 ${cls}`,
            style: `left:calc(${pos}% - 1px)`,
            title: label,
          });
    return el('div', { class: 'space-y-1', dataset: { gauge: prefix } }, [
      el('div', { class: 'flex items-baseline gap-2' }, [
        el('span', { class: 'text-[12px] font-medium text-ink-800' }, [title]),
        inUse ? el('span', { class: 'pill bg-emerald-50 text-emerald-700' }, ['in use']) : null,
        el(
          'span',
          { class: 'ml-auto font-mono text-[12px] text-ink-900', dataset: { reading: '1' } },
          [raw('cur') ?? '—'],
        ),
      ]),
      el('div', { class: 'relative h-3 rounded bg-gradient-to-r from-ink-900 to-ink-100' }, [
        marks.reading === null
          ? null
          : el('div', {
              class:
                'absolute -top-1 h-5 w-2.5 rounded-sm border-2 border-white bg-sky-500 shadow transition-[left] duration-300',
              style: `left:calc(${marks.reading}% - 5px)`,
              title: `Reading ${raw('cur')}`,
            }),
        tick(marks.threshold, 'bg-amber-500', `Label threshold ${raw('thold')}`),
        tick(marks.paperOut, 'bg-red-600', `Paper-out threshold ${raw('ppr_out_thold')}`),
      ]),
      el('div', { class: 'flex flex-wrap gap-x-3 text-[11px] text-ink-500' }, [
        el('span', { class: 'text-amber-700' }, [`label threshold ${raw('thold') ?? '—'}`]),
        el('span', { class: 'text-red-700' }, [`paper out ${raw('ppr_out_thold') ?? '—'}`]),
        el('span', { class: 'text-ink-400' }, [how]),
      ]),
    ]);
  }

  async function confirmAndSend(title, message, command, done) {
    if (!(await confirmDialog(title, message, 'Go ahead'))) return;
    try {
      await sendControl(command);
      toast(done, 'success');
    } catch (err) {
      toast(`The printer did not take ${command}: ${err.message}`, 'error');
    }
  }

  function stopWatching() {
    watchUntil = 0;
    clearTimeout(timer);
    timer = null;
  }

  /** Whether a watch read should happen now: open, on screen, in time. */
  const watching = () =>
    watchUntil > Date.now() &&
    node.open &&
    node.isConnected &&
    node.offsetParent !== null &&
    document.visibilityState === 'visible';

  async function tick() {
    timer = null;
    if (!watching()) {
      stopWatching();
      await refresh();
      return;
    }
    await refresh();
    if (watchUntil) timer = setTimeout(tick, 1000);
  }

  async function refresh() {
    let v;
    try {
      v = await readSensor();
      reads += 1;
    } catch (err) {
      replaceChildren(body, [
        el('p', { class: 'text-[12px] text-red-700' }, [
          `Could not read the sensor: ${err.message}`,
        ]),
      ]);
      return;
    }
    const known = (name) => v[name] !== undefined && v[name] !== '?' && v[name] !== '';
    const active = activeSensor(v['media.sense_mode']);
    const media = [
      known('media.sense_mode') ? `finds labels by ${v['media.sense_mode']}` : null,
      known('device.sensor_select') ? `${v['device.sensor_select']} sensor selected` : null,
      known('media.type') ? `${v['media.type']} media` : null,
    ].filter(Boolean);
    const gauges = SENSORS.map((s) => gauge(v, s, s[0] === active)).filter(Boolean);
    const isWatching = Boolean(watchUntil);
    replaceChildren(body, [
      media.length ? el('p', { class: 'text-[12px] text-ink-600' }, [media.join(' · ')]) : null,
      el('div', { class: 'grid gap-x-6 sm:grid-cols-2' }, [
        known('media.status') ? line('Media', v['media.status']) : null,
        known('head.latch')
          ? line('Head', v['head.latch'] === 'ok' ? 'closed' : v['head.latch'])
          : null,
        known('zpl.label_length') ? line('Label length', `${v['zpl.label_length']} dots`) : null,
      ]),
      ...(gauges.length
        ? gauges
        : [
            el('p', { class: 'text-[12px] text-ink-400' }, [
              'This printer reports no sensor readings.',
            ]),
          ]),
      el('div', { class: 'flex flex-wrap items-center gap-2 pt-1' }, [
        el(
          'button',
          {
            class: isWatching ? 'btn-primary btn-sm' : 'btn-secondary btn-sm',
            'aria-pressed': String(isWatching),
            title: 'Read the sensor every second for two minutes',
            onclick: () => {
              if (watchUntil) {
                stopWatching();
                refresh();
              } else {
                watchUntil = Date.now() + WATCH_MS;
                tick();
              }
            },
          },
          [isWatching ? 'Stop watching' : 'Watch'],
        ),
        el(
          'button',
          {
            class: 'btn-secondary btn-sm',
            onclick: () =>
              confirmAndSend(
                'Calibrate the media sensor?',
                'The printer feeds labels to measure them and sets the thresholds again (~JC).',
                '~JC',
                'Calibrating.',
              ),
          },
          ['Calibrate…'],
        ),
        el(
          'button',
          {
            class: 'btn-secondary btn-sm',
            onclick: () =>
              confirmAndSend(
                'Print the sensor profile?',
                'The printer feeds and prints a graph of what the sensor sees along the media (~JG). ' +
                  'It is the only place the profile exists: the printer does not hand it back.',
                '~JG',
                'Printing the sensor profile.',
              ),
          },
          ['Print sensor profile…'],
        ),
        isWatching
          ? el('span', { class: 'text-[11px] text-ink-400', dataset: { reads: String(reads) } }, [
              `read ${reads} time${reads === 1 ? '' : 's'}`,
            ])
          : el('button', { class: 'btn-secondary btn-sm ml-auto', onclick: () => refresh() }, [
              'Refresh',
            ]),
      ]),
    ]);
  }

  node.addEventListener('toggle', () => {
    if (!node.open) stopWatching();
  });

  return { node, refresh, stopWatching };
}
