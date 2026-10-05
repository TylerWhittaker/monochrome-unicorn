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

/* Align and distribute maths. Run: node test/arrange.test.mjs */
import assert from 'node:assert/strict';
import { alignBoxes, distributeBoxes } from '../src/js/arrange.js';

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

console.log('arrange: all passing');
