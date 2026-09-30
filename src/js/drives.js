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
 * drives.js -- one shared copy of file.drive_listing.
 *
 * The listing is the only place the real file extensions live, and it
 * takes about nine seconds to read. Settings reads it once the sweep is
 * done; after that, the File System and Stored Formats modes start from
 * the copy held here and ask for a fresh one in the background. Unless
 * something outside this console has changed the printer's files, the
 * fresh one says the same thing.
 *
 * Every mode that shows the listing subscribes with onDriveListing, and
 * is called when a read starts, lands or fails.
 */

import { readSlowSetting, parseDriveListing } from './printer.js';
import { printer } from './state.js';

/*
 * A copy younger than this is not re-read on a tab switch. The explicit
 * Refresh, and anything this console does to the filesystem, still
 * forces a read.
 */
const DRIVE_LISTING_MAX_AGE = 60000;

const driveCache = {
  /** The listing as file.drive_listing returned it, or null. */
  raw: null,
  /** The same, flattened by parseDriveListing, or null. */
  files: null,
  /** When it was read (ms since the epoch); 0 marks it stale. */
  at: 0,
  /** The read in flight, if any. */
  pending: null,
  /** The last read's failure, cleared by the next success. */
  error: null,
  listeners: new Set(),
};

/** The helper file that reads the listing, or null on a build without one. */
export function driveListingStem() {
  return (printer.schema?.slowFiles || {})['file.drive_listing'] || null;
}

/** The last listing read, as { files, raw, at }, or null if none has been. */
export function cachedDriveListing() {
  if (!driveCache.files) return null;
  return { files: driveCache.files, raw: driveCache.raw, at: driveCache.at };
}

export function driveListingLoading() {
  return driveCache.pending !== null;
}

export function driveListingError() {
  return driveCache.error;
}

/** Call fn whenever a read starts, lands or fails. Returns an unsubscribe. */
export function onDriveListing(fn) {
  driveCache.listeners.add(fn);
  return () => driveCache.listeners.delete(fn);
}

function notifyDriveListing() {
  for (const fn of driveCache.listeners) {
    try {
      fn();
    } catch (err) {
      console.error('A drive listing subscriber failed', err);
    }
  }
}

/** Take a listing read some other way (Settings' Read now) into the cache. */
export function noteDriveListing(raw) {
  driveCache.files = parseDriveListing(raw);
  driveCache.raw = raw;
  driveCache.at = Date.now();
  driveCache.error = null;
  notifyDriveListing();
}

/** The console has changed the filesystem: the next caller re-reads. */
export function staleDriveListing() {
  driveCache.at = 0;
}

/**
 * Read the listing, unless the cached copy is recent enough.
 *
 * Callers joining a read already in flight get that one rather than
 * starting a second: each holds the printer for nine seconds. Resolves
 * with the files, or rejects -- subscribers have been told either way.
 */
export function refreshDriveListing({ force = false } = {}) {
  if (driveCache.pending) return driveCache.pending;
  if (!force && driveCache.files && Date.now() - driveCache.at < DRIVE_LISTING_MAX_AGE) {
    return Promise.resolve(driveCache.files);
  }

  const stem = driveListingStem();
  if (!stem) {
    return Promise.reject(new Error('This build has no helper file for file.drive_listing'));
  }

  driveCache.pending = (async () => {
    try {
      const values = await readSlowSetting(stem);
      noteDriveListing(values['file.drive_listing'] || '');
      return driveCache.files;
    } catch (err) {
      driveCache.error = err;
      throw err;
    } finally {
      driveCache.pending = null;
      notifyDriveListing();
    }
  })();
  notifyDriveListing();
  return driveCache.pending;
}
