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

// Finding printers: the discovery reply, ranges, and a scan against fake
// printers on loopback addresses. Run: node test/discover.test.mjs

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import {
  parseDiscoveryReply,
  parseRange,
  isRange,
  broadcastTargets,
  discoverPrinters,
  scanRange,
  DISCOVERY_REQUEST,
  MAX_RANGE,
} from '../tools/discover.mjs';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

// The bench ZD500R's reply, as far as its system name; the rest of its
// 376 bytes is not read.
const ZD500R = Buffer.alloc(376);
Buffer.from(
  '3a2c2e0356373400000000005a5443205a44353030522d333030647069205a50373232323100005637342e32302e32335a5a42520000ac3fa406f4e0343535393034000000000100c0a80151ffffff00c0a801015a454252412d5a4435303052',
  'hex',
).copy(ZD500R);

await check('a discovery reply says the model, firmware, name and MAC', () => {
  assert.deepEqual(parseDiscoveryReply(ZD500R, '192.168.1.81'), {
    ip: '192.168.1.81',
    model: 'ZD500R',
    product: 'ZTC ZD500R-300dpi ZP',
    firmware: 'V74.20.23Z',
    name: 'ZEBRA-ZD500R',
    mac: 'ac:3f:a4:06:f4:e0',
    via: 'discovery',
  });
});

await check('anything else on the port is not a printer; a short or odd one is', () => {
  assert.equal(parseDiscoveryReply(Buffer.from('hello'), '1.2.3.4'), null);
  assert.equal(parseDiscoveryReply(DISCOVERY_REQUEST, '1.2.3.4'), null, 'our own question');
  const short = parseDiscoveryReply(Buffer.from([0x3a, 0x2c, 0x2e, 0x02]), '1.2.3.4');
  assert.equal(short.ip, '1.2.3.4');
  assert.equal(short.model, '');
  // A field of binary is left empty rather than shown as garbage.
  const odd = Buffer.from(ZD500R);
  odd.fill(0xc0, 39, 49);
  assert.equal(parseDiscoveryReply(odd, '1.2.3.4').firmware, '');
});

await check('a range is a network, a range in any of the numbers, a list, or first-last', () => {
  assert.equal(parseRange('192.168.1.0/24').length, 254);
  assert.deepEqual(parseRange('192.168.1.0/24').slice(0, 1), ['192.168.1.1']);
  assert.equal(parseRange('192.168.1.0/24').at(-1), '192.168.1.254');
  assert.deepEqual(parseRange('192.168.1.0/255.255.255.0'), parseRange('192.168.1.77/24'));
  assert.deepEqual(parseRange('10.0.0.5/32'), ['10.0.0.5']);
  assert.deepEqual(parseRange('10.0.0.5/31'), ['10.0.0.4', '10.0.0.5']);
  assert.deepEqual(parseRange('10.0.0.8/30'), ['10.0.0.9', '10.0.0.10']);
  assert.deepEqual(parseRange('10.0.0.1-3'), ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  assert.deepEqual(parseRange('10.0.1-2.5'), ['10.0.1.5', '10.0.2.5']);
  assert.deepEqual(parseRange('10.0.0.5,7,9-10'), [
    '10.0.0.5',
    '10.0.0.7',
    '10.0.0.9',
    '10.0.0.10',
  ]);
  assert.deepEqual(parseRange(' 10.0.0.254 - 10.0.1.1 '), [
    '10.0.0.254',
    '10.0.0.255',
    '10.0.1.0',
    '10.0.1.1',
  ]);
  assert.equal(parseRange('10.0.0-15.*'.replace('*', '0-255')).length, MAX_RANGE);
});

await check('a range that is wrong says what is wrong with it', () => {
  assert.throws(() => parseRange('10.0.0'), /four numbers separated by dots/);
  assert.throws(() => parseRange('10.0.0.300'), /"300" in the fourth number/);
  assert.throws(() => parseRange('10.0.0.50-10'), /runs backwards: write it 10-50/);
  assert.throws(() => parseRange('10.0.0.0/33'), /\/0 to \/32/);
  assert.throws(() => parseRange('10.0.0.0/255.0.255.0'), /not a netmask/);
  assert.throws(() => parseRange('10.0.0.0/16'), /65536 addresses; at most 4096/);
  assert.throws(() => parseRange('10.0-16.0-255.1'), /4352 addresses/);
});

await check('one address is not a range, and neither is a host name', () => {
  for (const one of ['192.168.1.81', 'zebra-1', 'printer.local', 'ZD620-300'])
    assert.ok(!isRange(one), one);
  for (const many of ['192.168.1.0/24', '192.168.1.10-50', '10.0.0.5,7'])
    assert.ok(isRange(many), many);
});

await check("a broadcast goes everywhere, and to each network's own broadcast address", () => {
  assert.deepEqual(
    broadcastTargets({
      lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
      eth0: [
        { family: 'IPv4', address: '192.168.1.50', netmask: '255.255.255.0', internal: false },
        { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
      ],
      wg0: [{ family: 'IPv4', address: '10.8.0.2', netmask: '255.255.255.255', internal: false }],
      docker0: [{ family: 4, address: '172.17.0.1', netmask: '255.255.0.0', internal: false }],
    }),
    ['255.255.255.255', '192.168.1.255', '172.17.255.255'],
  );
});

/** A fake print server: answers the discovery question at `host`, with a reply. */
async function fakeDiscovery(host, reply = ZD500R, port = 0) {
  const socket = dgram.createSocket('udp4');
  const asked = [];
  socket.on('message', (msg, rinfo) => {
    asked.push(msg);
    if (msg.equals(DISCOVERY_REQUEST)) socket.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, resolve);
  });
  return { port: socket.address().port, asked, close: () => socket.close() };
}

await check('discovery collects each printer once, however often it answers', async () => {
  const fake = await fakeDiscovery('127.0.0.1');
  try {
    const found = await discoverPrinters({
      targets: ['127.0.0.1'],
      port: fake.port,
      waitMs: 300,
    });
    assert.equal(fake.asked.length, 2, 'asked twice');
    assert.deepEqual(
      found.map((p) => [p.ip, p.model]),
      [['127.0.0.1', 'ZD500R']],
    );
  } finally {
    fake.close();
  }
});

/** Bind a loopback address other than 127.0.0.1, where the system has them (Linux). */
async function canBind(host) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    server.close();
  }
}

await check(
  'a scan finds a printer by discovery, and one with discovery off by its page',
  async () => {
    if (!(await canBind('127.0.0.3'))) {
      console.log('       (skipped: no loopback addresses besides 127.0.0.1 here)');
      return;
    }
    // 127.0.0.2 answers discovery. 127.0.0.3 does not, but its page says
    // Zebra and it answers ~HI on its raw port. 127.0.0.4 has a page that
    // does not, and 127.0.0.1 nothing at all.
    const udp = await fakeDiscovery('127.0.0.2');
    const page = (host, text, port = 0) => {
      const server = http.createServer((req, res) => res.end(text));
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
    };
    const zebra = await page('127.0.0.3', '<title>Zebra Technologies</title>');
    const httpPort = zebra.address().port;
    const other = await page('127.0.0.4', '<title>Some router</title>', httpPort);
    let hiAsked = 0;
    const raw = net.createServer((socket) =>
      socket.on('data', (d) => {
        if (d.toString().startsWith('~HI')) {
          hiAsked++;
          socket.end('\x02ZM400-200dpi,V53.17.11Z,8,8176KB\x03');
        }
      }),
    );
    await new Promise((resolve) => raw.listen(0, '127.0.0.3', resolve));
    const progress = [];
    const seen = [];
    try {
      const found = await scanRange(parseRange('127.0.0.1-4'), {
        port: udp.port,
        waitMs: 300,
        httpPort,
        httpTimeoutMs: 1000,
        rawPort: raw.address().port,
        onProgress: (p) => progress.push(p),
        onPrinter: (p) => seen.push(p.ip),
      });
      assert.deepEqual(
        found.map((p) => [p.ip, p.model, p.firmware, p.via]),
        [
          ['127.0.0.2', 'ZD500R', 'V74.20.23Z', 'discovery'],
          ['127.0.0.3', 'ZM400', 'V53.17.11Z', 'web'],
        ],
      );
      assert.deepEqual(seen.sort(), ['127.0.0.2', '127.0.0.3']);
      assert.equal(hiAsked, 1, 'only the address known to be a Zebra is asked ~HI');
      assert.deepEqual(progress.at(-1), { phase: 'web', done: 3, total: 3 });
      assert.ok(progress.some((p) => p.phase === 'discovery' && p.done === 4 && p.total === 4));
    } finally {
      udp.close();
      zebra.close();
      other.close();
      raw.close();
    }
  },
);

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
