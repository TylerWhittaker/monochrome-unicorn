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
 * backup.js -- what goes in a settings backup, and how one compares.
 *
 * A backup is the writable settings a printer has been given -- those
 * that differ from the factory default, or all of them -- as JSON, to put
 * back after a reset or onto another printer of the same kind. Some
 * settings never go in: secrets (and they are write-only, so there is
 * nothing to read), commands, the user's own device.user_vars (writing
 * cannot recreate them), and -- unless asked for -- the network address
 * and identity, which copied onto another printer would knock one of the
 * two off the network.
 */

export const BACKUP_FORMAT = 'zebra-console-settings';

const SECRET = /password|passphrase|_pin\b|pin$|\.psk$|private_key|privkey|\.key$/;
/*
 * Never restored: user variables (cannot be recreated by writing), the
 * clock (it would go back to when the backup was taken), the odometers
 * (writable, so a restore would overwrite the real counts), and settings
 * that do something when written rather than hold a value.
 */
const NEVER = new RegExp(
  '^(' +
    [
      'device\\.user_vars\\.',
      'file\\.',
      'zbi\\.',
      'rtc\\.',
      'odometer\\.',
      'device\\.(reset|pause|unpause|restore_defaults|frontpanel\\.key_press|print_out_report)',
      'head\\.element_test',
      'display\\.(load_card|previous_displayed_card|password\\.)',
      '(ip|usb)\\.mirror\\.fetch',
      'usb\\.host\\.',
      'rfid\\.(tag\\.|log\\.clear)',
      'ezpl\\.manual_calibration',
      'zpl\\.calibrate',
      'media\\.cut_now',
      'ip\\.mirror\\.feedback\\.odometer',
      'netmanage\\.avalanche\\.available_',
      'weblink\\.cloud_connect\\.(configuration_key|configuration_confirmation|connection_key)',
    ].join('|') +
    ')',
);
const NETWORK =
  /^(ip\.|wlan\.|internal_wired\.|interface\.network\.|bluetooth\.(friendly_name|address)|device\.friendly_name|weblink\.|netmanage\.)/;

/** Whether a setting belongs in a backup at all. */
export function backupWorthy(meta, { includeNetwork = false } = {}) {
  if (!meta.writable || !meta.readable) return false;
  if (meta.type === 'json') return false;
  if (SECRET.test(meta.name) || NEVER.test(meta.name)) return false;
  if (!includeNetwork && NETWORK.test(meta.name)) return false;
  return true;
}

/**
 * The backup: { format, version, printer, captured, settings: {name:value} }.
 * `same(a, b)` decides whether a value is still the factory default.
 */
export function buildBackup({
  metas,
  values,
  includeAll = false,
  includeNetwork = false,
  same = (a, b) => a === b,
  info = {},
  now = new Date(),
}) {
  const settings = {};
  for (const meta of metas) {
    if (!backupWorthy(meta, { includeNetwork })) continue;
    const value = values[meta.name];
    if (value === undefined) continue;
    const changed =
      meta.default === null || meta.default === undefined || !same(value, meta.default);
    if (includeAll || changed) settings[meta.name] = value;
  }
  return {
    format: BACKUP_FORMAT,
    version: 1,
    printer: info,
    captured: now.toISOString(),
    settings,
  };
}

/**
 * A backup against this printer, one row per setting in it:
 * { name, backup, current, status } where status is "differs", "same",
 * "missing" (this printer has no such setting) or "read-only".
 */
export function compareBackup(backup, metas, values, same = (a, b) => a === b) {
  if (!backup || backup.format !== BACKUP_FORMAT || typeof backup.settings !== 'object') {
    throw new Error('This is not a settings backup made by this console.');
  }
  const byName = new Map(metas.map((m) => [m.name, m]));
  return Object.entries(backup.settings).map(([name, value]) => {
    const meta = byName.get(name);
    const current = values[name];
    let status;
    if (!meta) status = 'missing';
    else if (!meta.writable) status = 'read-only';
    else status = current !== undefined && same(current, value) ? 'same' : 'differs';
    return { name, backup: String(value), current: current === undefined ? null : current, status };
  });
}
