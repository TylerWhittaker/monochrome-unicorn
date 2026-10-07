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
 * store.js -- a mode's state, and who to tell when it changes.
 *
 * A change used to be handed on by hand: after an edit the Label Editor
 * re-rendered the canvas, the inspector, the layers and the label panel,
 * recorded the history and scheduled a preview, and every path that
 * changed the label had to remember the same list. Here the state says
 * it has changed, with a reason, and each view subscribes to the reasons
 * it cares about once. The reason lets a view skip what does not concern
 * it: the canvas need not redraw a drag it drew itself, nor a field list
 * redraw while its box is being typed in.
 *
 * The state is a plain object, changed in place as before; update()
 * says that it has changed.
 */

/**
 * `on(reasons, fn)` subscribes fn(reason, state) to a reason, a list of
 * them, or '*' for every one, and returns the unsubscribe. `update(reason,
 * fn)` runs fn(state) if given, then every subscriber to that reason, in
 * the order they subscribed. An update made by a subscriber waits until
 * the current round is done.
 */
export function createStore(state) {
  const subscribers = [];
  const queue = [];
  let running = false;

  function on(reasons, fn) {
    const entry = { reasons: reasons === '*' ? null : new Set([].concat(reasons)), fn };
    subscribers.push(entry);
    return () => {
      const i = subscribers.indexOf(entry);
      if (i !== -1) subscribers.splice(i, 1);
    };
  }

  function update(reason, fn) {
    if (fn) fn(state);
    queue.push(reason);
    if (running) return;
    running = true;
    let failure = null;
    try {
      while (queue.length) {
        const next = queue.shift();
        // A copy: a subscriber may unsubscribe itself, or another.
        for (const entry of subscribers.slice()) {
          if (entry.reasons && !entry.reasons.has(next)) continue;
          if (!subscribers.includes(entry)) continue;
          try {
            entry.fn(next, state);
          } catch (err) {
            // The others still run; the first failure is reported after.
            if (!failure) failure = err;
          }
        }
      }
    } finally {
      running = false;
    }
    if (failure) throw failure;
  }

  return { state, update, on };
}
