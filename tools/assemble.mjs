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
 * assemble.mjs -- the printer-specific half of the build.
 *
 * tools/build.mjs stages what every printer gets alike: the Tailwind
 * styles, the bundled app laid out by prettier, htmx, the page shell and
 * the two references. That needs the npm dev dependencies, so a release
 * does it once (dist/stage.json). What is left depends on the printer in
 * front of you -- its catalogue decides the helper files, what the page
 * carries and whether it has an LCD Viewer -- and uses nothing but Node's
 * own modules, so the deploy tool can carry it without node_modules.
 */

import { gzipSync, gunzipSync } from 'node:zlib';

/*
 * The LCD viewer polls this one small file rather than a whole branch.
 * display.image (the real framebuffer) cannot come this way: getvar.cgi
 * truncates any value at its first NUL byte, and a BMP has one at offset
 * four. display.text is the same screen as a 20x6 character grid.
 */
/*
 * What the header's status pill is refreshed from, every few seconds:
 * the ~HS flags, and the two settings that say plainly when the head is
 * open or the media has run out.
 */
const STATUS_VARS = [
  'device.host_status',
  'head.latch',
  'media.status',
  'odometer.total_label_count',
];

/** What the Maintenance card in Printer Settings shows. */
const MAINT_VARS = [
  'odometer.headclean',
  'odometer.headnew',
  'odometer.total_label_count',
  'odometer.total_print_length',
  'odometer.total_cuts',
  'odometer.latch_open_count',
  'sensor.head.temp_celsius',
  'device.uptime',
  'log.reboot.reason',
];

/** The media sensor card: which sensor, its readings and thresholds. */
const SENSOR_VARS = [
  'media.sense_mode',
  'device.sensor_select',
  'media.type',
  'media.status',
  'head.latch',
  'zpl.label_length',
  'sensor.gap.cur',
  'sensor.gap.thold',
  'sensor.gap.ppr_out_thold',
  'sensor.back_bar.cur',
  'sensor.back_bar.thold',
  'sensor.back_bar.ppr_out_thold',
];

/** Syslog & alerts in Printer Settings: the log, and the settings it edits. */
const LOG_VARS = [
  'device.syslog.enable',
  'device.syslog.configuration',
  'device.syslog.save_local_file',
  'device.syslog.log_max_file_size',
  'device.syslog.entries',
  'alerts.configured',
  'alerts.conditions',
  'alerts.destinations',
  'alerts.http.logging.entries',
  'alerts.http.logging.max_entries',
  'alerts.tracked_settings.log_tracked',
  'alerts.tracked_settings.max_log_entries',
  'ip.smtp.enable',
  'ip.smtp.server_addr',
  'ip.smtp.domain',
  'ip.snmp.trap_community_name',
];

/** The printer's clock, for the Set clock dialog. */
const CLOCK_VARS = ['rtc.exists', 'rtc.date', 'rtc.time', 'rtc.timezone', 'rtc.unix_timestamp'];

const LCD_VARS = [
  'display.text',
  'display.backlight',
  'display.contrast',
  // Which WML file is on screen, for the font it asks for: that decides
  // how many columns display.text is laid out in.
  'display.load_card',
  'display.root_wml',
  // The printer's own menus name their font as $(display.wml_font).
  'display.wml_font',
];

/** A printer with no display.* branch has no front panel to mirror. */
export function hasLcd(schema) {
  return Object.keys(schema.settings).some((name) => name.startsWith('display.'));
}

/*
 * Take the LCD Viewer's tab and panel out of the page, for a printer
 * without a display. Each is one line of src/index.html; finding anything
 * other than exactly one of each means the markup has moved on, and is
 * an error rather than a page that half-offers the mode.
 */
export function withoutLcd(html) {
  for (const attr of ['data-tab="lcd"', 'data-panel="lcd"']) {
    const lines = html.split('\n');
    const hits = lines.filter((line) => line.includes(attr));
    if (hits.length !== 1)
      throw new Error(`src/index.html: expected one line with ${attr}, found ${hits.length}`);
    html = lines.filter((line) => !line.includes(attr)).join('\n');
  }
  return html;
}

/** The helper holding every readable setting; see helperFiles(). */
export const ALL_FILE = 'V_ALL';

/* Settings shown in the page header, read live by the SSI preprocessor. */
const BOOT_VARS = [
  'device.product_name',
  'device.friendly_name',
  'device.unique_id',
  'device.host_status',
  // Which label language the printer will parse, so Stored Formats can
  // warn before sending it something it will silently ignore.
  'device.languages',
  'appl.name',
  'head.resolution.in_dpi',
  // The size of the label loaded, in dots: a new label starts at it.
  'zpl.label_length',
  'ezpl.print_width',
  'media.darkness',
  'print.tone',
  // Which interface is in use, and each one's address: ip.addr alone
  // follows the wireless one even when the printer is on Ethernet.
  'ip.active_network',
  'wlan.ip.addr',
  'internal_wired.ip.addr',
  'ip.addr',
];

/**
 * "YYYY-MM-DD HH:MM:SS", in UTC.
 *
 * A printer on a bench and the machine that built the page are rarely
 * in the same room, let alone the same timezone, so the stamp in the
 * footer says when the build happened in the one timezone that does not
 * depend on who is reading it.
 */
export function buildStamp(now = new Date()) {
  return now.toISOString().slice(0, 19).replace('T', ' ');
}

/** The @name=value@ block the preprocessor fills in before serving. */
function bootVarsBlock() {
  return BOOT_VARS.map(
    (name) => `@${name}=<!--#exec cmd="/Zebra/cgi/getvar.cgi ${name}" -->@`,
  ).join('\n');
}

/** One "@name=value@" line, for the preprocessor to fill in. */
function varLine(name) {
  return `@${name}=<!--#exec cmd="/Zebra/cgi/getvar.cgi ${name}" -->@`;
}

/** Most settings one read-back file holds, unless a branch alone is bigger. */
const HELPER_MAX_SETTINGS = 40;

/**
 * Pack settings branches into as few read-back files as will stay quick.
 *
 * A branch file is only read to confirm a write -- the sweep uses the
 * one file holding everything -- and it costs about 10 ms a setting on
 * top of ~95 ms a request. One file per branch put 32 files on E:, most
 * holding a handful of settings, so small branches share: first-fit,
 * largest first, up to HELPER_MAX_SETTINGS. A branch bigger than that
 * keeps a file to itself, since splitting one would gain nothing -- a
 * write re-reads its whole branch either way.
 *
 * Returns an array of groups, each an array of branch names.
 */
export function packBranches(byBranch, max = HELPER_MAX_SETTINGS) {
  const sizes = [...byBranch].map(([branch, names]) => [branch, names.length]);
  // Largest first; ties by name, so a build is repeatable.
  sizes.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const groups = [];
  for (const [branch, size] of sizes) {
    const home = size < max && groups.find((g) => g.size + size <= max);
    if (home) {
      home.branches.push(branch);
      home.size += size;
    } else {
      groups.push({ branches: [branch], size });
    }
  }
  return groups.map((g) => g.branches.sort());
}

/**
 * The settings branches packed into a few read-back files (see
 * packBranches()), plus one file per slow setting.
 *
 * Each line frames the value with @...@ so the client can parse it
 * unambiguously -- a bare getvar on a whole branch returns a
 * human-readable listing whose format varies by setting.
 *
 * The slow settings are kept out of their branch file (they are 85% of
 * the time a full sweep takes) but still need a way to be read, so each
 * gets a file of its own that the client fetches on demand. Object names
 * cap out around 16 characters, hence the index rather than the setting
 * name.
 */
export function helperFiles(schema, staged) {
  const slow = (schema.slow || []).filter((name) => {
    const meta = schema.settings[name];
    return meta && schema.access[meta[2]].includes('R');
  });
  const slowSet = new Set(slow);

  const readable = Object.entries(schema.settings)
    .filter(([name, meta]) => schema.access[meta[2]].includes('R') && !slowSet.has(name))
    .map(([name]) => name);

  const byBranch = new Map();
  for (const name of readable) {
    const branch = name.split('.')[0];
    if (!byBranch.has(branch)) byBranch.set(branch, []);
    byBranch.get(branch).push(name);
  }

  const files = [];
  const branchFiles = {};
  packBranches(byBranch).forEach((group, i) => {
    const stem = `V_${i + 1}`;
    for (const branch of group) branchFiles[branch] = stem;
    files.push({
      dest: `E:${stem}.SHTML`,
      branches: group,
      contents:
        group
          .flatMap((b) => byBranch.get(b))
          .map(varLine)
          .join('\n') + '\n',
    });
  });

  const slowFiles = {};
  slow.forEach((name, i) => {
    slowFiles[name] = `S_${i}`;
    files.push({ dest: `E:S_${i}.SHTML`, contents: varLine(name) + '\n' });
  });

  if (hasLcd(schema)) {
    files.push({ dest: 'E:LCD.SHTML', contents: LCD_VARS.map(varLine).join('\n') + '\n' });
  }

  files.push({ dest: 'E:STATUS.SHTML', contents: STATUS_VARS.map(varLine).join('\n') + '\n' });
  files.push({ dest: 'E:CLOCK.SHTML', contents: CLOCK_VARS.map(varLine).join('\n') + '\n' });
  files.push({ dest: 'E:MAINT.SHTML', contents: MAINT_VARS.map(varLine).join('\n') + '\n' });
  files.push({ dest: 'E:SENSOR.SHTML', contents: SENSOR_VARS.map(varLine).join('\n') + '\n' });
  files.push({ dest: 'E:LOGS.SHTML', contents: LOG_VARS.map(varLine).join('\n') + '\n' });

  /*
   * Every readable setting in one file, for the sweep.
   *
   * The branch files are still written, because a write is confirmed by
   * re-reading just that branch and this one takes four seconds. But
   * asking for it once beats asking 32 times: the per-request overhead
   * on this web server is about 95 ms, so the sweep went from 6.9 s to
   * 3.9 s by dropping the round trips. The preprocessor streams its
   * output as it goes, so values still arrive to be painted one at a
   * time -- sooner, in fact, with the first at ~120 ms.
   */
  files.push({ dest: `E:${ALL_FILE}.SHTML`, contents: readable.map(varLine).join('\n') + '\n' });

  // The two references are the same for every printer, so they come
  // staged (tools/build.mjs).
  files.push({ dest: 'E:ZPLREF.SHTML', contents: staged.zplref });
  files.push({ dest: 'E:SGDREF.SHTML', contents: staged.sgdref });

  return { files, slowFiles, branchFiles };
}

/* ------------------------------------------------------------------ *
 * Packing
 * ------------------------------------------------------------------ */

/**
 * The page's styles and scripts as one gzipped, base64 blob for
 * src/index.html's unpacker: about a third of their size, which is what
 * the printer's slow web server cares about. Wrapped in short lines, in
 * case the SSI preprocessor that serves the page has a limit; atob in the
 * browser ignores the line breaks.
 */
export function packPayload(parts, width = 120) {
  const base64 = gzipSync(Buffer.from(JSON.stringify(parts)), { level: 9 }).toString('base64');
  const lines = [];
  for (let i = 0; i < base64.length; i += width) lines.push(base64.slice(i, i + width));
  return lines.join('\n');
}

/** The other way, for tests: the parts a packed blob holds. */
export function unpackPayload(packed) {
  return JSON.parse(gunzipSync(Buffer.from(packed.replace(/\s+/g, ''), 'base64')).toString());
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

/** What tools/build.mjs stages; assemble() refuses a stage missing any. */
export const STAGED_PARTS = [
  'template',
  'css',
  'htmx',
  'app',
  'unpack',
  'version',
  'zplref',
  'sgdref',
];

/**
 * The page and its helper files for one printer, in memory: `staged` is
 * what tools/build.mjs stage() made, `schema` the catalogue
 * tools/fetch-schema.mjs read from the printer.
 */
export function assemble({ staged, schema, packed = false, now = new Date() }) {
  for (const part of STAGED_PARTS) {
    if (typeof staged[part] !== 'string') throw new Error(`The staged build has no ${part}`);
  }
  const { files: helpers, slowFiles, branchFiles } = helperFiles(schema, staged);

  // Which file to re-read after a write to each branch. Not every branch
  // has a readable setting (some are write-only commands), so a branch
  // missing here has nothing to read back.
  schema = { ...schema, branchFiles, slowFiles, allFile: ALL_FILE };

  const template = hasLcd(schema) ? staged.template : withoutLcd(staged.template);
  const { css, htmx, app } = staged;

  const schemaJson = JSON.stringify(schema);
  // Unpacked (the default): each part inlined as it is. Packed (--packed):
  // everything gzipped in one blob, and src/unpack.js to unpack it --
  // about 170 KB instead of 440, for a slow link, but it needs a browser
  // with DecompressionStream (see README).
  const blob = packed ? packPayload({ css, schema: schemaJson, htmx, app }) : '';
  const payload = packed
    ? [
        '<script type="text/plain" id="packed">',
        blob,
        '</script>',
        '<script>',
        staged.unpack,
        '</script>',
      ].join('\n')
    : [
        `<script type="application/json" id="sgd-schema">${schemaJson}</script>`,
        `<script>${htmx}</script>`,
        `<script>${app}</script>`,
      ].join('\n');
  const replacements = {
    '{{HTML_CLASS}}': packed ? ' class="unpacking"' : '',
    '{{HEAD_STYLE}}': packed ? 'html.unpacking body{visibility:hidden}' : css,
    '{{PAYLOAD}}': payload,
    '{{BOOT_VARS}}': bootVarsBlock(),
    '{{VERSION}}': staged.version,
    '{{BUILD_STAMP}}': buildStamp(now) + (packed ? ' &middot; packed' : ''),
  };

  let html = template;
  for (const [token, value] of Object.entries(replacements)) {
    if (!html.includes(token))
      throw new Error(`src/index.html is missing the ${token} placeholder`);
    html = html.split(token).join(value);
  }

  const leftover = html.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`Unreplaced placeholder ${leftover[0]} in output`);

  return {
    html,
    helpers,
    version: staged.version,
    lcd: hasLcd(schema),
    parts: {
      css: css.length,
      htmx: htmx.length,
      app: app.length,
      schema: schemaJson.length,
      packed: blob.length,
    },
    packed,
  };
}
