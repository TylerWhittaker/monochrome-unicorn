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
 * formats.js -- what the printer's label languages have in common.
 *
 * A Zebra printer is not a ZPL printer. Depending on the model it parses
 * ZPL, EPL, CPCL, and on some models a downloadable emulation of someone
 * else's language. All three of the native ones can store a format and
 * fill it in later; they just disagree about how, so this module holds
 * one description per language and the rest of the app asks it rather
 * than assuming carets and tildes.
 *
 * What differs per language, measured on a ZD500R (firmware V74.20.23Z):
 *
 *                      ZPL          EPL            CPCL
 *   listed by /dir     yes          yes            as type "---"
 *   true extension     /dir         /dir           file.drive_listing
 *   contents readable  yes (/zpl)   no             no
 *   preview renders    yes          no             no
 *
 * Only ZPL can be read back over HTTP, so only ZPL's fields can be
 * discovered automatically. For the others the caller supplies the field
 * list -- either by hand or by pasting the source, which parseFields
 * will happily take.
 */

import { escapeFieldData, findFieldNumbers, buildFormatCall } from './zpl.js';

/* ------------------------------------------------------------------ *
 * Language descriptions
 * ------------------------------------------------------------------ */

export const LANGUAGES = {
  zpl: {
    id: 'zpl',
    label: 'ZPL',
    otypes: ['ZPL'],
    /** Named fields, so order does not matter. */
    positional: false,
    fieldNoun: 'field',
    /** The printer's own preview only runs the ZPL engine. */
    previewable: true,
    /** Which device.languages values mean this language will parse. */
    supportedBy: ['zpl', 'hybrid_xml_zpl', 'epl_zpl'],
    help: 'Fields are ^FN placeholders. The console reads the stored format and finds them for you.',
  },
  epl: {
    id: 'epl',
    label: 'EPL',
    otypes: ['EPL'],
    positional: true,
    fieldNoun: 'variable',
    previewable: false,
    supportedBy: ['epl', 'epl_zpl'],
    help: 'Fields are V00-V99 variables, filled in order after a "?" line.',
  },
  cpcl: {
    id: 'cpcl',
    label: 'CPCL',
    otypes: ['FMT', 'LBL'],
    positional: true,
    fieldNoun: 'placeholder',
    previewable: false,
    supportedBy: ['cpcl', 'line_print'],
    help: 'Fields are \\\\ placeholders, filled in order after the ! UF line.',
  },
};

/** Every object type that might be a stored format. */
export const FORMAT_OTYPES = Object.values(LANGUAGES).flatMap((l) => l.otypes);

/** Which language a stored object is written in, by extension. */
export function languageOf(otype) {
  const upper = String(otype || '').toUpperCase();
  for (const lang of Object.values(LANGUAGES)) {
    if (lang.otypes.includes(upper)) return lang;
  }
  return null;
}

/**
 * Whether the printer, as currently configured, will parse this
 * language. device.languages is a single mode, not a list, so a CPCL
 * format on a ZPL printer is worth warning about before it silently
 * prints nothing.
 */
export function printerSpeaks(lang, deviceLanguages) {
  if (!lang || !deviceLanguages) return true;
  return lang.supportedBy.includes(String(deviceLanguages).trim().toLowerCase());
}

/* ------------------------------------------------------------------ *
 * Finding the fields in a format
 * ------------------------------------------------------------------ */

/**
 * Fields in a stored format, given its source.
 *
 * Returns [{key, label, initial}]. `key` is what buildRecall needs: a
 * number for ZPL's ^FN, an index for the positional languages.
 */
export function parseFields(lang, source) {
  if (!lang || !source) return [];
  if (lang.id === 'zpl') {
    // A field the stored format gives data (^FN1^FDtext) is fixed: the
    // printer prints that and ignores whatever a recall sends for it --
    // measured on a ZD500R and a ZD620, and what the guide's ^FN entry
    // says. So it is shown, not offered for filling in.
    return findFieldNumbers(source).map((f) => ({
      key: f.number,
      name: f.name || '',
      label: f.name ? `${f.name}  (^FN${f.number})` : `Field ${f.number}`,
      initial: f.initial || '',
      fixed: Boolean(f.initial),
    }));
  }
  if (lang.id === 'epl') return parseEplVariables(source);
  if (lang.id === 'cpcl') return parseCpclPlaceholders(source);
  return [];
}

/**
 * EPL declares its variables up front, and each one carries the prompt
 * the printer would have shown on a keyboard unit -- which makes a much
 * better field label than "Field 3".
 */
export function parseEplVariables(source) {
  const fields = [];
  const re = /^\s*V(\d{1,2})\s*,\s*(\d+)\s*,\s*([LRCN])\s*,\s*"([^"]*)"/gim;
  let match;
  while ((match = re.exec(source)) !== null) {
    const number = parseInt(match[1], 10);
    // A leading minus is a keyboard-unit flag, not part of the prompt.
    const prompt = match[4].replace(/^-/, '').trim();
    fields.push({
      key: number,
      label: prompt
        ? `${prompt}  (V${String(number).padStart(2, '0')})`
        : `V${String(number).padStart(2, '0')}`,
      initial: '',
      maxLength: parseInt(match[2], 10) || undefined,
    });
  }
  return fields.sort((a, b) => a.key - b.key);
}

/**
 * CPCL marks each variable spot with a doubled backslash. They have no
 * names, only an order, so label each with the command it sits in --
 * "TEXT 4 0 30 40" tells you far more than "Field 2".
 */
export function parseCpclPlaceholders(source) {
  const fields = [];
  const lines = String(source).split(/\r?\n/);
  for (const line of lines) {
    const count = (line.match(/\\\\/g) || []).length;
    if (!count) continue;
    const context = line.replace(/\\\\/g, '').trim().replace(/\s+/g, ' ').slice(0, 40);
    for (let i = 0; i < count; i++) {
      fields.push({
        key: fields.length,
        label: context ? `${fields.length + 1}. ${context}` : `Field ${fields.length + 1}`,
        initial: '',
      });
    }
  }
  return fields;
}

/** Placeholder fields for a format whose source we could not read. */
export function blankFields(lang, count) {
  const fields = [];
  for (let i = 0; i < count; i++) {
    const label =
      lang.id === 'epl' ? `V${String(i).padStart(2, '0')}` : `${lang.fieldNoun} ${i + 1}`;
    fields.push({ key: lang.id === 'epl' ? i : i, label, initial: '' });
  }
  return fields;
}

/* ------------------------------------------------------------------ *
 * Recalling a format with data
 * ------------------------------------------------------------------ */

/**
 * The command stream that recalls `file` and fills it in.
 *
 * `values` is a Map keyed the same way parseFields keyed its fields.
 * CPCL and EPL are line-oriented and want CRLF; the caller sends this
 * verbatim.
 */
export function buildRecall(lang, file, fields, values, { copies = 1 } = {}) {
  const valueFor = (field) => String(values.get(field.key) ?? '');

  if (lang.id === 'zpl') {
    // Data sent for a fixed field would print on its own at the label's
    // corner, in the default font, so it is not sent.
    const pairs = fields.filter((f) => !f.fixed).map((f) => [f.key, valueFor(f)]);
    let zpl = buildFormatCall(file.dev, `${file.oname}.${file.otype}`, pairs);
    if (copies > 1) zpl = zpl.replace('^XZ', `^PQ${copies}\n^XZ`);
    return zpl;
  }

  if (lang.id === 'epl') {
    // FR recalls, "?" says the following lines are variable data, and
    // P prints. EPL is strictly line-oriented.
    const lines = [`FR"${file.oname}"`, '?'];
    for (const f of fields) lines.push(valueFor(f));
    lines.push(`P${Math.max(1, copies)}`);
    return lines.join('\r\n') + '\r\n';
  }

  if (lang.id === 'cpcl') {
    // ! UF names the format; each following line replaces one \\ in it.
    const lines = [`! UF ${file.oname}.${file.otype}`];
    for (const f of fields) lines.push(valueFor(f));
    let out = lines.join('\r\n') + '\r\n';
    // CPCL repeats by re-sending; the count lives in the stored header,
    // so copies are honoured by sending the recall again.
    if (copies > 1) out = out.repeat(copies);
    return out;
  }

  throw new Error(`No recall syntax for ${lang.id}`);
}

/** Escaping only matters where the language has metacharacters. */
export function escapeValue(lang, value) {
  return lang.id === 'zpl' ? escapeFieldData(value) : String(value);
}

/** ^PQ takes far more, but past this a typo is likelier than intent. */
export const MAX_COPIES = 999;

/**
 * The copy count from what was typed: a whole number, held to 1 to
 * MAX_COPIES. Anything else -- blank, a fraction, "2e1", a negative --
 * is not guessed at: the count stays what it was.
 */
export function parseCopies(text, previous = 1) {
  const trimmed = String(text).trim();
  if (!/^\d+$/.test(trimmed)) return previous;
  return Math.min(MAX_COPIES, Math.max(1, parseInt(trimmed, 10)));
}

/* ------------------------------------------------------------------ *
 * Batches from CSV
 * ------------------------------------------------------------------ */

/**
 * Parse CSV text -- or semicolon- or tab-separated, whichever the first
 * line uses most -- into { headers, rows }. Quoted fields may hold the
 * separator, line breaks and doubled quotes. Blank lines are skipped.
 */
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t'].reduce((best, c) =>
    firstLine.split(c).length > firstLine.split(best).length ? c : best,
  );
  const records = [];
  let record = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === sep) {
      record.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || record.length) {
    record.push(cell);
    records.push(record);
  }
  const filled = records.filter((r) => r.some((c) => c.trim() !== ''));
  const [headers = [], ...rows] = filled;
  return { headers: headers.map((h) => h.trim()), rows };
}

/**
 * Which CSV column fills each field: { fieldKey: columnIndex }, -1 for
 * none. A header matches a field by its ^FN name, or as "FN1", "Field 1"
 * or plain "1"; failing any match at all, columns are taken in order.
 */
export function matchColumns(headers, fields) {
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const keys = headers.map(norm);
  const mapping = {};
  let named = 0;
  for (const field of fields) {
    if (field.fixed) {
      mapping[field.key] = -1;
      continue;
    }
    const wanted = [field.name, `fn${field.key}`, `field${field.key}`, String(field.key)]
      .filter(Boolean)
      .map(norm);
    const at = keys.findIndex((k) => k !== '' && wanted.includes(k));
    mapping[field.key] = at;
    if (at !== -1) named++;
  }
  if (!named) {
    fields
      .filter((f) => !f.fixed)
      .forEach((f, i) => (mapping[f.key] = i < headers.length ? i : -1));
  }
  return mapping;
}

/** One CSV row as the values Map buildRecall takes. */
export function rowValues(row, fields, mapping) {
  return new Map(
    fields.map((f) => [f.key, mapping[f.key] >= 0 ? (row[mapping[f.key]] ?? '') : '']),
  );
}

/**
 * What a batch would leave blank, field by field: { key, label, unmapped,
 * rows } for each field the format does not fix that has no column
 * (unmapped) or is empty in some rows (their indexes).
 */
export function batchGaps(rows, fields, mapping) {
  const gaps = [];
  for (const field of fields) {
    if (field.fixed) continue;
    const column = mapping[field.key];
    if (!(column >= 0)) {
      gaps.push({ key: field.key, label: field.label, unmapped: true, rows: [] });
      continue;
    }
    const empty = [];
    rows.forEach((row, i) => {
      if (!String(row[column] ?? '').trim()) empty.push(i);
    });
    if (empty.length)
      gaps.push({ key: field.key, label: field.label, unmapped: false, rows: empty });
  }
  return gaps;
}
