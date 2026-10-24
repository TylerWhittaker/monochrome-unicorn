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
 * main.mjs -- the standalone installer: one file, nothing to install.
 *
 * tools/installer/package.mjs compiles this with `bun build --compile`
 * into an executable per platform that carries its own JavaScript
 * runtime, the staged build (dist/installer.json) and the installer's
 * page. So a computer needs neither Node nor npm nor git to put the
 * console on a printer.
 *
 *   monochrome-unicorn                      open the installer in the browser
 *   monochrome-unicorn <printer-ip> [...]   install from the command line,
 *                                           as ./deploy.sh does: several
 *                                           addresses, or ranges, too
 *
 * Double-clicked, there are no arguments, so a person gets the page; a
 * script or a terminal passes an address and gets the CLI.
 */

import assets from '../../dist/installer.json' with { type: 'json' };
import { runCli, USAGE } from '../deploy.mjs';
import { startGui } from './server.mjs';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HELP = `Monochrome Unicorn installer, version ${assets.staged.version}

  monochrome-unicorn                      open the installer in your browser
  monochrome-unicorn <printer-ip> [opts]  install from the command line
  monochrome-unicorn --discover           list the printers on this network

${USAGE}

  Several addresses are installed on in turn. A range is scanned for
  Zebra printers, which are listed and then installed on once you say so:
  192.168.1.0/24 (or /255.255.255.0), 192.168.1.10-50, a range in any of
  the four numbers (192.168.1-2.1-254), or a list (192.168.1.5,7).

    --discover    list the Zebra printers that answer a discovery
                  broadcast (UDP port 4201) on this computer's networks
    --yes         install on what a scan found without asking

    --packed      gzip the page, about 170 KB instead of 440, for a slow
                  link; the browser then needs DecompressionStream
                  (Safari 16.4, Firefox 113)
    --no-clean    keep the helper files a previous install left
    --no-upload   build only, leave the printer alone
    --allcv       read the catalogue as a pre-Link-OS printer must
    --allconfig   force the JSON catalogue, skipping the JSON question
    --send-log    if the install fails, send its diagnostic log without
                  asking. A failed install always writes one, in
                  ${logDir()}: what the printer said, with
                  passwords and keys taken out
    --send-log-file <file>  send a diagnostic log a failed install wrote
    --gui         open the installer page even with other options
    --no-open     with the page: print its address, do not open a browser
    --version     print the version

Source and licence (GNU AGPL v3 or later):
  https://github.com/TylerWhittaker/monochrome-unicorn`;

/** Where a failed install's diagnostic log goes: beside the installer install.sh keeps. */
function logDir() {
  if (process.platform === 'win32') {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
      'monochrome-unicorn',
      'logs',
    );
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'monochrome-unicorn',
    'logs',
  );
}

/** Linux under WSL, whose browser is the Windows one. */
function isWsl() {
  try {
    return process.platform === 'linux' && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Hand a URL to the desktop's browser; failing quietly, as it is also printed. */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : isWsl()
          ? ['explorer.exe', [url]]
          : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The address is on screen; it can be opened by hand.
  }
}

async function gui(args) {
  const portArg = args.indexOf('--port');
  const { url, closed } = await startGui({
    staged: assets.staged,
    page: assets.page,
    version: assets.staged.version,
    port: portArg === -1 ? 0 : Number(args[portArg + 1]),
    logDir: logDir(),
  });
  console.log(`Monochrome Unicorn installer ${assets.staged.version}`);
  console.log(`\nThe installer is open in your browser at\n\n  ${url}\n`);
  console.log('Close this window, or press Quit on the page, when you are done.');
  if (!args.includes('--no-open')) openBrowser(url);
  await closed;
  return 0;
}

async function main(args) {
  if (args.includes('--version')) {
    console.log(assets.staged.version);
    return 0;
  }
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  const guiFlags = ['--gui', '--no-open', '--port'];
  const rest = args.filter((a, i) => !guiFlags.includes(a) && args[i - 1] !== '--port');
  if (args.includes('--gui') || rest.length === 0) return gui(args);
  // No dist/ to keep things in: the catalogue and the page stay in memory.
  return runCli(rest, {
    staged: assets.staged,
    help: HELP,
    logDir: logDir(),
    command: JSON.stringify(process.execPath),
  });
}

process.exitCode = await main(process.argv.slice(2));
process.exit();
