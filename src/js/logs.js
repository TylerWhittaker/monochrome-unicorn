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
 * logs.js -- Printer Settings' Syslog & alerts tool.
 *
 * The syslog as the printer keeps it, read from device.syslog.entries or
 * E:SYSLOG.TXT and shown a line at a time with its parts picked out and
 * coloured by severity; the syslog settings, with the destination list
 * edited as rows rather than as the string the printer wants; and the
 * alerts (alerts.configured) the same way, with the settings they are
 * delivered with and the two logs the alert system keeps. The parsing and
 * the strings are syslog.js; every write here is read back (writeSetting).
 */

import { el, replaceChildren, toast, confirmDialog } from './ui.js';
import { printer } from './state.js';
import { readLogs, writeSetting, sendCommandSetting, fetchStoredFile } from './printer.js';
import {
  SEVERITIES,
  SEVERITY_NAMES,
  NEEDS_ADDRESS,
  NEEDS_PORT,
  parseSyslog,
  filterEntries,
  parseSyslogConfig,
  formatSyslogConfig,
  checkSyslogRows,
  parseList,
  parseAlerts,
  formatAlerts,
  checkAlertRows,
} from './syslog.js';
import { decodeForEditing } from './filewrite.js';

/** Severity -> the colours its pill is drawn in, most severe first. */
const SEVERITY_STYLE = [
  'bg-red-700 text-white',
  'bg-red-600 text-white',
  'bg-red-100 text-red-800',
  'bg-orange-100 text-orange-800',
  'bg-amber-100 text-amber-900',
  'bg-sky-100 text-sky-800',
  'bg-ink-100 text-ink-600',
  'bg-ink-50 text-ink-400',
];

/** The factory's one alert, for putting a list back the way it came. */
const FACTORY_ALERTS = 'COLD START,SNMP,Y,N,255.255.255.255,162,N';

const card = (title, subtitle, children, id) =>
  el('section', { class: 'card overflow-hidden', id }, [
    el('div', { class: 'border-b border-ink-200 bg-ink-50/70 px-3 py-2' }, [
      el('h2', { class: 'text-[12px] font-semibold text-ink-700' }, [title]),
      subtitle ? el('p', { class: 'text-[11px] text-ink-400' }, [subtitle]) : null,
    ]),
    ...children,
  ]);

const known = (v) => v !== undefined && v !== '?';

/** What the write results say, for a toast: null when every one held. */
function failures(results) {
  const bad = results.filter(([, r]) => !r.ok);
  return bad.length ? bad.map(([name, r]) => `${name}: ${r.reason}`).join('; ') : null;
}

/** The tool: { node, load() }. Nothing is read until load(). */
export function createLogsView() {
  const state = {
    values: {},
    source: 'sgd',
    fileText: null,
    fileError: null,
    minLevel: 7,
    feature: '',
    search: '',
    newestFirst: true,
    syslogRows: [],
    alertRows: [],
    loading: false,
  };

  /* -- the log ---------------------------------------------------- */

  const sourceSelect = el('select', { class: 'field w-auto', 'aria-label': 'Log source' }, [
    el('option', { value: 'sgd' }, ['device.syslog.entries']),
    el('option', { value: 'file' }, ['E:SYSLOG.TXT']),
  ]);
  const levelSelect = el(
    'select',
    { class: 'field w-auto', 'aria-label': 'Lowest severity shown' },
    [
      el('option', { value: '7' }, ['Every severity']),
      ...SEVERITIES.slice(0, 7).map((key, i) =>
        el('option', { value: String(i) }, [`${SEVERITY_NAMES[key]} and worse`]),
      ),
    ],
  );
  const featureSelect = el('select', { class: 'field w-auto', 'aria-label': 'Feature' });
  const searchInput = el('input', {
    class: 'field w-full sm:w-56',
    type: 'search',
    placeholder: 'Search the log…',
    'aria-label': 'Search the log',
  });
  const newestBox = el('input', { type: 'checkbox', checked: true, class: 'h-3.5 w-3.5' });
  const countNode = el('span', { class: 'text-[11px] text-ink-500', dataset: { logCount: '1' } });
  const logBody = el('div', {
    class:
      'max-h-[60vh] min-h-[6rem] overflow-auto bg-white px-3 py-2 font-mono text-[12px] leading-relaxed',
    dataset: { log: '1' },
  });

  sourceSelect.addEventListener('change', () => {
    state.source = sourceSelect.value;
    if (state.source === 'file' && state.fileText === null) loadFile().then(paintLog);
    else paintLog();
  });
  levelSelect.addEventListener('change', () => {
    state.minLevel = Number(levelSelect.value);
    paintLog();
  });
  featureSelect.addEventListener('change', () => {
    state.feature = featureSelect.value;
    paintLog();
  });
  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    paintLog();
  });
  newestBox.addEventListener('change', () => {
    state.newestFirst = newestBox.checked;
    paintLog();
  });

  const logText = () =>
    state.source === 'file' ? state.fileText || '' : state.values['device.syslog.entries'] || '';

  async function loadFile() {
    try {
      const bytes = await fetchStoredFile({ dev: 'E', oname: 'SYSLOG', otype: 'TXT' });
      state.fileText = decodeForEditing(bytes).text;
      state.fileError = null;
    } catch (err) {
      state.fileText = '';
      state.fileError = err.message;
    }
  }

  /** Why the log is empty, in terms of the settings below. */
  function emptyReason() {
    const v = state.values;
    if (state.source === 'file' && state.fileError) {
      return v['device.syslog.save_local_file'] === 'yes'
        ? 'There is no E:SYSLOG.TXT yet: nothing has been logged to it.'
        : 'There is no E:SYSLOG.TXT: “Also save it to E:SYSLOG.TXT” is off, below.';
    }
    if (v['device.syslog.enable'] !== 'on') return 'Syslog is off (device.syslog.enable, below).';
    if (
      !parseSyslogConfig(v['device.syslog.configuration']).some((r) => r.destination === 'local')
    ) {
      return 'Nothing is kept on the printer: no destination below is “local”.';
    }
    return 'The log is empty.';
  }

  function paintLog() {
    const entries = parseSyslog(logText());
    const features = [...new Set(entries.map((e) => e.feature).filter(Boolean))].sort();
    replaceChildren(featureSelect, [
      el('option', { value: '' }, ['Every feature']),
      ...features.map((f) => el('option', { value: f, selected: f === state.feature }, [f])),
    ]);
    const shown = filterEntries(entries, state);
    if (state.newestFirst) shown.reverse();
    countNode.textContent =
      shown.length === entries.length
        ? `${entries.length} line${entries.length === 1 ? '' : 's'}`
        : `${shown.length} of ${entries.length} lines`;
    if (!entries.length) {
      replaceChildren(logBody, [
        el('p', { class: 'py-4 font-sans text-ink-400' }, [emptyReason()]),
      ]);
      return;
    }
    replaceChildren(
      logBody,
      shown.map((e) =>
        e.level === -1 && !e.time
          ? el('div', { class: 'text-ink-500', dataset: { entry: '-1' } }, [e.raw])
          : el(
              'div',
              {
                class: 'flex flex-wrap items-baseline gap-x-2' + (e.repeat ? ' text-ink-400' : ''),
                dataset: { entry: String(e.level) },
              },
              [
                el('span', { class: 'shrink-0 text-ink-400' }, [e.time]),
                e.host ? el('span', { class: 'shrink-0 text-ink-300' }, [e.host]) : null,
                e.repeat
                  ? null
                  : el(
                      'span',
                      {
                        class: `shrink-0 rounded px-1 text-[10px] font-sans font-semibold uppercase tracking-wide ${SEVERITY_STYLE[e.level] || 'bg-ink-100 text-ink-600'}`,
                        title: e.severity,
                      },
                      [e.severity],
                    ),
                e.repeat
                  ? null
                  : el('span', { class: 'shrink-0 text-sky-700' }, [`[${e.feature}]`]),
                e.repeat ? null : el('span', { class: 'shrink-0 text-ink-400' }, [e.code]),
                el(
                  'span',
                  { class: e.level >= 0 && e.level <= 3 ? 'text-red-800' : 'text-ink-800' },
                  [e.message],
                ),
              ],
            ),
      ),
    );
  }

  function download() {
    const blob = new Blob([logText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const day = new Date().toISOString().slice(0, 10);
    const a = el('a', { href: url, download: `${printer.name || 'printer'}-syslog-${day}.txt` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function clearLog() {
    const ok = await confirmDialog(
      'Clear the syslog?',
      'device.syslog.clear_log empties the log kept on the printer. Anything already sent to a ' +
        'syslog server stays there.',
      'Clear',
    );
    if (!ok) return;
    try {
      await sendCommandSetting('device.syslog.clear_log', '');
      toast('Cleared the syslog.', 'success');
    } catch (err) {
      toast(`Could not clear it: ${err.message}`, 'error');
    }
    await load();
  }

  const logCard = card(
    'Syslog',
    'What the printer has logged, newest first; each line’s feature, severity and code picked out.',
    [
      el('div', { class: 'toolbar' }, [
        sourceSelect,
        levelSelect,
        featureSelect,
        searchInput,
        el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, [
          newestBox,
          'Newest first',
        ]),
        el('div', { class: 'ml-auto flex items-center gap-2' }, [
          countNode,
          el('button', { class: 'btn-secondary btn-sm', onclick: () => load() }, ['Refresh']),
          el('button', { class: 'btn-secondary btn-sm', onclick: () => download() }, ['Download']),
          el('button', { class: 'btn-danger btn-sm', onclick: () => clearLog() }, ['Clear log…']),
        ]),
      ]),
      logBody,
    ],
    'syslog-viewer',
  );

  /* -- syslog settings -------------------------------------------- */

  const enableBox = el('input', {
    type: 'checkbox',
    class: 'h-3.5 w-3.5',
    'aria-label': 'Syslog on',
  });
  const saveFileBox = el('input', {
    type: 'checkbox',
    class: 'h-3.5 w-3.5',
    'aria-label': 'Also save it to E:SYSLOG.TXT',
  });
  const sizeInput = el('input', {
    class: 'field field-mono w-28',
    type: 'number',
    min: '10000',
    max: '400000',
    step: '1000',
    'aria-label': 'Largest log file, in bytes',
  });
  const destHost = el('div', { class: 'space-y-1.5' });
  const syslogProblems = el('div', { class: 'space-y-0.5' });
  const syslogPreview = el('code', {
    class: 'break-all text-[11px] text-ink-500',
    dataset: { syslogConfig: '1' },
  });
  const syslogSave = el('button', { class: 'btn-primary btn-sm', onclick: () => saveSyslog() }, [
    'Save',
  ]);

  function paintDestinations() {
    replaceChildren(
      destHost,
      state.syslogRows.length
        ? state.syslogRows.map((row, i) => {
            const sev = el(
              'select',
              {
                class: 'field w-auto py-1 text-[12px]',
                'aria-label': `Destination ${i + 1} severity`,
              },
              SEVERITIES.map((key) =>
                el('option', { value: key, selected: key === row.severity }, [
                  `${SEVERITY_NAMES[key]}${key === 'emerg' ? ' only' : ' and worse'}`,
                ]),
              ),
            );
            sev.addEventListener('change', () => {
              row.severity = sev.value;
              syncSyslog();
            });
            const where = el(
              'select',
              { class: 'field w-auto py-1 text-[12px]', 'aria-label': `Destination ${i + 1} kind` },
              [
                el('option', { value: 'local', selected: row.destination === 'local' }, [
                  'kept on the printer',
                ]),
                el('option', { value: 'server', selected: row.destination !== 'local' }, [
                  'sent to a syslog server',
                ]),
              ],
            );
            const ip = el('input', {
              class: 'field field-mono w-36 py-1 text-[12px]',
              placeholder: '192.168.1.10',
              value: row.destination === 'local' ? '' : row.destination,
              hidden: row.destination === 'local',
              'aria-label': `Destination ${i + 1} address`,
            });
            where.addEventListener('change', () => {
              row.destination = where.value === 'local' ? 'local' : ip.value;
              ip.hidden = where.value === 'local';
              syncSyslog();
            });
            ip.addEventListener('input', () => {
              row.destination = ip.value.trim();
              syncSyslog();
            });
            return el(
              'div',
              { class: 'flex flex-wrap items-center gap-2', dataset: { destination: String(i) } },
              [
                sev,
                where,
                ip,
                el(
                  'button',
                  {
                    class: 'btn-secondary btn-sm px-2',
                    title: 'Remove this destination',
                    'aria-label': `Remove destination ${i + 1}`,
                    onclick: () => {
                      state.syslogRows.splice(i, 1);
                      paintDestinations();
                    },
                  },
                  ['×'],
                ),
              ],
            );
          })
        : [
            el('p', { class: 'text-[12px] text-ink-400' }, [
              'No destinations: nothing is logged anywhere.',
            ]),
          ],
    );
    syncSyslog();
  }

  /** The settings as the form now has them, against what was read. */
  function syslogChanges() {
    const v = state.values;
    const want = {
      'device.syslog.enable': enableBox.checked ? 'on' : 'off',
      'device.syslog.save_local_file': saveFileBox.checked ? 'yes' : 'no',
      'device.syslog.log_max_file_size': String(sizeInput.value).trim(),
      'device.syslog.configuration': formatSyslogConfig(state.syslogRows),
    };
    return Object.entries(want).filter(([name, value]) => known(v[name]) && v[name] !== value);
  }

  function syncSyslog() {
    const problems = checkSyslogRows(state.syslogRows);
    const size = Number(sizeInput.value);
    if (!(size >= 10000 && size <= 400000))
      problems.push('The largest log file is 10000 to 400000 bytes.');
    replaceChildren(
      syslogProblems,
      problems.map((p) => el('p', { class: 'text-[12px] text-amber-800' }, [p])),
    );
    const config = formatSyslogConfig(state.syslogRows);
    syslogPreview.textContent = `device.syslog.configuration = "${config}"  (${config.length} of 1000)`;
    // A second local row is a warning, not an error: the printer takes it.
    const blocking = problems.filter((p) => !/first "local"/.test(p));
    syslogSave.disabled = blocking.length > 0 || syslogChanges().length === 0;
  }
  for (const input of [enableBox, saveFileBox, sizeInput])
    input.addEventListener('input', syncSyslog);
  for (const input of [enableBox, saveFileBox]) input.addEventListener('change', syncSyslog);

  async function saveSyslog() {
    syslogSave.disabled = true;
    const results = [];
    for (const [name, value] of syslogChanges())
      results.push([name, await writeSetting(name, value)]);
    const bad = failures(results);
    if (bad) toast(`Not all of it held: ${bad}`, 'error', { timeout: 10000 });
    else toast('Saved the syslog settings.', 'success');
    await load();
  }

  const syslogCard = card(
    'Syslog settings',
    'Where the printer sends its log, and how much of it it keeps.',
    [
      el('div', { class: 'space-y-3 px-3 py-3' }, [
        el('div', { class: 'flex flex-wrap items-center gap-x-6 gap-y-2' }, [
          el('label', { class: 'flex items-center gap-1.5 text-ink-700' }, [
            enableBox,
            'Syslog on',
          ]),
          el('label', { class: 'flex items-center gap-1.5 text-ink-700' }, [
            saveFileBox,
            'Also save it to E:SYSLOG.TXT',
          ]),
          el('label', { class: 'flex items-center gap-1.5 text-ink-700' }, [
            'Largest log file',
            sizeInput,
            el('span', { class: 'text-[11px] text-ink-400' }, ['bytes']),
          ]),
        ]),
        el('div', { class: 'space-y-1.5' }, [
          el('p', { class: 'label-text' }, ['Destinations']),
          destHost,
          el(
            'button',
            {
              class: 'btn-secondary btn-sm',
              onclick: () => {
                state.syslogRows.push({ severity: 'info', destination: 'local' });
                paintDestinations();
              },
            },
            ['Add destination'],
          ),
        ]),
        syslogProblems,
        syslogPreview,
        el('div', { class: 'flex justify-end' }, [syslogSave]),
      ]),
    ],
    'syslog-settings',
  );

  /* -- alerts ----------------------------------------------------- */

  const alertHost = el('div', { class: 'overflow-x-auto' });
  const alertProblems = el('div', { class: 'space-y-0.5' });
  const alertPreview = el('code', {
    class: 'break-all text-[11px] text-ink-500',
    dataset: { alertsConfig: '1' },
  });
  const alertSave = el('button', { class: 'btn-primary btn-sm', onclick: () => saveAlerts() }, [
    'Save',
  ]);
  const delivery = {
    'ip.smtp.server_addr': el('input', {
      class: 'field field-mono w-40',
      'aria-label': 'SMTP server',
    }),
    'ip.smtp.domain': el('input', { class: 'field field-mono w-40', 'aria-label': 'SMTP domain' }),
    'ip.snmp.trap_community_name': el('input', {
      class: 'field field-mono w-32',
      'aria-label': 'SNMP trap community',
    }),
  };
  for (const input of Object.values(delivery)) input.addEventListener('input', () => syncAlerts());

  const lists = () => ({
    conditions: parseList(state.values['alerts.conditions']),
    destinations: parseList(state.values['alerts.destinations']),
  });

  function paintAlerts() {
    const { conditions, destinations } = lists();
    const options = (choices, current) => [
      ...(choices.includes(current) || !current
        ? []
        : [el('option', { value: current }, [current])]),
      ...choices.map((c) => el('option', { value: c, selected: c === current }, [c])),
    ];
    const head = [
      'Condition',
      'Destination',
      'On set',
      'On clear',
      'Address',
      'Port',
      'Quelled',
      'Setting',
      '',
    ];
    replaceChildren(alertHost, [
      el('table', { class: 'w-full text-[12px]' }, [
        el('thead', {}, [
          el(
            'tr',
            { class: 'text-left text-[11px] text-ink-500' },
            head.map((h) => el('th', { class: 'px-2 py-1 font-medium' }, [h])),
          ),
        ]),
        el(
          'tbody',
          {},
          state.alertRows.map((row, i) => {
            const change = (field, value) => {
              row[field] = value;
              syncAlerts();
            };
            const select = (field, choices, label) => {
              const s = el(
                'select',
                { class: 'field w-auto py-1 text-[12px]', 'aria-label': `Alert ${i + 1} ${label}` },
                options(choices, row[field]),
              );
              s.addEventListener('change', () => {
                change(field, s.value);
                paintAlerts();
              });
              return s;
            };
            const box = (field, label, title) => {
              const b = el('input', {
                type: 'checkbox',
                checked: row[field],
                class: 'h-3.5 w-3.5',
                title,
                'aria-label': `Alert ${i + 1} ${label}`,
              });
              b.addEventListener('change', () => change(field, b.checked));
              return b;
            };
            const text = (field, label, cls, enabled = true) => {
              const t = el('input', {
                class: `field field-mono py-1 text-[12px] ${cls}`,
                value: row[field] || '',
                disabled: !enabled,
                'aria-label': `Alert ${i + 1} ${label}`,
              });
              t.addEventListener('input', () => change(field, t.value));
              return t;
            };
            return el('tr', { class: 'border-t border-ink-100', dataset: { alert: String(i) } }, [
              el('td', { class: 'px-2 py-1' }, [select('condition', conditions, 'condition')]),
              el('td', { class: 'px-2 py-1' }, [
                select('destination', destinations, 'destination'),
              ]),
              el('td', { class: 'px-2 py-1 text-center' }, [
                box('onSet', 'on set', 'Send it when the condition starts'),
              ]),
              el('td', { class: 'px-2 py-1 text-center' }, [
                box('onClear', 'on clear', 'Send it when the condition ends'),
              ]),
              el('td', { class: 'px-2 py-1' }, [
                text('address', 'address', 'w-44', NEEDS_ADDRESS.includes(row.destination)),
              ]),
              el('td', { class: 'px-2 py-1' }, [
                text('port', 'port', 'w-16', NEEDS_PORT.includes(row.destination)),
              ]),
              el('td', { class: 'px-2 py-1 text-center' }, [
                box(
                  'quelling',
                  'quelled',
                  'Kept, but not sent: the alert is configured and silenced',
                ),
              ]),
              el('td', { class: 'px-2 py-1' }, [
                text('sgd', 'setting', 'w-36', row.condition === 'SGD SET'),
              ]),
              el('td', { class: 'px-2 py-1' }, [
                el(
                  'button',
                  {
                    class: 'btn-secondary btn-sm px-2',
                    'aria-label': `Remove alert ${i + 1}`,
                    onclick: () => {
                      state.alertRows.splice(i, 1);
                      paintAlerts();
                    },
                  },
                  ['×'],
                ),
              ]),
            ]);
          }),
        ),
      ]),
      state.alertRows.length
        ? null
        : el('p', { class: 'px-2 py-2 text-[12px] text-ink-400' }, [
            'No alerts: the printer sends none.',
          ]),
    ]);
    syncAlerts();
  }

  function alertChanges() {
    const v = state.values;
    const want = { 'alerts.configured': formatAlerts(state.alertRows) };
    for (const [name, input] of Object.entries(delivery)) want[name] = input.value.trim();
    return Object.entries(want).filter(([name, value]) => known(v[name]) && v[name] !== value);
  }

  function syncAlerts() {
    const problems = checkAlertRows(state.alertRows, lists());
    replaceChildren(
      alertProblems,
      problems.map((p) => el('p', { class: 'text-[12px] text-amber-800' }, [p])),
    );
    const config = formatAlerts(state.alertRows);
    alertPreview.textContent = `alerts.configured = "${config}"`;
    alertSave.disabled = problems.length > 0 || alertChanges().length === 0;
  }

  async function saveAlerts() {
    alertSave.disabled = true;
    const results = [];
    for (const [name, value] of alertChanges())
      results.push([name, await writeSetting(name, value)]);
    const bad = failures(results);
    if (bad) toast(`Not all of it held: ${bad}`, 'error', { timeout: 10000 });
    else toast('Saved the alerts.', 'success');
    await load();
  }

  /** One of the alert system's own logs, with its clear command. */
  function alertLog(title, name, clearName) {
    const pre = el('pre', {
      class:
        'max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] text-ink-700',
      dataset: { alertLog: name },
    });
    const node = el('details', { class: 'border-t border-ink-200' }, [
      el('summary', { class: 'cursor-pointer px-3 py-2 text-[12px] text-ink-700' }, [title]),
      pre,
      el('div', { class: 'flex justify-end px-3 pb-2' }, [
        el(
          'button',
          {
            class: 'btn-secondary btn-sm',
            onclick: async () => {
              if (
                !(await confirmDialog(
                  `Clear the ${title.toLowerCase()}?`,
                  `${clearName} empties it.`,
                  'Clear',
                ))
              ) {
                return;
              }
              try {
                await sendCommandSetting(clearName, '');
              } catch (err) {
                toast(`Could not clear it: ${err.message}`, 'error');
              }
              await load();
            },
          },
          ['Clear'],
        ),
      ]),
    ]);
    return {
      node,
      paint() {
        const text = state.values[name];
        pre.textContent = known(text) && text.trim() ? text : '(empty)';
      },
    };
  }
  const httpLog = alertLog(
    'HTTP-POST alert log',
    'alerts.http.logging.entries',
    'alerts.http.logging.clear',
  );
  const trackedLog = alertLog(
    'Tracked settings log',
    'alerts.tracked_settings.log_tracked',
    'alerts.tracked_settings.clear_log',
  );

  const alertsCard = card(
    'Alerts',
    'What the printer reports, and where to: each condition, sent when it starts, ends, or both.',
    [
      el('div', { class: 'space-y-3 px-3 py-3' }, [
        alertHost,
        el('div', { class: 'flex flex-wrap gap-2' }, [
          el(
            'button',
            {
              class: 'btn-secondary btn-sm',
              onclick: () => {
                state.alertRows.push({
                  condition: 'PAPER OUT',
                  destination: 'SNMP',
                  onSet: true,
                  onClear: false,
                  address: '255.255.255.255',
                  port: '162',
                  quelling: false,
                  sgd: '',
                });
                paintAlerts();
              },
            },
            ['Add alert'],
          ),
          el(
            'button',
            {
              class: 'btn-secondary btn-sm',
              title: FACTORY_ALERTS,
              onclick: () => {
                state.alertRows = parseAlerts(FACTORY_ALERTS);
                paintAlerts();
              },
            },
            ['Factory alerts'],
          ),
        ]),
        el('div', { class: 'grid gap-2 sm:grid-cols-3' }, [
          el('label', { class: 'block space-y-1' }, [
            el('span', { class: 'label-text' }, ['E-mail: SMTP server']),
            delivery['ip.smtp.server_addr'],
          ]),
          el('label', { class: 'block space-y-1' }, [
            el('span', { class: 'label-text' }, ['E-mail: domain']),
            delivery['ip.smtp.domain'],
          ]),
          el('label', { class: 'block space-y-1' }, [
            el('span', { class: 'label-text' }, ['SNMP trap community']),
            delivery['ip.snmp.trap_community_name'],
          ]),
        ]),
        alertProblems,
        alertPreview,
        el('div', { class: 'flex justify-end' }, [alertSave]),
      ]),
      httpLog.node,
      trackedLog.node,
    ],
    'alerts-settings',
  );

  /* -- reading ---------------------------------------------------- */

  const status = el('p', { class: 'text-[12px] text-ink-400' }, ['Reading the syslog and alerts…']);

  async function load() {
    if (state.loading) return;
    state.loading = true;
    status.hidden = false;
    try {
      state.values = await readLogs();
      if (state.source === 'file') await loadFile();
      else state.fileText = null;
      status.hidden = true;
    } catch (err) {
      status.textContent = `Could not read them: ${err.message}`;
      status.className = 'text-[12px] text-red-700';
      return;
    } finally {
      state.loading = false;
    }
    const v = state.values;
    enableBox.checked = v['device.syslog.enable'] === 'on';
    saveFileBox.checked = v['device.syslog.save_local_file'] === 'yes';
    sizeInput.value = known(v['device.syslog.log_max_file_size'])
      ? v['device.syslog.log_max_file_size']
      : '';
    state.syslogRows = parseSyslogConfig(v['device.syslog.configuration']);
    state.alertRows = parseAlerts(v['alerts.configured']);
    for (const [name, input] of Object.entries(delivery)) {
      input.value = known(v[name]) ? v[name] : '';
      input.disabled = !known(v[name]);
    }
    paintLog();
    paintDestinations();
    paintAlerts();
    httpLog.paint();
    trackedLog.paint();
  }

  const node = el('div', { class: 'space-y-3', id: 'logs-tool' }, [
    status,
    logCard,
    syslogCard,
    alertsCard,
  ]);
  return { node, load };
}
