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
 * history.js -- undo and redo for the Label Editor.
 *
 * States are opaque strings (the editor records its label as JSON), so
 * telling a change from no change is a comparison, and a state cannot be
 * altered once it has been recorded. Changes that arrive close together
 * -- the strokes of one edit -- count as one step.
 */

/**
 * A history of states. `record` after each change, `undo`/`redo` hand
 * back the state to restore (or null at either end), `reset` starts
 * again from a new document.
 */
export function createHistory({ limit = 100, coalesceMs = 400, now = () => Date.now() } = {}) {
  let past = [];
  let future = [];
  let current = null;
  let lastAt = -Infinity;

  return {
    reset(state) {
      past = [];
      future = [];
      current = state;
      lastAt = -Infinity;
    },
    /** True when `state` differs from what was there, and so was recorded. */
    record(state) {
      if (state === current) return false;
      const at = now();
      // The first change of a burst keeps what was there before it; the
      // rest of the burst only moves the present on.
      if (current !== null && at - lastAt > coalesceMs) {
        past.push(current);
        if (past.length > limit) past.shift();
      }
      current = state;
      future = [];
      lastAt = at;
      return true;
    },
    undo() {
      if (!past.length) return null;
      future.push(current);
      current = past.pop();
      lastAt = -Infinity;
      return current;
    },
    redo() {
      if (!future.length) return null;
      past.push(current);
      current = future.pop();
      lastAt = -Infinity;
      return current;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
  };
}
