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
 * arrange.js -- lining several elements up, and spacing them evenly.
 *
 * Works on the boxes the elements occupy on the canvas, in dots, as
 * { id, x, y, w, h }, and answers how far each has to move: a Map of
 * id -> { dx, dy }. Aligning goes to the edge or centre of the whole
 * selection's extent; distributing keeps the outermost two where they
 * are and spaces the rest so the gaps between neighbours are equal.
 */

export const ALIGNMENTS = ['left', 'center', 'right', 'top', 'middle', 'bottom'];

/** How far each box moves to line up along `how` (one of ALIGNMENTS). */
export function alignBoxes(boxes, how) {
  const moves = new Map();
  if (boxes.length < 2) return moves;
  const left = Math.min(...boxes.map((b) => b.x));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  for (const b of boxes) {
    let dx = 0;
    let dy = 0;
    if (how === 'left') dx = left - b.x;
    else if (how === 'right') dx = right - (b.x + b.w);
    else if (how === 'center') dx = Math.round((left + right) / 2 - (b.x + b.w / 2));
    else if (how === 'top') dy = top - b.y;
    else if (how === 'bottom') dy = bottom - (b.y + b.h);
    else if (how === 'middle') dy = Math.round((top + bottom) / 2 - (b.y + b.h / 2));
    else throw new Error(`Unknown alignment: ${how}`);
    moves.set(b.id, { dx, dy });
  }
  return moves;
}

/**
 * How far each box moves so the gaps between neighbours along `axis`
 * ("x" or "y") are equal. Needs three or more; the first and last stay.
 */
export function distributeBoxes(boxes, axis) {
  const moves = new Map();
  if (boxes.length < 3) return moves;
  const pos = axis === 'x' ? 'x' : 'y';
  const size = axis === 'x' ? 'w' : 'h';
  const sorted = [...boxes].sort((a, b) => a[pos] - b[pos] || a.id.localeCompare(b.id));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last[pos] + last[size] - first[pos];
  const occupied = sorted.reduce((sum, b) => sum + b[size], 0);
  const gap = (span - occupied) / (sorted.length - 1);
  let at = first[pos];
  sorted.forEach((b, i) => {
    const target = i === sorted.length - 1 ? b[pos] : Math.round(at);
    const delta = target - b[pos];
    moves.set(b.id, pos === 'x' ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
    at += b[size] + gap;
  });
  return moves;
}
