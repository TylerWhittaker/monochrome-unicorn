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
 * A deliberately small runner for the live tests.
 *
 * node:test would do the bookkeeping, but these tests share one printer,
 * which answers one request at a time and keeps state between them: a
 * suite is a story told in order (create a label, save it, open it
 * again), not a set of independent cases. So tests run one after another,
 * a suite's cleanups always run -- last registered first, whether its
 * tests passed or not -- and the printer is left as it was found.
 */

const COLOUR = process.stdout.isTTY;
const paint = (code, text) => (COLOUR ? `\x1b[${code}m${text}\x1b[0m` : text);
export const green = (t) => paint(32, t);
export const red = (t) => paint(31, t);
export const yellow = (t) => paint(33, t);
export const grey = (t) => paint(90, t);
export const bold = (t) => paint(1, t);

/** Thrown to skip the rest of a test, with the reason shown. */
export class Skip extends Error {}

export function skip(reason) {
  throw new Skip(reason);
}

/** Collect one suite's tests, as its module registers them. */
export function createSuite(name) {
  const tests = [];
  const cleanups = [];
  return {
    name,
    tests,
    cleanups,
    /** Register a test. `timeout` is in milliseconds. */
    test(title, fn, { timeout = 120000 } = {}) {
      tests.push({ title, fn, timeout });
    },
    /** Run after the suite, whatever happened; last registered runs first. */
    cleanup(fn, title = 'cleanup') {
      cleanups.push({ fn, title });
    },
  };
}

function withTimeout(promise, ms, title) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Run a suite's tests in order and report each, then its cleanups. */
export async function runSuite(suite, results) {
  console.log(`\n${bold(suite.name)}`);
  for (const t of suite.tests) {
    const started = Date.now();
    try {
      await withTimeout(Promise.resolve().then(t.fn), t.timeout, t.title);
      const ms = Date.now() - started;
      console.log(`  ${green('✓')} ${t.title} ${grey(`${(ms / 1000).toFixed(1)} s`)}`);
      results.push({ suite: suite.name, title: t.title, status: 'pass', ms });
    } catch (err) {
      if (err instanceof Skip) {
        console.log(`  ${yellow('-')} ${t.title} ${grey(`(skipped: ${err.message})`)}`);
        results.push({ suite: suite.name, title: t.title, status: 'skip', reason: err.message });
        continue;
      }
      console.log(`  ${red('✗')} ${t.title}`);
      const detail = String(err && err.stack ? err.stack : err)
        .split('\n')
        .slice(0, 8)
        .map((line) => `      ${line}`)
        .join('\n');
      console.log(red(detail));
      results.push({ suite: suite.name, title: t.title, status: 'fail', error: err });
    }
  }

  for (const c of [...suite.cleanups].reverse()) {
    try {
      await withTimeout(Promise.resolve().then(c.fn), 60000, c.title);
    } catch (err) {
      console.log(`  ${yellow('!')} ${c.title} failed: ${err.message}`);
      results.push({ suite: suite.name, title: c.title, status: 'cleanup-fail', error: err });
    }
  }
}

/** The closing tally. Returns true when nothing failed. */
export function summarise(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = results.filter((r) => r.status === 'fail' || r.status === 'cleanup-fail');
  console.log(
    `\n${bold('Summary')}: ${green(`${count('pass')} passed`)}, ` +
      `${failed.length ? red(`${count('fail')} failed`) : `${count('fail')} failed`}, ` +
      `${yellow(`${count('skip')} skipped`)}` +
      (count('cleanup-fail') ? `, ${red(`${count('cleanup-fail')} cleanups failed`)}` : ''),
  );
  for (const r of failed) console.log(red(`  ✗ ${r.suite} › ${r.title}: ${r.error?.message}`));
  return failed.length === 0;
}
