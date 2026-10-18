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
 * build.mjs -- build dist/INDEX.SHTML and the V_*.SHTML helper files.
 *
 * The printer will not serve a page that references local assets we cannot
 * upload alongside it, and its web server pushes a few hundred KB/s, so the
 * build has two jobs: fold every asset into one file, and keep that file
 * small. Ace is the one exception -- it is pulled from cdnjs on demand,
 * with a plain-textarea fallback when the client has no internet.
 *
 * It does that in two halves. stage() does what every printer gets
 * alike -- Tailwind, the bundler below, prettier -- and needs the npm dev
 * dependencies; tools/assemble.mjs fits the result to one printer's
 * catalogue with nothing but Node's own modules. A plain build does both;
 * a release stages once, into dist/stage.json, and the deploy tool it
 * ships (tools/installer/) carries that and assembles on the spot.
 *
 *   node tools/build.mjs [--schema dist/sgd-schema.json] [--out dist] [--packed]
 *   node tools/build.mjs --stage [--out dist]      dist/stage.json only
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { ZPL } from '../src/data/zpl-reference.mjs';
import { SGD } from '../src/data/sgd-reference.mjs';
import { readVersion } from './version.mjs';
import { assemble } from './assemble.mjs';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * The one comment that survives squeeze(): the built page is a conveyed
 * copy of this program, so the script it carries says what it is and under
 * what terms. src/index.html carries the full notice as HTML.
 */
const JS_BANNER = [
  '/*! Monochrome Unicorn -- Copyright (C) 2026 Tyler Whittaker.',
  ' * Free software under the GNU AGPL v3 or later, with ABSOLUTELY NO WARRANTY.',
  ' * See <https://www.gnu.org/licenses/agpl-3.0.html>. */',
].join('\n');

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
    throw new Error(
      `${path}: only "import { names } from './mod.js'" is supported, saw:\n  ${bare[0].trim()}`,
    );
  }
  const other = source.match(EXPORT_OTHER_RE);
  if (other) {
    throw new Error(
      `${path}: only "export function/const/class" is supported, saw:\n  ${other[0].trim()}`,
    );
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
  for (const match of source.matchAll(
    /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    exported.push(match[1]);
  }

  // Every module ends up in one shared scope, so a module-private name can
  // collide with another module's just as easily as an exported one --
  // and that only shows up as a SyntaxError in the browser. Collect all
  // top-level declarations (column zero, by this codebase's style) so the
  // build can refuse instead.
  const declared = [];
  for (const match of source.matchAll(
    /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    declared.push(match[1]);
  }

  const body = source.replace(IMPORT_RE, '').replace(EXPORT_DECL_RE, '$1');

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
      if (!dep.startsWith('.'))
        throw new Error(`${path}: cannot inline non-relative import "${dep}"`);
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
          `Top-level name "${name}" is declared in both ${rel(mod.path)} and ${rel(declarers.get(name))}.\n` +
            '       All modules share one scope after inlining, so these names must be unique.',
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
  execFileSync(
    'npx',
    ['tailwindcss', '-i', join(ROOT, 'src/css/app.css'), '-o', cssOut, '--minify'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return readFileSync(cssOut, 'utf8').trim();
}

/**
 * Minify our own JS just enough to matter: strip block/line comments and
 * collapse indentation. Deliberately conservative -- no renaming, no
 * statement rewriting -- so a build never changes behaviour. prettify()
 * then lays it out again.
 */
function squeeze(js) {
  return (
    js
      // Block comments, but not inside a string or regex literal. Our sources
      // keep comments on their own lines, so anchoring to line starts is safe.
      .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
      .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
      .replace(/^[ \t]+/gm, '')
      .replace(/\n{2,}/g, '\n')
      .trim()
  );
}

const PRETTIER = join(ROOT, 'node_modules/.bin/prettier');

/**
 * Format JS that goes into the page with prettier, as all of this
 * project's JS is.
 *
 * The page's copy uses tabs rather than the sources' two spaces: prettier's
 * layout either way, but one byte per level of indent instead of two --
 * about 20 KB unpacked, next to nothing once packed.
 */
function prettify(js) {
  if (!existsSync(PRETTIER)) {
    throw new Error('prettier is not installed; run "npm install" first');
  }
  return execFileSync(PRETTIER, ['--stdin-filepath', 'page.js', '--use-tabs'], {
    cwd: ROOT,
    input: js,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/** Run prettify() over every inline <script> the page shell carries itself. */
function prettifyInlineScripts(html) {
  return html.replace(/<script>(\n[\s\S]*?)<\/script>/g, (whole, body) =>
    body.includes('{{') ? whole : `<script>\n${prettify(body)}\n</script>`,
  );
}

/**
 * The ZPL command reference the source view shows, as JSON in a file of
 * its own (src/data/zpl-reference.mjs has why). One command to a line:
 * the printer's preprocessor reads .SHTML line by line, and nothing is
 * gained by finding out what it makes of a 95 KB one.
 */
export function zplReferenceFile() {
  return referenceFile(ZPL);
}

/** A reference as JSON, one entry to a line (see zplReferenceFile). */
export function referenceFile(reference) {
  const lines = Object.entries(reference).map(
    ([key, entry]) => `${JSON.stringify(key)}:${JSON.stringify(entry)}`,
  );
  return `{\n${lines.join(',\n')}\n}\n`;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

// What the tests and the old callers imported from here.
export {
  hasLcd,
  withoutLcd,
  packBranches,
  packPayload,
  unpackPayload,
  assemble,
} from './assemble.mjs';

/** Everything the page needs that does not depend on the printer. */
export function stage({ outDir }) {
  mkdirSync(outDir, { recursive: true });
  return {
    template: prettifyInlineScripts(readFileSync(join(ROOT, 'src/index.html'), 'utf8')),
    css: buildCss(outDir),
    htmx: readFileSync(join(ROOT, 'vendor/htmx.min.js'), 'utf8').trim(),
    app: prettify(JS_BANNER + '\n' + squeeze(bundle(join(ROOT, 'src/js/app.js')))),
    unpack: prettify(squeeze(readFileSync(join(ROOT, 'src/unpack.js'), 'utf8'))),
    version: readVersion(),
    zplref: zplReferenceFile(),
    sgdref: referenceFile(SGD),
  };
}

/** Write an assemble() result where deploy.sh looks for it. */
export function writeBuild(result, outDir) {
  const indexPath = join(outDir, 'INDEX.SHTML');
  writeFileSync(indexPath, result.html);

  // Helper files live in dist/helpers so a deploy can sweep the whole set.
  const helperDir = join(outDir, 'helpers');
  if (existsSync(helperDir)) rmSync(helperDir, { recursive: true });
  mkdirSync(helperDir, { recursive: true });

  for (const file of result.helpers) {
    writeFileSync(join(helperDir, file.dest.slice(2)), file.contents);
  }
  return { indexPath, helperDir };
}

/** Read a catalogue, saying how to get one when there is none yet. */
export function readSchema(schemaPath) {
  // The catalogue is captured from a printer rather than kept in the
  // repository, so a fresh clone has none until a deploy has run once.
  if (!existsSync(schemaPath)) {
    throw new Error(
      `No settings catalogue at ${rel(schemaPath)}.\n` +
        '       It is read from a printer rather than checked in:\n' +
        '         node tools/fetch-schema.mjs <printer-ip>\n' +
        '       or ./deploy.sh <printer-ip>, which does both.',
    );
  }
  return JSON.parse(readFileSync(schemaPath, 'utf8'));
}

export function build({ schemaPath, outDir, packed = false }) {
  const schema = readSchema(schemaPath);
  const result = assemble({ staged: stage({ outDir }), schema, packed });
  const { indexPath, helperDir } = writeBuild(result, outDir);
  return {
    indexPath,
    version: result.version,
    indexBytes: Buffer.byteLength(result.html),
    helperDir,
    helpers: result.helpers.map((f) => f.dest),
    lcd: result.lcd,
    parts: result.parts,
    packed,
  };
}

/** The size report a build prints; deploy.mjs prints it too. */
export function describeBuild(result) {
  const kb = (n) => (n / 1024).toFixed(1).padStart(6) + ' KB';
  const lines = [
    `Built dist/INDEX.SHTML  (version ${result.version})`,
    `  tailwind css ${kb(result.parts.css)}`,
    `  htmx         ${kb(result.parts.htmx)}`,
    `  app js       ${kb(result.parts.app)}`,
    `  sgd schema   ${kb(result.parts.schema)}`,
    `  ------------------------`,
    result.packed
      ? `  packed       ${kb(result.parts.packed)}   (all four, gzipped, base64)`
      : '  unpacked     (each inlined as it is; --packed gzips them)',
    `  total        ${kb(result.indexBytes)}   (~${(result.indexBytes / (250 * 1024)).toFixed(1)}s to serve at 250 KB/s, the slowest measured)`,
    `  ${result.helpers.length} helper files in dist/helpers/`,
  ];
  if (!result.lcd) lines.push('  no display.* settings: LCD Viewer left out');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  const outDir = resolve(flag('--out', 'dist'));

  if (args.includes('--stage')) {
    const staged = stage({ outDir });
    writeFileSync(join(outDir, 'stage.json'), JSON.stringify(staged));
    console.log(`Staged ${rel(join(outDir, 'stage.json'))}  (version ${staged.version})`);
    return;
  }

  const result = build({
    schemaPath: resolve(flag('--schema', 'dist/sgd-schema.json')),
    outDir,
    // --unpacked is the default now, and still accepted.
    packed: args.includes('--packed'),
  });
  console.log(describeBuild(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error('build failed:', err.message);
    process.exit(1);
  }
}
