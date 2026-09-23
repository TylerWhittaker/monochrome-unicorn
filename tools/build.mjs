#!/usr/bin/env node
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
 * build.mjs -- assemble dist/INDEX.SHTML and the V_*.SHTML helper files.
 *
 * The printer will not serve a page that references local assets we cannot
 * upload alongside it, and its web server pushes about 56 KB/s, so the
 * build has two jobs: fold every asset into one file, and keep that file
 * small. Ace is the one exception -- it is pulled from cdnjs on demand,
 * with a plain-textarea fallback when the client has no internet.
 *
 *   node tools/build.mjs [--schema data/sgd-schema.json] [--out dist]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { readVersion } from './version.mjs';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * The LCD viewer polls this one small file rather than a whole branch.
 * display.image (the real framebuffer) cannot come this way: getvar.cgi
 * truncates any value at its first NUL byte, and a BMP has one at offset
 * four. display.text is the same screen as a 20x6 character grid.
 */
const LCD_VARS = ['display.text', 'display.backlight', 'display.contrast'];

/*
 * The one comment that survives squeeze(): the built page is a conveyed
 * copy of this program, so the script it carries says what it is and under
 * what terms. src/index.html carries the full notice as HTML.
 */
const JS_BANNER = [
  '/*! Zebra Printer Console -- Copyright (C) 2026 Tyler Whittaker.',
  ' * Free software under the GNU AGPL v3 or later, with ABSOLUTELY NO WARRANTY.',
  ' * See <https://www.gnu.org/licenses/agpl-3.0.html>. */',
].join('\n');

/** The helper holding every readable setting; see helperFiles(). */
const ALL_FILE = 'V_ALL';

/* Settings shown in the page header, read live by the SSI preprocessor. */
const BOOT_VARS = [
  'device.product_name',
  'device.friendly_name',
  'device.unique_id',
  'device.host_status',
  // Which label language the printer will parse, so Format Printer can
  // warn before sending it something it will silently ignore.
  'device.languages',
  'appl.name',
  'head.resolution.in_dpi',
  'media.darkness',
  'print.tone',
  'ip.addr',
];

/* ------------------------------------------------------------------ *
 * A very small ES-module bundler
 *
 * Every module under src/js is ours, so rather than pull in a bundler we
 * resolve the import graph, strip the import/export keywords and splice
 * the sources into one IIFE. The checks below make the shortcuts safe:
 * anything this cannot handle is a hard error rather than silent bad output.
 * ------------------------------------------------------------------ */

const rel = (p) => (p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p);

const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
const BARE_IMPORT_RE = /^\s*import\s+(?!\{)[^\n]*$/gm;
const EXPORT_DECL_RE = /^(\s*)export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm;
const EXPORT_OTHER_RE = /^\s*export\s*(?:\{|default|\*)/gm;

function parseModule(path) {
  const source = readFileSync(path, 'utf8');

  const bare = source.match(BARE_IMPORT_RE);
  if (bare) {
    throw new Error(`${path}: only "import { names } from './mod.js'" is supported, saw:\n  ${bare[0].trim()}`);
  }
  const other = source.match(EXPORT_OTHER_RE);
  if (other) {
    throw new Error(`${path}: only "export function/const/class" is supported, saw:\n  ${other[0].trim()}`);
  }

  const deps = [];
  const names = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    deps.push(match[2]);
    for (const n of match[1].split(',')) {
      const name = n.trim();
      if (name) names.push(name);
    }
  }

  const exported = [];
  for (const match of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    exported.push(match[1]);
  }

  // Every module ends up in one shared scope, so a module-private name can
  // collide with another module's just as easily as an exported one --
  // and that only shows up as a SyntaxError in the browser. Collect all
  // top-level declarations (column zero, by this codebase's style) so the
  // build can refuse instead.
  const declared = [];
  for (const match of source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    declared.push(match[1]);
  }

  const body = source
    .replace(IMPORT_RE, '')
    .replace(EXPORT_DECL_RE, '$1');

  return { path, deps, imported: names, exported, declared, body };
}

/** Depth-first walk of the import graph, entry point last. */
function bundle(entryPath) {
  const modules = new Map();
  const order = [];
  const visiting = new Set();

  const visit = (path) => {
    if (modules.has(path)) return;
    if (visiting.has(path)) throw new Error(`Import cycle at ${path}`);
    visiting.add(path);

    const mod = parseModule(path);
    for (const dep of mod.deps) {
      if (!dep.startsWith('.')) throw new Error(`${path}: cannot inline non-relative import "${dep}"`);
      visit(resolve(dirname(path), dep));
    }
    visiting.delete(path);
    modules.set(path, mod);
    order.push(mod);
  };
  visit(entryPath);

  // One shared scope means every top-level name must be globally unique,
  // exported or not.
  const declarers = new Map();
  for (const mod of order) {
    for (const name of mod.declared) {
      if (declarers.has(name)) {
        throw new Error(
          `Top-level name "${name}" is declared in both ${rel(mod.path)} and ${rel(declarers.get(name))}.\n`
          + '       All modules share one scope after inlining, so these names must be unique.'
        );
      }
      declarers.set(name, mod.path);
    }
  }

  const owners = new Map();
  for (const mod of order) {
    for (const name of mod.exported) owners.set(name, mod.path);
  }
  for (const mod of order) {
    for (const name of mod.imported) {
      if (!owners.has(name)) {
        throw new Error(`${mod.path}: imports "${name}", which no module exports`);
      }
    }
  }

  const parts = order.map((mod) => `/* ---- ${rel(mod.path)} ---- */\n${mod.body.trim()}\n`);
  return `(function(){\n"use strict";\n${parts.join('\n')}\n})();`;
}

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

function buildCss(outDir) {
  const cssOut = join(outDir, 'app.css');
  execFileSync('npx', [
    'tailwindcss',
    '-i', join(ROOT, 'src/css/app.css'),
    '-o', cssOut,
    '--minify',
  ], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  return readFileSync(cssOut, 'utf8').trim();
}

/**
 * Minify our own JS just enough to matter: strip block/line comments and
 * collapse indentation. Deliberately conservative -- no renaming, no
 * statement rewriting -- so a build never changes behaviour.
 */
function squeeze(js) {
  return js
    // Block comments, but not inside a string or regex literal. Our sources
    // keep comments on their own lines, so anchoring to line starts is safe.
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * "YYYY-MM-DD HH:MM:SS", in UTC.
 *
 * A printer on a bench and the machine that built the page are rarely
 * in the same room, let alone the same timezone, so the stamp in the
 * footer says when the build happened in the one timezone that does not
 * depend on who is reading it.
 */
function buildStamp(now = new Date()) {
  return now.toISOString().slice(0, 19).replace('T', ' ');
}

/** The @name=value@ block the preprocessor fills in before serving. */
function bootVarsBlock() {
  return BOOT_VARS
    .map((name) => `@${name}=<!--#exec cmd="/Zebra/cgi/getvar.cgi ${name}" -->@`)
    .join('\n');
}

/** One "@name=value@" line, for the preprocessor to fill in. */
function varLine(name) {
  return `@${name}=<!--#exec cmd="/Zebra/cgi/getvar.cgi ${name}" -->@`;
}

/**
 * One helper file per settings branch, plus one file per slow setting.
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
function helperFiles(schema) {
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
  for (const [branch, names] of [...byBranch].sort()) {
    files.push({
      dest: `E:V_${branch.toUpperCase()}.SHTML`,
      contents: names.map(varLine).join('\n') + '\n',
    });
  }

  const slowFiles = {};
  slow.forEach((name, i) => {
    slowFiles[name] = `S_${i}`;
    files.push({ dest: `E:S_${i}.SHTML`, contents: varLine(name) + '\n' });
  });

  files.push({ dest: 'E:LCD.SHTML', contents: LCD_VARS.map(varLine).join('\n') + '\n' });

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

  return { files, slowFiles };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

export function build({ schemaPath, outDir }) {
  mkdirSync(outDir, { recursive: true });

  // The catalogue is captured from a printer rather than kept in the
  // repository, so a fresh clone has none until a deploy has run once.
  if (!existsSync(schemaPath)) {
    throw new Error(
      `No settings catalogue at ${rel(schemaPath)}.\n`
      + '       It is read from a printer rather than checked in:\n'
      + '         node tools/fetch-schema.mjs <printer-ip>\n'
      + '       or ./deploy.sh <printer-ip>, which does both.'
    );
  }
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const { files: helpers, slowFiles } = helperFiles(schema);

  // Branches the client may actually fetch. Not every branch has a readable
  // setting (some are write-only commands), so this is narrower than
  // schema.branches and asking for the difference would just 404.
  schema.helperBranches = helpers
    .filter((f) => f.dest.startsWith('E:V_') && f.dest !== `E:${ALL_FILE}.SHTML`)
    .map((f) => f.dest.slice(4, -6).toLowerCase());
  schema.slowFiles = slowFiles;
  schema.allFile = ALL_FILE;

  const template = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
  const css = buildCss(outDir);
  const htmx = readFileSync(join(ROOT, 'vendor/htmx.min.js'), 'utf8').trim();
  const app = JS_BANNER + '\n' + squeeze(bundle(join(ROOT, 'src/js/app.js')));

  const replacements = {
    '{{STYLES}}': css,
    '{{HTMX}}': htmx,
    '{{APP_JS}}': app,
    '{{SGD_SCHEMA}}': JSON.stringify(schema),
    '{{BOOT_VARS}}': bootVarsBlock(),
    '{{VERSION}}': readVersion(),
    '{{BUILD_STAMP}}': buildStamp(),
  };

  let html = template;
  for (const [token, value] of Object.entries(replacements)) {
    if (!html.includes(token)) throw new Error(`src/index.html is missing the ${token} placeholder`);
    html = html.split(token).join(value);
  }

  const leftover = html.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`Unreplaced placeholder ${leftover[0]} in output`);

  const indexPath = join(outDir, 'INDEX.SHTML');
  writeFileSync(indexPath, html);

  // Helper files live in dist/helpers so deploy.sh can sweep the whole set.
  const helperDir = join(outDir, 'helpers');
  if (existsSync(helperDir)) rmSync(helperDir, { recursive: true });
  mkdirSync(helperDir, { recursive: true });

  for (const file of helpers) {
    writeFileSync(join(helperDir, file.dest.slice(2)), file.contents);
  }

  return {
    indexPath,
    version: replacements['{{VERSION}}'],
    indexBytes: Buffer.byteLength(html),
    helperDir,
    helpers: helpers.map((f) => f.dest),
    parts: {
      css: css.length,
      htmx: htmx.length,
      app: app.length,
      schema: replacements['{{SGD_SCHEMA}}'].length,
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };

  const result = build({
    schemaPath: resolve(flag('--schema', 'data/sgd-schema.json')),
    outDir: resolve(flag('--out', 'dist')),
  });

  const kb = (n) => (n / 1024).toFixed(1).padStart(6) + ' KB';
  console.log(`Built dist/INDEX.SHTML  (version ${result.version})`);
  console.log(`  tailwind css ${kb(result.parts.css)}`);
  console.log(`  htmx         ${kb(result.parts.htmx)}`);
  console.log(`  app js       ${kb(result.parts.app)}`);
  console.log(`  sgd schema   ${kb(result.parts.schema)}`);
  console.log(`  ------------------------`);
  console.log(`  total        ${kb(result.indexBytes)}   (~${(result.indexBytes / 56320).toFixed(1)}s to serve at 56 KB/s)`);
  console.log(`  ${result.helpers.length} helper files in dist/helpers/`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error('build failed:', err.message);
    process.exit(1);
  }
}
