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
 * zplhelp.js -- what the ZPL command under the cursor does.
 *
 * The source view's companion to the Object options panel: the command
 * the cursor is in, from the reference in src/data/zpl-reference.mjs
 * (served as ZPLREF.SHTML and read on first use), with each parameter's
 * meaning beside the value the label actually gives it, and the one the
 * cursor is in picked out.
 *
 * Matching values to parameters follows the command's Format line in
 * the reference, which says how its arguments are laid out: mostly one
 * to a comma, but ^A glues the font and rotation together (^A0N,30,30),
 * and a stored object is one argument of three parts (E:LOGO.GRF).
 */

import { el, replaceChildren } from './ui.js';
import { tokenizeZpl } from './zpl.js';

/** The reference's name for a token: "^FO", "~DG", "^A", "^A@". */
export function commandKey(token) {
  if (token.cmd === 'A') return token.args[0] === '@' ? '^A@' : '^A';
  return token.prefix + token.cmd;
}

/** Where a token's arguments start, and their text. */
function argumentsOf(token) {
  if (token.cmd === 'A') {
    const skip = token.args[0] === '@' ? 1 : 0;
    return { start: token.start + 2 + skip, text: token.args.slice(skip) };
  }
  return { start: token.start + 3, text: token.args };
}

/**
 * The command the cursor is in. A cursor just after a command's last
 * character -- where it sits when you have finished typing it -- still
 * counts. Returns { key, token, argIndex } (argIndex -1 on the command's
 * own name), or null where there is no command.
 */
export function commandAt(source, offset) {
  const tokens = tokenizeZpl(source);
  const token =
    tokens.find((t) => offset >= t.start && offset < t.end) ||
    [...tokens].reverse().find((t) => offset === t.end);
  if (!token) return null;
  const args = argumentsOf(token);
  // Trailing line breaks belong to no argument.
  const typed = source.slice(args.start, Math.max(args.start, offset));
  const argIndex = offset < args.start ? -1 : typed.split(',').length - 1;
  return { key: commandKey(token), token, argIndex };
}

/** An entry, following an alias (~CC is described under ^CC). */
export function lookup(reference, key) {
  if (!reference) return null;
  const other = key[0] === '^' ? `~${key.slice(1)}` : `^${key.slice(1)}`;
  const entry = reference[key] || reference[other] || null;
  return entry && entry.alias ? reference[entry.alias] || null : entry;
}

/**
 * The parameters each argument slot holds, read from the Format line:
 * "^XGd:o.x,mx,my" gives d, o and x in the first slot (a path), then mx
 * and my; "^Afo,h,w" gives f and o glued together, then h, then w.
 * Returns [{ names, path }].
 */
export function argumentSlots(entry, key) {
  const names = entry.params.map((p) => p[0]);
  const format = entry.format.split(/ or | ; /)[0].trim();
  const rest = format.startsWith(key)
    ? format.slice(key.length)
    : format.replace(/^[\^~][A-Z0-9@]{1,2}/, '');
  if (!rest) return [];
  return rest.split(',').map((slot) => {
    // "<ext>" in ^FL's Format line is the parameter ext.
    const name = slot.trim().replace(/^<(.*)>$/, '$1');
    if (names.includes(name)) return { names: [name], path: false };
    if (/[:.]/.test(name)) {
      return { names: name.split(/[:.]/).filter((n) => names.includes(n)), path: true };
    }
    if (name && [...name].every((c) => names.includes(c))) return { names: [...name], path: false };
    // A slot the parameters do not name: ^CI's "s2", or a "...".
    return { names: [], path: false, label: /\w/.test(name) ? name : null };
  });
}

/** One argument's value split over the parameters its slot holds. */
function splitSlot(value, slot) {
  if (slot.names.length <= 1) return [value];
  // A stored object, "E:LOGO.GRF": drive, name, extension, any missing.
  if (slot.path) {
    const m = /^(?:([A-Z]):)?([^.]*)(?:\.(.*))?$/i.exec(value) || [];
    return [m[1] || '', m[2] || '', m[3] || ''].slice(0, slot.names.length);
  }
  // Glued single characters, as in ^A's font and rotation.
  return slot.names.map((_, i) => value[i] || '');
}

/**
 * Each parameter beside its value in the label, and whether the cursor
 * is in it: [{ param, value, active }]. Arguments beyond the ones the
 * Format line names (^CI's remapping pairs, say) are listed after.
 */
export function describeArguments(entry, at) {
  const { token } = at;
  const params = new Map(entry.params.map((p) => [p[0], p]));
  const text = argumentsOf(token).text.replace(/[\r\n]+$/, '');

  // ^FN1"NAME": a number and a quoted prompt, with no comma between.
  if (at.key === '^FN') {
    const m = /^\s*(\d*)\s*(?:"([^"]*)")?/.exec(text) || [];
    return entry.params.map((p, i) => ({
      param: p,
      value: (i === 0 ? m[1] : m[2]) || '',
      active: at.argIndex >= 0,
    }));
  }

  const slots = argumentSlots(entry, at.key);
  const values = text === '' ? [] : text.split(',');
  const rows = [];
  const named = new Set();
  slots.forEach((slot, i) => {
    if (!slot.names.length) {
      if (values[i] !== undefined) {
        rows.push({
          param: [slot.label || `#${i + 1}`, 'More', '', '', ''],
          value: values[i],
          active: at.argIndex === i,
        });
      }
      return;
    }
    const parts = splitSlot(values[i] ?? '', slot);
    slot.names.forEach((name, k) => {
      named.add(name);
      rows.push({ param: params.get(name), value: parts[k] ?? '', active: at.argIndex === i });
    });
  });
  // Parameters the Format line could not place, so nothing is lost.
  for (const p of entry.params) {
    if (!named.has(p[0])) rows.push({ param: p, value: '', active: false });
  }
  for (let i = slots.length; i < values.length; i++) {
    rows.push({
      param: [`#${i + 1}`, 'More', '', '', ''],
      value: values[i],
      active: at.argIndex === i,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

function helpNote(text) {
  return el('p', { class: 'px-3 py-4 text-[12px] text-ink-400' }, [text]);
}

/**
 * Draw the panel for the cursor in `source`. `state` says how far the
 * reference has got: { reference, loading, error }.
 */
export function renderZplHelp(host, { source, offset, reference, loading, error }) {
  if (error) {
    replaceChildren(host, [
      helpNote(`The ZPL reference could not be read from the printer: ${error}`),
    ]);
    return;
  }
  const at = source != null && offset != null ? commandAt(source, offset) : null;
  if (!at) {
    replaceChildren(host, [
      helpNote(
        'Put the cursor in a command to see what it does, and what each of its parameters means.',
      ),
    ]);
    return;
  }
  if (!reference) {
    replaceChildren(host, [helpNote(loading ? 'Reading the ZPL reference from the printer…' : '')]);
    return;
  }

  const entry = lookup(reference, at.key);
  if (!entry) {
    replaceChildren(host, [
      el('div', { class: 'space-y-1 px-3 py-3' }, [
        el('code', { class: 'text-[13px] font-semibold text-ink-900' }, [at.key]),
        el('p', { class: 'text-[12px] text-ink-500' }, [
          'Not a command the ZPL II programming guide describes. Check the spelling -- or the ' +
            'printer may treat it as data.',
        ]),
      ]),
    ]);
    return;
  }

  const rows = describeArguments(entry, at);
  replaceChildren(host, [
    el('div', { class: 'space-y-2 border-b border-ink-200 px-3 py-3' }, [
      el('div', { class: 'flex items-baseline gap-2' }, [
        el('code', { class: 'text-[14px] font-semibold text-ink-900' }, [at.key]),
        el('span', { class: 'text-[12px] font-medium text-ink-700' }, [entry.name]),
      ]),
      el('p', { class: 'text-[12px] leading-snug text-ink-600' }, [entry.does]),
      el('p', { class: 'text-[11px] text-ink-500' }, [
        'Format ',
        el('code', { class: 'rounded bg-ink-100 px-1 py-0.5 text-ink-800' }, [entry.format]),
      ]),
    ]),
    rows.length
      ? el(
          'div',
          { class: 'divide-y divide-ink-100' },
          rows.map(({ param, value, active }) => {
            const [letter, name, about, values, fallback] = param;
            return el(
              'div',
              {
                class:
                  'space-y-0.5 px-3 py-2' +
                  (active
                    ? ' border-l-2 border-sky-500 bg-sky-50/70'
                    : ' border-l-2 border-transparent'),
                dataset: { param: letter },
              },
              [
                el('div', { class: 'flex items-baseline gap-2' }, [
                  el('code', { class: 'min-w-[1.25rem] text-[12px] font-semibold text-ink-800' }, [
                    letter,
                  ]),
                  el('span', { class: 'text-[12px] font-medium text-ink-700' }, [name]),
                  el(
                    'code',
                    {
                      class:
                        'ml-auto max-w-[50%] truncate rounded px-1 text-[11px] ' +
                        (value !== '' ? 'bg-ink-100 text-ink-900' : 'text-ink-400'),
                      title: value !== '' ? value : 'not given: the default applies',
                    },
                    [value !== '' ? value : fallback ? `default ${fallback}` : '—'],
                  ),
                ]),
                about ? el('p', { class: 'text-[11px] leading-snug text-ink-600' }, [about]) : null,
                values
                  ? el('p', { class: 'text-[11px] leading-snug text-ink-400' }, [
                      `Values: ${values}` + (fallback ? `. Default: ${fallback}.` : ''),
                    ])
                  : null,
              ],
            );
          }),
        )
      : helpNote('This command takes no parameters.'),
  ]);
}
