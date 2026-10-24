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
 * discover.mjs -- find the Zebra printers on the network.
 *
 * Two ways. discoverPrinters() broadcasts Zebra's discovery packet to
 * UDP port 4201 on every network this computer is on, and every Zebra
 * print server that hears it answers with what it is. scanRange() asks
 * each address of a range the same question directly, which reaches
 * past a router where a broadcast does not; and an address that does
 * not answer it (a printer can have discovery turned off,
 * ip.discovery.enable) gets a GET of its home page, which says Zebra
 * on a Zebra.
 *
 * Nothing is ever sent to port 9100 of an address not yet known to be a
 * Zebra: another make of network printer prints whatever arrives there.
 *
 * The reply's layout, as both bench printers send it (docs/printer-notes.md):
 *
 *     0   ":,." and the packet's version (3)
 *     4   product number, 8 bytes         "V84"
 *    12   product name, 20 bytes          "ZTC ZD620-300dpi ZPL" (cut short)
 *    32   date code, 7 bytes
 *    39   firmware, 10 bytes              "V84.20.23Z"
 *    49   company, 5 bytes                "ZBR"
 *    54   MAC address, 6 bytes
 *    60   print server serial, 10 bytes
 *    72   IP address, netmask, gateway, 4 bytes each
 *    84   system name, 25 bytes           "ZEBRA-ZD620"
 *
 * Text fields end at their first NUL. An older version of the packet may
 * put things elsewhere, so a field that is not printable text is left
 * empty, and the address is the one the reply came from, never the one
 * written in it.
 */

import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { identifyPrinter } from './fetch-schema.mjs';

/** The port Zebra print servers listen for discovery on. */
export const DISCOVERY_PORT = 4201;

/** The question: "who is there?", as Zebra's own tools ask it. */
export const DISCOVERY_REQUEST = Buffer.from([0x2e, 0x2c, 0x3a, 0x01, 0x00, 0x00]);

/** The most addresses one scan takes: a /20. */
export const MAX_RANGE = 4096;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** An IPv4 address as a number, or null when it is not one. */
export function ipToNumber(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text).trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function numberToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Sort printers by address: numerically, host names after. */
export function byAddress(a, b) {
  const x = ipToNumber(a.ip);
  const y = ipToNumber(b.ip);
  if (x !== null && y !== null) return x - y;
  if (x !== null || y !== null) return x === null ? 1 : -1;
  return a.ip.localeCompare(b.ip);
}

/** True for text that names more than one address, rather than one printer. */
export function isRange(text) {
  const t = String(text).trim();
  return /^[\d.,/\s-]+$/.test(t) && /[,/-]/.test(t);
}

/** One of the four numbers of a range: 7, 10-50, or a list of those, 1,5,10-20. */
function parseOctet(text, which) {
  const values = [];
  for (const piece of text.split(',')) {
    const m = /^\s*(\d{1,3})\s*(?:-\s*(\d{1,3})\s*)?$/.exec(piece);
    const from = m && Number(m[1]);
    const to = m && (m[2] === undefined ? from : Number(m[2]));
    if (!m || from > 255 || to > 255) {
      throw new Error(
        `"${piece.trim()}" in the ${which} number is not a number from 0 to 255, or a range of them such as 10-50`,
      );
    }
    if (to < from) throw new Error(`${piece.trim()} runs backwards: write it ${to}-${from}`);
    for (let v = from; v <= to; v++) if (!values.includes(v)) values.push(v);
  }
  return values;
}

const ORDINAL = ['first', 'second', 'third', 'fourth'];

/**
 * Every address a range names, in order. A range is written
 *
 *   192.168.1.0/24  or  192.168.1.0/255.255.255.0   a network: every host
 *                                                    in it, without its
 *                                                    network and broadcast
 *                                                    addresses
 *   192.168.1.10-50                                 a range in any of the
 *   192.168.1-2.1-254                               four numbers, or a
 *   192.168.1.5,7,10-20                             list of them
 *   192.168.1.10-192.168.1.50                       first to last
 *
 * Throws, saying what is wrong, for anything else or for more than
 * MAX_RANGE addresses.
 */
export function parseRange(text) {
  const t = String(text).trim();
  let first, last;
  let list = null;
  const slash = /^([^/]+)\/\s*(.+)$/.exec(t);
  const span = /^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (slash) {
    const base = ipToNumber(slash[1]);
    if (base === null) throw new Error(`${slash[1].trim()} is not an address`);
    let bits;
    if (/^\d{1,2}$/.test(slash[2])) {
      bits = Number(slash[2]);
      if (bits > 32) throw new Error(`/${bits}: a network is /0 to /32`);
    } else {
      const mask = ipToNumber(slash[2]);
      const hosts = mask === null ? 1 : (~mask >>> 0) + 1;
      // A netmask is ones then zeros, so what it leaves out is a power of two.
      if (mask === null || !Number.isInteger(Math.log2(hosts))) {
        throw new Error(`${slash[2]} is not a netmask such as 255.255.255.0`);
      }
      bits = 32 - Math.log2(hosts);
    }
    const size = 2 ** (32 - bits);
    if (size > MAX_RANGE + 2) throw tooMany(size);
    const network = Math.floor(base / size) * size;
    first = network;
    last = network + size - 1;
    if (bits <= 30) {
      first++;
      last--;
    }
  } else if (span) {
    first = ipToNumber(span[1]);
    last = ipToNumber(span[2]);
    if (first === null || last === null) throw new Error(`${t} is not a range of addresses`);
    if (last < first) throw new Error(`${t} runs backwards`);
  } else {
    const parts = t.split('.');
    if (parts.length !== 4) {
      throw new Error(
        'A range is four numbers separated by dots, each a number or a range such as 10-50 (192.168.1.10-50), or a network such as 192.168.1.0/24',
      );
    }
    const octets = parts.map((p, i) => parseOctet(p, ORDINAL[i]));
    const size = octets.reduce((n, o) => n * o.length, 1);
    if (size > MAX_RANGE) throw tooMany(size);
    list = [];
    for (const a of octets[0])
      for (const b of octets[1])
        for (const c of octets[2]) for (const d of octets[3]) list.push(`${a}.${b}.${c}.${d}`);
    return list;
  }
  if (last - first + 1 > MAX_RANGE) throw tooMany(last - first + 1);
  list = [];
  for (let n = first; n <= last; n++) list.push(numberToIp(n));
  return list;
}

function tooMany(size) {
  return new Error(
    `That is ${size} addresses; at most ${MAX_RANGE} can be scanned at once (a /20). Scan it in parts.`,
  );
}

/** A text field of the reply: up to its first NUL, and only if it is printable. */
function field(buf, offset, length) {
  const bytes = buf.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  const text = bytes.subarray(0, end === -1 ? bytes.length : end).toString('latin1');
  return /^[\x20-\x7e]*$/.test(text) ? text.trim() : '';
}

/**
 * What a discovery reply says, or null when it is not one. `from` is
 * the address it came from, which is the printer's address.
 */
export function parseDiscoveryReply(buf, from) {
  if (buf.length < 4 || buf[0] !== 0x3a || buf[1] !== 0x2c || buf[2] !== 0x2e) return null;
  const product = field(buf, 12, 20);
  const mac =
    buf.length >= 60
      ? [...buf.subarray(54, 60)].map((b) => b.toString(16).padStart(2, '0')).join(':')
      : '';
  return {
    ip: from,
    // "ZTC ZD620-300dpi ZPL", cut at 20 bytes: the model is the part before the dpi.
    model: product.replace(/^ZTC\s+/, '').replace(/-\d+dpi.*$/, ''),
    product,
    firmware: field(buf, 39, 10),
    name: field(buf, 84, 25),
    mac: mac === '00:00:00:00:00:00' ? '' : mac,
    via: 'discovery',
  };
}

/**
 * Where a broadcast goes: everywhere this computer's own network
 * reaches (255.255.255.255), and each of its networks' own broadcast
 * address, which some systems need to send on more than one.
 */
export function broadcastTargets(interfaces = networkInterfaces()) {
  const targets = ['255.255.255.255'];
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = ipToNumber(a.address);
      const mask = ipToNumber(a.netmask);
      if (ip === null || mask === null || mask === 0xffffffff) continue;
      const broadcast = numberToIp((ip | ~mask) >>> 0);
      if (!targets.includes(broadcast)) targets.push(broadcast);
    }
  }
  return targets;
}

/**
 * Send the discovery packet to each of `targets` and collect the
 * replies for `waitMs` after the last went: one printer per address,
 * however many times it answered. Sends go out `batch` at a time,
 * `gapMs` apart, so a scan does not drop its own packets.
 */
function ask(
  targets,
  { port, waitMs, broadcast = false, batch = 64, gapMs = 20, onSent, onReply },
) {
  return new Promise((resolveAsk, rejectAsk) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map();
    socket.on('error', (err) => {
      socket.close();
      rejectAsk(err);
    });
    socket.on('message', (msg, rinfo) => {
      if (found.has(rinfo.address)) return;
      const printer = parseDiscoveryReply(msg, rinfo.address);
      if (!printer) return;
      found.set(rinfo.address, printer);
      onReply?.(printer);
    });
    socket.bind(0, async () => {
      try {
        if (broadcast) socket.setBroadcast(true);
        for (let i = 0; i < targets.length; i += batch) {
          for (const target of targets.slice(i, i + batch)) {
            // An unreachable network is an answer of no, not a failure.
            socket.send(DISCOVERY_REQUEST, port, target, () => {});
          }
          onSent?.(Math.min(i + batch, targets.length));
          if (i + batch < targets.length) await sleep(gapMs);
        }
      } catch (err) {
        socket.close();
        rejectAsk(err);
        return;
      }
      setTimeout(() => {
        socket.close();
        resolveAsk([...found.values()]);
      }, waitMs);
    });
  });
}

/**
 * The printers that answer a broadcast, sorted by address. The question
 * goes out twice, half a second apart, as a broadcast can be dropped.
 *
 *   targets  where to send it (broadcastTargets())
 *   waitMs   how long to listen after the last
 *   port     DISCOVERY_PORT; another for the tests
 */
export async function discoverPrinters({
  targets = broadcastTargets(),
  waitMs = 3000,
  port = DISCOVERY_PORT,
} = {}) {
  const twice = [...targets, ...targets];
  const found = await ask(twice, {
    port,
    waitMs,
    broadcast: true,
    batch: targets.length,
    gapMs: 500,
  });
  return found.sort(byAddress);
}

/** A GET of an address's home page that says Zebra: a printer with discovery off. */
async function looksLikeZebra(ip, { port, timeoutMs }) {
  try {
    const res = await fetch(`http://${ip}${port === 80 ? '' : `:${port}`}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const text = (await res.text()).slice(0, 65536);
    return /zebra/i.test(`${res.headers.get('server') || ''} ${text}`);
  } catch {
    return false;
  }
}

/**
 * The Zebra printers among `addresses`, sorted: first by asking each
 * the discovery question, then a GET of the home page of each that did
 * not answer it. A printer found by its page is then asked ~HI, which
 * it now safely can be, for its model and firmware.
 *
 *   onProgress  ({ phase: 'discovery' | 'web', done, total })
 *   onPrinter   (printer), as each is found
 *
 * The ports and waits are for the tests.
 */
export async function scanRange(
  addresses,
  {
    onProgress = () => {},
    onPrinter = () => {},
    port = DISCOVERY_PORT,
    waitMs = 2000,
    httpPort = 80,
    httpTimeoutMs = 2500,
    rawPort = 9100,
    concurrency = 64,
  } = {},
) {
  const total = addresses.length;
  const found = await ask(addresses, {
    port,
    waitMs,
    onSent: (done) => onProgress({ phase: 'discovery', done, total }),
    onReply: onPrinter,
  });
  const known = new Set(found.map((p) => p.ip));
  const rest = addresses.filter((ip) => !known.has(ip));

  let next = 0;
  let done = 0;
  onProgress({ phase: 'web', done, total: rest.length });
  const worker = async () => {
    while (next < rest.length) {
      const ip = rest[next++];
      if (await looksLikeZebra(ip, { port: httpPort, timeoutMs: httpTimeoutMs })) {
        const hi = await identifyPrinter(ip, {
          port: rawPort,
          firstMs: 3000,
          timeout: 6000,
        }).catch(() => null);
        const printer = {
          ip,
          model: (hi?.model || '').replace(/-\d+dpi.*$/, ''),
          product: '',
          firmware: hi?.version || '',
          name: '',
          mac: '',
          via: 'web',
        };
        found.push(printer);
        onPrinter(printer);
      }
      onProgress({ phase: 'web', done: ++done, total: rest.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rest.length) }, worker));
  return found.sort(byAddress);
}
