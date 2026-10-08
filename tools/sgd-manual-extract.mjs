#!/usr/bin/env node
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
 * sgd-manual-extract.mjs -- pull each SGD setting's section out of the
 * programming guide, as raw material for src/data/sgd-reference.mjs.
 *
 * Like tools/zpl-manual-extract.mjs, this does not produce the reference
 * (the guide is Zebra's, and kept out of git): it splits the SGD chapters
 * of the text `pdftotext -layout` makes into one record per setting --
 * its description, which of setvar/getvar/do it takes, and the Values
 * and Default it gives -- for the reference to be written from.
 *
 *   node tools/sgd-manual-extract.mjs reference/zpl-zbi2-pg-en.txt > draft.json
 *
 * A heading that is a pattern -- mqtt.conn[1|2].password, or
 * ip.dhcp.option12 [-format] -- is expanded into the names it stands for.
 */

import { readFileSync } from 'node:fs';

const HEADING = /^([a-z][a-z0-9_]*(?:\.[a-z0-9_[\]|-]+)+)\s*$/;
const FURNITURE = /^\s*(\d+|SGD Printer Commands|SGD Network Commands|SGD RFID Commands)\s*$/;

/** "mqtt.conn[1|2].password" -> both names; plain names stand alone. */
export function expandName(name) {
  const m = /\[([^\]]+)\]/.exec(name);
  if (!m) return [name];
  return m[1].split('|').flatMap((part) => expandName(name.replace(m[0], part)));
}

export function extract(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l, i) => i > 1000 && /^SGD Printer Commands\s*$/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^Mirror\s*$/.test(l));

  const heads = [];
  for (let i = start; i < end; i++) {
    const m = HEADING.exec(lines[i]);
    if (!m || lines[i - 1].trim()) continue;
    const next = lines.slice(i + 1, i + 4).find((l) => l.trim());
    if (next && /^\s{4,}\S/.test(next)) heads.push({ line: i, name: m[1] });
  }

  const records = [];
  heads.forEach((head, k) => {
    const body = lines
      .slice(head.line + 1, k + 1 < heads.length ? heads[k + 1].line : end)
      .filter((l) => !FURNITURE.test(l))
      .map((l) => l.trim());
    const sectionAt = body.findIndex((l) =>
      /^(Setvar|Getvar|Do|Type|Commands|Values|Supported Devices)\b/.test(l),
    );
    const description = body
      .slice(0, sectionAt === -1 ? 6 : sectionAt)
      .filter(Boolean)
      .join(' ');
    const has = (word) => body.some((l) => l === word || l.startsWith(`${word} `));
    const block = (word, stop) => {
      const at = body.findIndex((l) => l === word);
      if (at === -1) return '';
      const out = [];
      for (let i = at + 1; i < body.length; i++) {
        if (stop.test(body[i])) break;
        if (body[i]) out.push(body[i]);
      }
      return out.join(' ').slice(0, 400);
    };
    const values = block('Values', /^(Default|Getvar|Do|Example|Setvar)\b/);
    const fallback = block('Default', /^(Getvar|Do|Example|Setvar|Values)\b|^!/);
    for (const name of expandName(head.name)) {
      records.push({
        name,
        heading: head.name,
        description: description.slice(0, 500),
        setvar: has('Setvar'),
        getvar: has('Getvar'),
        do: has('Do'),
        values,
        default: fallback,
      });
    }
  });
  return records;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] || 'reference/zpl-zbi2-pg-en.txt';
  process.stdout.write(JSON.stringify(extract(readFileSync(path, 'utf8')), null, 1) + '\n');
}
