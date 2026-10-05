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
 * clock.js -- the printer's real-time clock, beside this computer's.
 *
 * Date fields (^FC) print the printer's own clock, so one that has
 * drifted, or was never set, prints wrong dates. The dialog shows how far
 * out it is and sets it from this computer's clock in one write:
 * rtc.unix_timestamp, seconds since 1970 in UTC, which is right whatever
 * time zone either of them is in -- the printer turns it into its own
 * local time with rtc.timezone.
 */

import { el, modal, toast } from './ui.js';
import { readClock, sendCommandSetting } from './printer.js';

/** Within this many seconds, the clocks count as agreeing. */
export const IN_STEP_SECONDS = 5;

/** How far the printer's clock is ahead (+) or behind (-) of `nowMs`, in seconds. */
export function clockDrift(printerUnix, nowMs = Date.now()) {
  return Number(printerUnix) - Math.round(nowMs / 1000);
}

/** The drift in words: "in step", "3 s fast", "1 h 2 min slow". */
export function describeDrift(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const off = Math.abs(seconds);
  if (off <= IN_STEP_SECONDS) return 'in step';
  const parts = [];
  const days = Math.floor(off / 86400);
  const hours = Math.floor((off % 86400) / 3600);
  const minutes = Math.floor((off % 3600) / 60);
  const secs = off % 60;
  if (days) parts.push(`${days} d`);
  if (hours) parts.push(`${hours} h`);
  if (minutes && !days) parts.push(`${minutes} min`);
  if (secs && !days && !hours) parts.push(`${secs} s`);
  return `${parts.join(' ')} ${seconds > 0 ? 'fast' : 'slow'}`;
}

/** Show the two clocks, and offer to set the printer's. */
export async function openClockDialog() {
  let values;
  try {
    values = await readClock();
  } catch (err) {
    toast(`Could not read the printer’s clock: ${err.message}`, 'error');
    return;
  }
  if (values['rtc.exists'] === 'no') {
    toast('This printer has no real-time clock.', 'info');
    return;
  }

  await modal('Printer clock', (close) => {
    const printerLine = el('p', { class: 'font-mono text-ink-800' });
    const computerLine = el('p', { class: 'font-mono text-ink-800' });
    const driftLine = el('p', { class: 'text-[12px]' });
    const setBtn = el('button', { class: 'btn-primary' }, ['Set to this computer’s time']);

    const paint = (v) => {
      printerLine.textContent = `${v['rtc.date']}  ${v['rtc.time']}`;
      computerLine.textContent = new Date().toLocaleString();
      const drift = clockDrift(v['rtc.unix_timestamp']);
      const words = describeDrift(drift);
      driftLine.textContent =
        words === 'in step' ? 'The printer’s clock is right.' : `The printer’s clock is ${words}.`;
      driftLine.className =
        words === 'in step' ? 'text-[12px] text-emerald-700' : 'text-[12px] text-amber-700';
    };
    paint(values);

    setBtn.addEventListener('click', async () => {
      setBtn.disabled = true;
      try {
        await sendCommandSetting('rtc.unix_timestamp', String(Math.round(Date.now() / 1000)));
        const after = await readClock();
        paint(after);
        const drift = clockDrift(after['rtc.unix_timestamp']);
        if (Math.abs(drift) <= IN_STEP_SECONDS) toast('Set the printer’s clock.', 'success');
        else toast(`The printer kept its clock (${describeDrift(drift)}).`, 'error');
      } catch (err) {
        toast(`Could not set the clock: ${err.message}`, 'error');
      } finally {
        setBtn.disabled = false;
      }
    });

    return el('div', { class: 'space-y-3' }, [
      el('div', { class: 'grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1' }, [
        el('span', { class: 'label-text' }, ['Printer']),
        printerLine,
        el('span', { class: 'label-text' }, ['This computer']),
        computerLine,
      ]),
      driftLine,
      el('p', { class: 'text-[11px] text-ink-400' }, [
        `Date fields (^FC) print the printer’s clock. Its time zone is ${values['rtc.timezone'] || 'not set'} ` +
          '(rtc.timezone in Printer Settings); setting the time does not change it.',
      ]),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Close']),
        setBtn,
      ]),
    ]);
  });
}
