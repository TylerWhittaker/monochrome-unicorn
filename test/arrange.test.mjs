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

/* Align and distribute maths. Run: node test/arrange.test.mjs */
import assert from 'node:assert/strict';
import { alignBoxes, distributeBoxes, guideSnap } from '../src/js/arrange.js';

const boxes = [
  { id: 'a', x: 10, y: 50, w: 100, h: 20 },
  { id: 'b', x: 40, y: 10, w: 20, h: 40 },
  { id: 'c', x: 200, y: 100, w: 50, h: 10 },
];
const at = (moves, id) => moves.get(id);

assert.deepEqual(at(alignBoxes(boxes, 'left'), 'c'), { dx: -190, dy: 0 });
assert.deepEqual(at(alignBoxes(boxes, 'right'), 'a'), { dx: 140, dy: 0 });
assert.deepEqual(at(alignBoxes(boxes, 'top'), 'c'), { dx: 0, dy: -90 });
assert.deepEqual(at(alignBoxes(boxes, 'bottom'), 'b'), { dx: 0, dy: 60 });
// Extent 10..250, centre 130; b's centre is 50.
assert.deepEqual(at(alignBoxes(boxes, 'center'), 'b'), { dx: 80, dy: 0 });
assert.equal(alignBoxes(boxes.slice(0, 1), 'left').size, 0, 'one box stays put');
assert.throws(() => alignBoxes(boxes, 'diagonal'));

// x: a 10..110, b 40..60, c 200..250 -> sorted a, b, c; span 240, occupied 170, gap 35.
const spread = distributeBoxes(boxes, 'x');
assert.deepEqual(at(spread, 'a'), { dx: 0, dy: 0 });
assert.deepEqual(at(spread, 'b'), { dx: 145 - 40, dy: 0 });
assert.deepEqual(at(spread, 'c'), { dx: 0, dy: 0 });
assert.equal(distributeBoxes(boxes.slice(0, 2), 'y').size, 0, 'two need no spacing');

// Guides: the nearest line within the tolerance, per axis.
const label = { id: 'label', x: 0, y: 0, w: 400, h: 200 };
const other = { id: 'o', x: 100, y: 20, w: 60, h: 30 };
let g = guideSnap({ x: 103, y: 120, w: 40, h: 20 }, [label, other], 5);
assert.equal(g.dx, -3, 'left edge onto the other’s left');
assert.equal(g.dy, null, 'nothing near on y');
assert.deepEqual(g.lines, [{ axis: 'x', at: 100 }]);
// Centre onto the label's centre (200), and bottom onto the label's (200).
g = guideSnap({ x: 178, y: 158, w: 40, h: 40 }, [label], 5);
assert.deepEqual([g.dx, g.dy], [2, 2]);
assert.deepEqual(
  g.lines.map((l) => `${l.axis}${l.at}`),
  ['x200', 'y200'],
);
// The nearer of two candidates wins.
g = guideSnap(
  { x: 97, y: 0, w: 10, h: 10 },
  [
    { x: 100, y: 500, w: 1, h: 1 },
    { x: 98, y: 500, w: 0, h: 0 },
  ],
  5,
);
assert.equal(g.dx, 1);
// Too far: no snap, no lines.
g = guideSnap({ x: 300, y: 300, w: 10, h: 10 }, [other], 5);
assert.deepEqual(g, { dx: null, dy: null, lines: [] });

console.log('arrange: all passing');
