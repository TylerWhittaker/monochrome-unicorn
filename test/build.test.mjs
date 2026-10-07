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

// Printer facts read at page load.

// How the build packs settings branches into helper files.

import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packBranches,
  hasLcd,
  withoutLcd,
  packPayload,
  unpackPayload,
  build,
} from '../tools/build.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const branches = (sizes) =>
  new Map(
    Object.entries(sizes).map(([b, n]) => [b, Array.from({ length: n }, (_, i) => `${b}.${i}`)]),
  );

check('small branches share a file, up to the limit', () => {
  const groups = packBranches(branches({ a: 30, b: 12, c: 9, d: 5, e: 1 }), 40);
  assert.deepEqual(groups, [
    ['a', 'c', 'e'],
    ['b', 'd'],
  ]);
});

check('a branch bigger than the limit keeps a file to itself', () => {
  const groups = packBranches(branches({ wlan: 89, zpl: 12, ribbon: 2 }), 40);
  assert.deepEqual(groups, [['wlan'], ['ribbon', 'zpl']]);
});

check('every branch lands in exactly one file', () => {
  const sizes = { a: 41, b: 40, c: 39, d: 20, e: 20, f: 1, g: 1 };
  const all = packBranches(branches(sizes), 40).flat().sort();
  assert.deepEqual(all, Object.keys(sizes).sort());
});

check('the LCD Viewer is offered only with a display.* branch', () => {
  assert.ok(hasLcd({ settings: { 'display.text': [], 'media.type': [] } }));
  assert.ok(!hasLcd({ settings: { 'media.type': [], 'displayish.x': [] } }));
});

check('without an LCD the page loses its tab and panel, and nothing else', () => {
  const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const stripped = withoutLcd(page);
  assert.ok(!/data-(tab|panel)="lcd"/.test(stripped));
  assert.ok(!stripped.includes('LCD Viewer'));
  assert.equal(page.split('\n').length - stripped.split('\n').length, 2);
  assert.throws(() => withoutLcd(stripped), /expected one line/);
});

check('the packed blob round-trips, in short lines', () => {
  const parts = { css: 'body{}', schema: '{"a":1}', htmx: 'var h;', app: 'é ✓ \u2028 </script>' };
  const packed = packPayload(parts, 40);
  assert.deepEqual(unpackPayload(packed), parts);
  assert.ok(packed.split('\n').every((line) => line.length <= 40));
  assert.match(
    packed,
    /^[A-Za-z0-9+/=\n]+$/,
    'nothing the page or the SSI preprocessor would read',
  );
});

const schemaPath = new URL('../data/sgd-schema.json', import.meta.url).pathname;
if (existsSync(schemaPath)) {
  check('the built page keeps the SSI lines plain and packs the rest', () => {
    const out = mkdtempSync(join(tmpdir(), 'zebra-build-'));
    try {
      build({ schemaPath, outDir: out, packed: true });
      const html = readFileSync(join(out, 'INDEX.SHTML'), 'utf8');
      assert.ok(!html.includes('{{'), 'every placeholder filled');
      assert.match(html, /id="boot-vars">[\s\S]*<!--#exec/, 'boot-vars left for the preprocessor');
      assert.equal((html.match(/<!--#/g) || []).length, (html.match(/<!--#exec/g) || []).length);
      const packed = /<script type="text\/plain" id="packed">\n([\s\S]*?)\n<\/script>/.exec(html);
      assert.ok(packed, 'a packed block');
      const parts = unpackPayload(packed[1]);
      assert.match(parts.app, /function start\(\)/);
      assert.ok(JSON.parse(parts.schema).settings, 'the catalogue');
      assert.match(parts.htmx, /htmx/);
      assert.ok(parts.css.length > 1000);
      assert.ok(html.length < 250 * 1024, `the page is ${html.length} bytes`);
      assert.match(html, /Built [^<]*packed/, 'the footer says which build');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  check('the default build inlines each part as it is, unpacked', () => {
    const out = mkdtempSync(join(tmpdir(), 'zebra-build-'));
    try {
      build({ schemaPath, outDir: out });
      const html = readFileSync(join(out, 'INDEX.SHTML'), 'utf8');
      assert.ok(!html.includes('{{'), 'every placeholder filled');
      assert.ok(!html.includes('id="packed"'), 'nothing packed');
      assert.ok(!html.includes('class="unpacking"'), 'not hidden waiting to unpack');
      assert.ok(!html.includes('html.unpacking'), 'no rule hiding it');
      assert.ok(!html.includes('DecompressionStream'), 'no unpacker');
      assert.match(html, /<STYLE>[^<]{1000,}<\/STYLE>/, 'the styles in the head');
      assert.match(html, /<script type="application\/json" id="sgd-schema">\{/);
      assert.match(html, /function start\(\)/);
      assert.match(html, /id="boot-vars">[\s\S]*<!--#exec/);
      assert.doesNotMatch(html, /Built [^<]*packed/, 'the footer names only the packed build');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
} else {
  console.log('  skip the built page (no data/sgd-schema.json yet)');
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
