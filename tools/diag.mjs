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
 * diag.mjs -- the diagnostic log a failed deploy leaves behind.
 *
 * A deploy that fails on a printer nobody here has is only fixable from
 * what that printer said. So while a deploy runs, every exchange with it
 * is recorded -- each port 9100 connection, what went out, every chunk
 * that came back and when, and how the read ended; each HTTP request --
 * alongside what the deploy printed. Nothing is written unless the
 * deploy fails; then formatTrace() makes it text, with the values of
 * settings that look like passwords or keys removed.
 *
 * One trace at a time: the installer runs one deploy at a time, and the
 * CLI one in all. trace() and traceConnection() do nothing outside one.
 */

let current = null;

/** Start recording; `header` is what formatTrace() puts at the top. */
export function startTrace(header = {}) {
  current = { started: Date.now(), header, entries: [] };
  return current;
}

/** Stop recording, and hand back what was recorded (null if nothing was). */
export function stopTrace() {
  const done = current;
  current = null;
  return done;
}

/** Record one event: { kind: 'log', text }, { kind: 'step', id }, { kind: 'http', ... }. */
export function trace(kind, fields = {}) {
  if (current) current.entries.push({ t: Date.now(), kind, ...fields });
}

const NO_CONNECTION = { connected() {}, data() {}, end() {} };

/**
 * Record one connection to the printer. `sent` is what went out, as text
 * (an upload passes only its header). Returns what the socket's handlers
 * call; the first end() is the one kept.
 */
export function traceConnection(target, sent) {
  if (!current) return NO_CONNECTION;
  const entry = {
    t: Date.now(),
    kind: 'tcp',
    target,
    sent,
    chunks: [],
    connected: null,
    how: null,
  };
  current.entries.push(entry);
  return {
    connected() {
      entry.connected = Date.now();
    },
    data(chunk) {
      entry.chunks.push({ t: Date.now(), bytes: Buffer.from(chunk) });
    },
    end(how) {
      if (entry.how) return;
      entry.how = how;
      entry.ended = Date.now();
    },
  };
}

/** Largest reply kept whole; a longer one keeps its head and tail. */
export const REPLY_LIMIT = 512 * 1024;

/** Cut the middle out of a text longer than `max`, saying how much went. */
export function capText(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return (
    text.slice(0, head) +
    `\n[... ${text.length - head - tail} characters cut ...]\n` +
    text.slice(text.length - tail)
  );
}

/**
 * Show bytes as text that survives being pasted anywhere: everything
 * outside printable ASCII as \r, \n, \t or \xNN, and a newline kept as
 * one too, after its \n -- so the lines read as lines, and whether the
 * last one had an ending is still there to see.
 */
export function escapeBytes(text) {
  return String(text).replace(/[^\x20-\x7e]/g, (c) => {
    if (c === '\n') return '\\n\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}

/** A setting whose value is not ours to send anywhere. */
export const SECRET_NAME =
  /pass|psk|key|secret|community|token|wep|kerberos|username|(?:^|[._])pin(?:$|[._])/i;

/**
 * Remove the values of secret-looking settings, in both shapes a reply
 * names them in: allcv's `name : value , Choices: ...`, and JSON's
 * `"name":"value"` or `"name":{"value":"..."`.
 */
export function redact(text) {
  return String(text)
    .replace(
      /^([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+) : (.*?)( , Choices: .*)?$/gm,
      (whole, name, value, choices = '') =>
        SECRET_NAME.test(name) && value ? `${name} : <redacted>${choices}` : whole,
    )
    .replace(
      /"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"(\s*:\s*(?:\{[^{}]*?"value"\s*:\s*)?)"((?:[^"\\]|\\.)*)"/g,
      (whole, name, between, value) =>
        SECRET_NAME.test(name) && value ? `"${name}"${between}"<redacted>"` : whole,
    );
}

const ms = (from, to) => `+${to - from} ms`;
const at = (trace, t) => `[+${((t - trace.started) / 1000).toFixed(3)}s]`;
const indent = (text, prefix) =>
  text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');

function formatTcp(trace, e) {
  const reply = Buffer.concat(e.chunks.map((c) => c.bytes)).toString('latin1');
  const base = e.connected || e.t;
  const lines = [`${at(trace, e.t)} tcp ${e.target}`];
  lines.push(`  sent (${e.sent.length} chars):`);
  lines.push(indent(escapeBytes(redact(e.sent)), '  > '));
  lines.push(`  connected: ${e.connected ? ms(e.t, e.connected) : 'never'}`);
  const shown = e.chunks.slice(0, 200).map((c) => `${ms(base, c.t)} ${c.bytes.length}`);
  if (e.chunks.length > 200) shown.push(`... ${e.chunks.length - 200} more`);
  lines.push(
    `  received ${reply.length} bytes in ${e.chunks.length} chunk${e.chunks.length === 1 ? '' : 's'}` +
      (shown.length ? `: ${shown.join(', ')}` : ''),
  );
  lines.push(`  ended: ${e.how || 'still open'}${e.ended ? `, ${ms(base, e.ended)}` : ''}`);
  if (reply) {
    lines.push('  reply:');
    lines.push(indent(escapeBytes(capText(redact(reply), REPLY_LIMIT)), '  | '));
  }
  return lines.join('\n');
}

function formatHttp(trace, e) {
  const lines = [`${at(trace, e.t)} http GET ${e.url}`];
  if (e.error) {
    lines.push(`  failed: ${e.error}`);
    return lines.join('\n');
  }
  lines.push(`  ${e.status}, ${e.bytes} bytes, ${e.elapsed} ms`);
  for (const [name, value] of e.headers || []) lines.push(`  ${name}: ${value}`);
  if (e.head) {
    lines.push(`  body (first ${e.head.length} bytes):`);
    lines.push(indent(escapeBytes(redact(e.head)), '  | '));
  }
  return lines.join('\n');
}

/** The causes of an error, then its stack, as Node would print them. */
function formatError(err) {
  const lines = [];
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (depth) lines.push('caused by:');
    lines.push(e.stack || String(e.message || e));
    if (e.code) lines.push(`code: ${e.code}`);
  }
  return lines.join('\n');
}

/**
 * The trace as the text a user sends: the header, then everything in
 * the order it happened -- the deploy's own output line by line, each
 * step, each exchange with the printer -- then the error.
 */
export function formatTrace(trace, { error = null, step = null } = {}) {
  const out = [
    'Monochrome Unicorn: diagnostic log of a failed deploy',
    '',
    'This holds what the printer said during the deploy: its model, serial number, IP address and settings listing, which can include network names. The values of settings that look like passwords or keys have been replaced with <redacted>.',
    '',
  ];
  for (const [key, value] of Object.entries(trace.header)) {
    out.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  out.push(`started: ${new Date(trace.started).toISOString()}`);
  out.push(`failed at step: ${step || '(before the first step)'}`);
  out.push('');

  let pending = '';
  let pendingAt = null;
  const flush = (all) => {
    const end = all ? pending.length : pending.lastIndexOf('\n') + 1;
    if (end === 0) return;
    for (const line of pending.slice(0, end).replace(/\n$/, '').split('\n')) {
      out.push(`${at(trace, pendingAt)} | ${line}`);
    }
    pending = pending.slice(end);
    pendingAt = pending ? pendingAt : null;
  };

  for (const e of trace.entries) {
    if (e.kind === 'log') {
      if (pendingAt === null) pendingAt = e.t;
      pending += e.text;
      flush(false);
      continue;
    }
    flush(true);
    if (e.kind === 'step') out.push(`${at(trace, e.t)} == step: ${e.id}`);
    else if (e.kind === 'tcp') out.push(formatTcp(trace, e));
    else if (e.kind === 'http') out.push(formatHttp(trace, e));
    else
      out.push(
        `${at(trace, e.t)} ${e.kind} ${JSON.stringify({ ...e, t: undefined, kind: undefined })}`,
      );
  }
  flush(true);

  if (error) {
    out.push('');
    out.push('error:');
    out.push(formatError(error));
  }
  return out.join('\n') + '\n';
}
