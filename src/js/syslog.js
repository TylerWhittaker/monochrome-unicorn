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
 * syslog.js -- reading the printer's syslog, and its syslog and alert
 * settings, as data. The views are in logs.js.
 *
 * A log line, as the printer writes it (device.syslog.entries, and
 * E:SYSLOG.TXT when device.syslog.save_local_file is on):
 *
 *   Sep 23 02:30:50 nto : [Power][Informational][0X14] Power On
 *
 * -- the time, a host name the manual's examples leave out, then the
 * feature, the severity and a message code in brackets, and the message.
 *
 * The settings are strings, written whole and kept exactly as written
 * (measured on the ZD500R, docs/printer-notes.md):
 *
 *   device.syslog.configuration  "severity,destination;..."  -- a space
 *       after a ";" makes the printer refuse the whole value, silently;
 *   alerts.configured  "condition,destination,set,clear,address,port,
 *       quelling[,sgd]|..."  -- a trailing "|" is refused, and the old
 *       list kept.
 */

/** The syslog severities, most severe first, as the configuration names them. */
export const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

/** What each is called in the log itself, and in words. */
export const SEVERITY_NAMES = {
  emerg: 'Emergency',
  alert: 'Alert',
  crit: 'Critical',
  err: 'Error',
  warning: 'Warning',
  notice: 'Notice',
  info: 'Informational',
  debug: 'Debug',
};

/** A severity as the log or the configuration spells it -> its index, 0 most severe; -1 unknown. */
export function severityLevel(word) {
  const w = String(word || '')
    .trim()
    .toLowerCase();
  if (!w) return -1;
  const byKey = SEVERITIES.indexOf(w);
  if (byKey !== -1) return byKey;
  const aliases = {
    emergency: 0,
    critical: 2,
    error: 3,
    warn: 4,
    informational: 6,
    information: 6,
  };
  if (w in aliases) return aliases[w];
  return SEVERITIES.findIndex((key) => SEVERITY_NAMES[key].toLowerCase().startsWith(w));
}

const SYSLOG_LINE =
  /^(\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2})(?:\s+([^\s:][^:]*?))?\s*:\s*\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\s?(.*)$/;

const SYSLOG_REPEAT =
  /^(\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2})\s+(\S+)\s+last message repeated (\d+) times?\s*$/;

/**
 * Log text -> one entry per line: { raw, time, host, feature, severity,
 * level, code, message }. syslog's own "last message repeated 15 times"
 * lines carry no brackets; they take the feature and severity of the
 * line they repeat, with `repeat` set, so a filter keeps them together.
 * Any other line not in the printer's format is kept, with only `raw`
 * and level -1, so nothing is lost from the view.
 */
export function parseSyslog(text) {
  let previous = null;
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((raw) => {
      const m = SYSLOG_LINE.exec(raw);
      if (m) {
        const [, time, host, feature, severity, code, message] = m;
        previous = {
          raw,
          time,
          host: host ? host.trim() : '',
          feature,
          severity,
          level: severityLevel(severity),
          code,
          message,
        };
        return previous;
      }
      const r = SYSLOG_REPEAT.exec(raw);
      if (r) {
        return {
          raw,
          time: r[1],
          host: r[2],
          feature: previous ? previous.feature : '',
          severity: previous ? previous.severity : '',
          level: previous ? previous.level : -1,
          code: previous ? previous.code : '',
          message: `last message repeated ${r[3]} times`,
          repeat: Number(r[3]),
        };
      }
      return { raw, level: -1 };
    });
}

/** Entries at least as severe as `minLevel` (-1 or 7: all), for `feature` (empty: any), matching `search`. */
export function filterEntries(entries, { minLevel = 7, feature = '', search = '' } = {}) {
  const needle = search.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (minLevel >= 7 || (e.level !== -1 && e.level <= minLevel)) &&
      (!feature || e.feature === feature) &&
      (!needle || e.raw.toLowerCase().includes(needle)),
  );
}

/* ------------------------------------------------------------------ *
 * device.syslog.configuration
 * ------------------------------------------------------------------ */

const IPV4_ADDRESS = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export const isIpv4 = (text) => IPV4_ADDRESS.test(String(text).trim());

/** "err,local;debug,10.0.0.9;" -> [{ severity, destination }] */
export function parseSyslogConfig(text) {
  return String(text || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [severity = '', destination = ''] = part.split(',').map((s) => s.trim());
      return { severity: severity.toLowerCase(), destination };
    });
}

/** Rows -> the string the printer takes: lower case, no spaces, ";" after each. */
export function formatSyslogConfig(rows) {
  return rows
    .map(
      ({ severity, destination }) =>
        `${String(severity).trim().toLowerCase()},${String(destination).trim()};`,
    )
    .join('');
}

/** What is wrong with the rows, one message per problem; empty when they will be taken. */
export function checkSyslogRows(rows) {
  const problems = [];
  rows.forEach(({ severity, destination }, i) => {
    const n = i + 1;
    if (!SEVERITIES.includes(String(severity).toLowerCase()))
      problems.push(`Row ${n}: choose a severity.`);
    const d = String(destination).trim();
    if (d !== 'local' && !isIpv4(d)) {
      problems.push(`Row ${n}: the destination is "local" or a syslog server's IPv4 address.`);
    }
  });
  const locals = rows.filter((r) => String(r.destination).trim() === 'local');
  if (locals.length > 1) {
    problems.push('Only the first "local" row is used: the printer ignores the others.');
  }
  if (formatSyslogConfig(rows).length > 1000) problems.push('The list is over 1000 characters.');
  return problems;
}

/* ------------------------------------------------------------------ *
 * alerts.configured
 * ------------------------------------------------------------------ */

/** The printer's list settings ("A, B, C") -> ["A", "B", "C"]. */
export function parseList(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Destinations an alert needs an address for; the rest go out on a local port. */
export const NEEDS_ADDRESS = ['TCP', 'UDP', 'E-MAIL', 'SNMP', 'HTTP-POST', 'SDK', 'MQTT'];
/** Destinations an alert needs a port for. */
export const NEEDS_PORT = ['TCP', 'UDP', 'SNMP'];

const alertFlag = (v) => String(v).trim().toUpperCase() === 'Y';

/** "COLD START,SNMP,Y,N,255.255.255.255,162,N|..." -> one row per alert. */
export function parseAlerts(text) {
  return String(text || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const f = part.split(',');
      return {
        condition: (f[0] || '').trim(),
        destination: (f[1] || '').trim(),
        onSet: alertFlag(f[2]),
        onClear: alertFlag(f[3]),
        address: (f[4] || '').trim(),
        port: (f[5] || '').trim(),
        quelling: alertFlag(f[6]),
        sgd: f.slice(7).join(',').trim(),
      };
    });
}

/** Rows -> the string the printer takes: no trailing "|", an SGD name only for SGD SET. */
export function formatAlerts(rows) {
  return rows
    .map((r) => {
      const fields = [
        r.condition,
        r.destination,
        r.onSet ? 'Y' : 'N',
        r.onClear ? 'Y' : 'N',
        String(r.address || '').trim(),
        String(r.port || '').trim(),
        r.quelling ? 'Y' : 'N',
      ];
      if (r.condition === 'SGD SET') fields.push(String(r.sgd || '').trim());
      return fields.join(',');
    })
    .join('|');
}

/** What is wrong with the alert rows; empty when they will be taken. */
export function checkAlertRows(rows, { conditions = [], destinations = [] } = {}) {
  const problems = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (!r.condition || (conditions.length && !conditions.includes(r.condition))) {
      problems.push(`Alert ${n}: choose a condition.`);
    }
    if (!r.destination || (destinations.length && !destinations.includes(r.destination))) {
      problems.push(`Alert ${n}: choose a destination.`);
    }
    if (NEEDS_ADDRESS.includes(r.destination) && !String(r.address || '').trim()) {
      problems.push(`Alert ${n}: ${r.destination} needs an address.`);
    }
    if (NEEDS_PORT.includes(r.destination) && !/^\d{1,5}$/.test(String(r.port || '').trim())) {
      problems.push(`Alert ${n}: ${r.destination} needs a port number.`);
    }
    for (const [field, value] of [
      ['address', r.address],
      ['SGD name', r.sgd],
    ]) {
      if (/[,|]/.test(String(value || ''))) {
        problems.push(`Alert ${n}: the ${field} cannot contain "," or "|".`);
      }
    }
    if (r.condition === 'SGD SET' && !String(r.sgd || '').trim()) {
      problems.push(`Alert ${n}: SGD SET needs the setting to watch.`);
    }
    if (!r.onSet && !r.onClear) {
      problems.push(
        `Alert ${n}: send it on set, on clear, or both -- the printer drops an alert with neither.`,
      );
    }
  });
  return problems;
}
