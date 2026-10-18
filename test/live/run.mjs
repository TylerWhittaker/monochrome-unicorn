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
 * The live test suite: every mode of the console, driven in a real
 * browser against a real printer.
 *
 *   npm run test:live                  asks for the printer and options
 *   npm run test:live -- --yes         takes them from test/live/config.json
 *   npm run test:live -- --only editor,files --no-deploy
 *
 * The run goes:
 *
 *   1. settle the config (lib/config.mjs): printer, password, whether
 *      labels may be printed, the label loaded;
 *   2. let each suite prepare the printer -- Settings creates its test
 *      variables here, because the console only shows the settings in
 *      the catalogue captured when it was built;
 *   3. build this working tree and deploy it (unless --no-deploy), so
 *      what is tested is what is about to be committed;
 *   4. run each suite in a fresh browser context, then its cleanups.
 *
 * Everything the tests create on the printer is named ZTEST*, and is
 * removed again; anything they change is put back. Two things outlive
 * a run: the device.user_vars.test_* settings, which the printer cannot
 * delete (they go at its next power cycle), and the catalogue of this
 * deploy, which lists them until the next one after that.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeSize } from './lib/config.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { createSuite, runSuite, summarise, bold, red, grey } from './lib/harness.mjs';
import { removeFile, getvar } from './lib/printer.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SUITE_MODULES = {
  app: './app.live.mjs',
  settings: './settings.live.mjs',
  editor: './editor.live.mjs',
  formats: './formats.live.mjs',
  files: './files.live.mjs',
  lcd: './lcd.live.mjs',
  installer: './installer.live.mjs',
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

/** Everything a run leaves named ZTEST on the printer's flash. */
async function sweep(ip) {
  await removeFile(ip, 'E:ZTEST*.*');
}

async function main() {
  const cfg = await loadConfig();
  const model = await getvar(cfg.ip, 'device.product_name');
  const firmware = await getvar(cfg.ip, 'appl.name');

  console.log(`\n${bold('Live tests')} against ${cfg.ip} (${model}, ${firmware})`);
  console.log(`  label loaded:  ${describeSize(cfg.label, cfg.dpi)}`);
  console.log(`  printing:      ${cfg.print ? 'yes' : 'no -- print tests are skipped'}`);
  console.log(`  suites:        ${cfg.only.join(', ')}`);

  const modules = {};
  for (const id of cfg.only) modules[id] = await import(SUITE_MODULES[id]);

  const ctx = {
    cfg,
    model,
    firmware,
    root: ROOT,
    /** Short and fresh each run, for values that must not be stale. */
    runId: Date.now().toString(36).slice(-6).toUpperCase(),
    browser: null,
  };

  // Left over from a run that was interrupted.
  await sweep(cfg.ip);

  for (const [id, mod] of Object.entries(modules)) {
    if (mod.prepare) {
      console.log(grey(`  preparing ${id}…`));
      await mod.prepare(ctx);
    }
  }

  if (cfg.deploy) {
    console.log(`\n${bold('Deploying')} this working tree to ${cfg.ip}`);
    await run('./deploy.sh', [cfg.ip]);
  } else {
    console.log(grey('\n  not deploying: testing what the printer already serves'));
  }

  ctx.browser = await launchBrowser(cfg);
  const results = [];
  try {
    for (const [id, mod] of Object.entries(modules)) {
      const suite = createSuite(mod.name || id);
      await mod.default(suite, ctx);
      await runSuite(suite, results);
    }
  } finally {
    await ctx.browser.close();
    await sweep(cfg.ip).catch((err) => console.log(red(`  final sweep failed: ${err.message}`)));
  }

  process.exit(summarise(results) ? 0 : 1);
}

main().catch((err) => {
  console.error(red(`\n${err.stack || err.message}`));
  process.exit(2);
});
