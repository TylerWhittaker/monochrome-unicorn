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
 * server.mjs -- the installer's window: a page served to this computer's
 * own browser.
 *
 * A native window would mean a GUI toolkit per platform; every computer
 * that can reach a printer's web console already has a browser. So the
 * installer listens on 127.0.0.1 only -- nothing else on the network can
 * reach it, and Windows asks no firewall question for a loopback port --
 * and opens its page there.
 *
 * Any web page the browser has open can also send requests to
 * 127.0.0.1, so each request must carry the token the installer put in
 * the URL it opened, in a header -- which a page from elsewhere cannot
 * add without a CORS preflight this server never answers -- and name the
 * installer's own host, against DNS rebinding.
 *
 *   GET  /?t=<token>   the page (gui.html)
 *   POST /deploy       { ip, packed, telemetry }: the deploy, as NDJSON
 *                      events; telemetry is on unless it is false
 *   POST /log          the last failed deploy's diagnostic log, as text
 *   POST /log/send     send it to the telemetry server: { reference } or
 *                      { error }
 *   POST /ping         the page is still open
 *   POST /quit         the page's Quit button
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  deploy as realDeploy,
  sendDiagnosticLog as realSendLog,
  writeDiagnosticLog,
  STEPS,
} from '../deploy.mjs';

/** A printer address: an IPv4 address or a host name, nothing that needs quoting. */
export function validAddress(ip) {
  return typeof ip === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(ip);
}

/**
 * What went wrong, said for someone who has never heard of port 9100.
 * The original message goes alongside it, for whoever they ask.
 */
export function explainError(err, ip) {
  const message = String(err && err.message ? err.message : err);
  if (/ENOTFOUND|EAI_AGAIN/.test(message))
    return `There is no computer called "${ip}" on this network. Check the printer's address: it is on its configuration label, and most printers show it on the front panel.`;
  if (/ECONNREFUSED/.test(message))
    return `Something at ${ip} answered, but not as a Zebra printer: it refused port 9100. Check the address.`;
  if (/answered neither the JSON question nor allcv/.test(message))
    return `Something at ${ip} took the connection on port 9100 but did not answer as a Zebra printer does. Check the address.`;
  if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Timed out|No response/.test(message))
    return `Nothing answered at ${ip}. Check that the printer is on, that the address is right, and that this computer is on the same network as the printer.`;
  if (/after the upload/.test(message))
    return 'The files went up, but the printer is not serving the page. Try again; if it keeps happening, restart the printer and try once more.';
  return 'The install did not finish.';
}

/**
 * Serve the installer's page and run deploys for it.
 *
 *   staged   what tools/build.mjs stage() made
 *   page     gui.html
 *   deploy   tools/deploy.mjs deploy(), replaced in tests
 *   sendLog  tools/deploy.mjs sendDiagnosticLog(), likewise
 *   logDir   where a failed deploy's diagnostic log is written; null
 *            keeps it in memory only
 *   idleMs   quit this long after the page last pinged
 *
 * Resolves to { url, close, closed } once listening; `closed` resolves
 * when the installer should exit.
 */
export async function startGui({
  staged,
  page,
  version,
  deploy = realDeploy,
  sendLog = realSendLog,
  logDir = null,
  port = 0,
  idleMs = 5 * 60 * 1000,
}) {
  const token = randomBytes(16).toString('hex');
  let busy = false;
  let lastPing = Date.now();
  // The last failed deploy's diagnostic log: { text, deployId }.
  let failedLog = null;
  let finish;
  const closed = new Promise((resolveClosed) => (finish = resolveClosed));

  const html = page
    .replaceAll('{{TOKEN}}', token)
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{STEPS}}', JSON.stringify(STEPS));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const host = req.headers.host || '';
    if (
      host !== `127.0.0.1:${server.address().port}` &&
      host !== `localhost:${server.address().port}`
    ) {
      res.writeHead(421).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.get('t') !== token) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Open the address the installer printed, including the part after ?t=');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      });
      res.end(html);
      return;
    }
    if (req.method !== 'POST' || req.headers['x-installer-token'] !== token) {
      res.writeHead(404).end();
      return;
    }
    lastPing = Date.now();

    if (url.pathname === '/ping') {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/quit') {
      res.writeHead(204).end();
      shutdown();
      return;
    }
    if (url.pathname === '/log' || url.pathname === '/log/send') {
      if (!failedLog) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('There is no diagnostic log: no install has failed.');
        return;
      }
      if (url.pathname === '/log') {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(failedLog.text);
        return;
      }
      const outcome = await sendLog(failedLog.text, {
        deployId: failedLog.deployId,
        version,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(outcome));
      return;
    }
    if (url.pathname !== '/deploy') {
      res.writeHead(404).end();
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const ip = String(body.ip || '').trim();
    if (!validAddress(ip)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('That does not look like a printer address.');
      return;
    }
    if (busy) {
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      res.end('An install is already running.');
      return;
    }

    busy = true;
    failedLog = null;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const send = (event) => res.write(JSON.stringify(event) + '\n');
    try {
      const result = await deploy(
        {
          ip,
          fetchSchema: true,
          upload: true,
          clean: true,
          packed: Boolean(body.packed),
          source: null,
          telemetry: body.telemetry !== false && !process.env.MONOCHROME_UNICORN_NO_TELEMETRY,
        },
        { staged, emit: send },
      );
      send({ type: 'done', ...result });
    } catch (err) {
      let log = null;
      if (err.diagnosticLog) {
        failedLog = { text: err.diagnosticLog, deployId: err.deployId };
        log = { bytes: Buffer.byteLength(err.diagnosticLog), path: null };
        try {
          if (logDir) log.path = writeDiagnosticLog(err.diagnosticLog, logDir);
        } catch {
          // Still in memory, for Save log and Send.
        }
      }
      send({ type: 'error', message: explainError(err, ip), detail: err.message, log });
    } finally {
      busy = false;
      lastPing = Date.now();
      res.end();
    }
  });

  // A browser tab in the background is pinged far less often than asked,
  // so the idle limit is minutes, not seconds.
  const idle = setInterval(() => {
    if (!busy && Date.now() - lastPing > idleMs) shutdown();
  }, 5000);
  idle.unref();

  function shutdown() {
    clearInterval(idle);
    server.close();
    server.closeAllConnections();
    finish();
  }

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/?t=${token}`,
    token,
    close: shutdown,
    closed,
  };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > limit) {
        rejectBody(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolveBody(text));
    req.on('error', rejectBody);
  });
}
