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
 * zpl-manual-extract.mjs -- pull each ZPL command's section out of the
 * programming guide, as raw material for src/data/zpl-reference.json.
 *
 * The guide is Zebra's and is not redistributed here (reference/ is kept
 * out of git), so this does not produce the reference itself: it splits
 * the text `pdftotext -layout` makes of the PDF into one record per
 * command -- its title, Format line, and the parameter table split into
 * its two columns -- for someone to write the reference from. Run it
 * again against a newer guide to see what changed.
 *
 *   pdftotext -layout reference/zpl-zbi2-pg-en.pdf reference/zpl-zbi2-pg-en.txt
 *   node tools/zpl-manual-extract.mjs reference/zpl-zbi2-pg-en.txt > draft.json
 */

import { readFileSync } from 'node:fs';

/** A command's heading: "^FO", "^CC ~CC", "^HL or ~HL", "^WL - Set Leap". */
const HEADING = /^([\^~][A-Z0-9@]{1,2})(?:\s+(?:or\s+)?([\^~][A-Z0-9@]{1,2}))?(?:\s+-\s+.*)?\s*$/;

/** Running page furniture: a page number, or the chapter name. */
const FURNITURE = /^\s*(\d+|ZPL Commands|RFID Commands|Wireless Commands|ZBI Commands)\s*$/;

export function extract(text) {
  const lines = text.split('\n');
  // The command chapters run from "ZPL Commands" to the ZBI chapter.
  const start = lines.findIndex((l, i) => i > 1000 && /^ZPL Commands\s*$/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^ZBI Commands\s*$/.test(l));

  // The contents pages name every command, so a heading is only taken
  // for a name they list: code examples also start lines with "^XZ".
  const listed = new Set(
    lines
      .slice(0, start)
      .flatMap((l) => l.match(/^\s*[\^~][A-Z0-9@]{1,2}\b/g) || [])
      .map((n) => n.trim()),
  );
  for (const l of lines.slice(0, start)) {
    for (const n of l.match(/[\^~][A-Z0-9@]{1,2}(?=\.{3,}| or | - )/g) || []) listed.add(n);
    const pair = /^\s*([\^~][A-Z0-9@]{1,2}) ([\^~][A-Z0-9@]{1,2})\b/.exec(l);
    if (pair) listed.add(pair[2]);
  }

  const heads = [];
  for (let i = start; i < end; i++) {
    const m = HEADING.exec(lines[i]);
    // ...and stands apart from what is above it: an example's "^XZ"
    // closes a block of code.
    if (!m || !listed.has(m[1]) || lines[i - 1].trim()) continue;
    // A heading is followed, within a couple of lines, by indented prose.
    const next = lines.slice(i + 1, i + 4).find((l) => l.trim());
    if (next && /^\s{4,}[A-Z^~][a-z ]*\w/.test(next) && /[a-z]{3,}/.test(next)) {
      heads.push({ line: i, names: [m[1], m[2]].filter(Boolean) });
    }
  }

  return heads.map((head, k) => {
    const body = lines
      .slice(head.line + 1, k + 1 < heads.length ? heads[k + 1].line : end)
      .filter((l) => !FURNITURE.test(l));
    const formatAt = body.findIndex((l) => /^\s*Format:/.test(l));
    const title =
      formatAt > 0
        ? body
            .slice(0, formatAt)
            .filter((l) => l.trim())
            .at(-1)
            .trim()
        : '';
    const description = (formatAt > 0 ? body.slice(0, formatAt - 1) : body.slice(0, 6))
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l !== title)
      .join(' ');
    const formats = body
      .filter((l) => /^\s*Format:/.test(l))
      .map((l) => l.replace(/^\s*Format:\s*/, '').trim());

    // The table: from its header row to the first line that is not part
    // of it. Its two columns are split where the right one starts, which
    // is wherever "Values"/"Default" first appear.
    const tableAt = body.findIndex((l) => /Parameters\s+Details/.test(l));
    let params = [];
    if (tableAt !== -1) {
      const rows = [];
      for (let i = tableAt + 1; i < body.length; i++) {
        if (/^\s*(Comments?|Example|Note|Important)\b/i.test(body[i])) break;
        rows.push(body[i]);
      }
      const right = Math.min(
        ...rows.map((l) => l.search(/(Values?|Default|Accepted Values?)\s*:/)).filter((n) => n > 0),
      );
      let current = null;
      for (const row of rows) {
        if (!row.trim()) continue;
        const left = (Number.isFinite(right) ? row.slice(0, right) : row).trim();
        const detail = Number.isFinite(right) ? row.slice(right).trim() : '';
        const named = /^([a-z0-9]{1,3}|[A-Z])\s+=\s+(.*)$/.exec(left);
        if (named) {
          current = { name: named[1], label: named[2], details: [] };
          params.push(current);
        } else if (current && left) {
          current.label += ' ' + left;
        }
        if (current && detail) current.details.push(detail);
      }
    }

    const comments = body
      .slice(body.findIndex((l) => /^\s*Comments?:/.test(l)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      commands: head.names,
      title,
      description,
      formats,
      params,
      comments: body.some((l) => /^\s*Comments?:/.test(l)) ? comments.slice(0, 600) : '',
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] || 'reference/zpl-zbi2-pg-en.txt';
  process.stdout.write(JSON.stringify(extract(readFileSync(path, 'utf8')), null, 1) + '\n');
}
