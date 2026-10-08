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
 * state.js -- facts about the printer that every mode needs.
 *
 * Populated once at startup from the two inlined blocks in INDEX.SHTML:
 * the SGD schema captured at build time, and the boot values the SSI
 * preprocessor filled in when this page was served.
 */

import { parseVarFile, setBranchFiles } from './printer.js';

export const printer = {
  /** Compact SGD catalogue: {settings, ranges, types, access, branches, slow}. */
  schema: null,
  /** Live values read at page load, keyed by SGD name. */
  boot: {},
  /** Printhead resolution in dots per inch; drives every unit conversion. */
  dpi: 203,
  /** The label loaded, in dots, as far as the printer says: {width, height}. */
  labelSize: {},
  name: 'Zebra Printer',
  model: '',
  serial: '',
  status: '',
  firmware: '',
  ip: '',
};

/** Read the inlined <script> blocks. Safe to call once, at startup. */
export function initState(document) {
  const schemaNode = document.getElementById('sgd-schema');
  if (schemaNode) {
    try {
      printer.schema = JSON.parse(schemaNode.textContent);
      setBranchFiles(printer.schema.branchFiles);
    } catch (err) {
      console.error('Inlined SGD schema is not valid JSON', err);
    }
  }

  const bootNode = document.getElementById('boot-vars');
  if (bootNode) printer.boot = parseVarFile(bootNode.textContent);

  const boot = printer.boot;
  printer.model = boot['device.product_name'] || '';
  printer.name = boot['device.friendly_name'] || printer.model || 'Zebra Printer';
  printer.serial = boot['device.unique_id'] || '';
  printer.firmware = boot['appl.name'] || '';
  printer.ip = activeIpAddress(boot);
  printer.status = parseHostStatus(boot['device.host_status']);

  const dpi = parseInt(boot['head.resolution.in_dpi'], 10);
  if (Number.isFinite(dpi) && dpi > 0) printer.dpi = dpi;

  printer.labelSize = loadedLabelSize(boot);

  return printer;
}

/**
 * The label the printer is set up for, in dots: ezpl.print_width across
 * and zpl.label_length down. Either one missing or nonsense is left out,
 * and a new label falls back to 4x6 inches for it.
 */
export function loadedLabelSize(boot) {
  const dots = (name) => {
    const n = parseInt(boot[name], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return { width: dots('ezpl.print_width'), height: dots('zpl.label_length') };
}

/** Where each value of ip.active_network keeps its address. */
const ADDRESS_BY_NETWORK = {
  wireless: 'wlan.ip.addr',
  internal_wired: 'internal_wired.ip.addr',
};

/**
 * The address the printer is actually reachable on.
 *
 * ip.addr is not it: on a printer with both interfaces it follows the
 * wireless one, so a printer on Ethernet reports 0.0.0.0 there.
 * ip.active_network names the interface in use, and each keeps its own
 * address. ip.addr is only the fallback, for a network this does not know
 * or a printer too old to say.
 */
export function activeIpAddress(boot) {
  const network = String(boot['ip.active_network'] || '')
    .trim()
    .toLowerCase()
    // The catalogue spells it "internal wired"; printers answer "internal_wired".
    .replace(/\s+/g, '_');
  const own = (boot[ADDRESS_BY_NETWORK[network]] || '').trim();
  if (own && own !== '0.0.0.0') return own;
  return (boot['ip.addr'] || '').trim();
}

/**
 * device.host_status is the ~HS three-line reply. On the first line the
 * second comma-separated field is the paper-out flag and the third is
 * pause; on the second line the third is head up and the fourth ribbon
 * out. head.latch and media.status, where they were read (`more`), say
 * the same in words. The worst condition wins; otherwise it is ready.
 */
export function parseHostStatus(raw, more = {}) {
  if (!raw) return 'unknown';
  const [first = '', second = ''] = String(raw).split(/[\r\n]+/);
  const one = first.split(',');
  const two = second.split(',');
  if (two[2] === '1' || more['head.latch'] === 'open') return 'head open';
  if (one[1] === '1' || more['media.status'] === 'out') return 'paper out';
  if (two[3] === '1') return 'ribbon out';
  if (one[2] === '1') return 'paused';
  return 'ready';
}

/** Look up one setting's schema entry, expanded into named fields. */
export function settingMeta(name) {
  const schema = printer.schema;
  if (!schema) return null;
  const entry = schema.settings[name];
  if (!entry) return null;
  const [typeId, rangeId, accessId, def] = entry;
  return {
    name,
    type: schema.types[typeId],
    range: schema.ranges[rangeId] || '',
    access: schema.access[accessId],
    default: def,
    writable: schema.access[accessId].includes('W'),
    readable: schema.access[accessId].includes('R'),
  };
}

/** Every setting, expanded, in catalogue order. */
export function allSettings() {
  const schema = printer.schema;
  if (!schema) return [];
  return Object.keys(schema.settings).map(settingMeta);
}

/* ------------------------------------------------------------------ *
 * Units
 *
 * ZPL positions everything in dots, but people think in inches or
 * millimetres, so the editors convert at the edges.
 * ------------------------------------------------------------------ */

export const UNITS = ['in', 'mm', 'dots'];

export function toDots(value, unit, dpi = printer.dpi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (unit === 'in') return Math.round(n * dpi);
  if (unit === 'mm') return Math.round((n * dpi) / 25.4);
  return Math.round(n);
}

export function fromDots(dots, unit, dpi = printer.dpi) {
  const n = Number(dots) || 0;
  if (unit === 'in') return Math.round((n / dpi) * 1000) / 1000;
  if (unit === 'mm') return Math.round((n / dpi) * 25.4 * 100) / 100;
  return Math.round(n);
}

/** A sensible step size for a numeric input in the given unit. */
export function unitStep(unit) {
  if (unit === 'in') return 0.05;
  if (unit === 'mm') return 1;
  return 1;
}

/**
 * Step of exactly one dot, for the fields that are a handful of dots
 * across -- bar module widths, line thicknesses. A 0.05in step there
 * would jump fifteen dots at a time.
 */
export function unitStepFine(unit, dpi = printer.dpi) {
  return fromDots(1, unit, dpi) || 0.001;
}

/* ------------------------------------------------------------------ *
 * Unit preference
 *
 * Which unit you think in is a property of you, not of the label, so it
 * outlives both the document and the page.
 * ------------------------------------------------------------------ */

const UNIT_KEY = 'zebra.unit';

/** This page's choice, so it holds even where storage does not. */
let unitChoice = null;

export function loadUnitPreference() {
  if (unitChoice) return unitChoice;
  try {
    const stored = localStorage.getItem(UNIT_KEY);
    return UNITS.includes(stored) ? stored : 'in';
  } catch (err) {
    return 'in';
  }
}

export function saveUnitPreference(unit) {
  if (UNITS.includes(unit)) unitChoice = unit;
  try {
    localStorage.setItem(UNIT_KEY, unit);
  } catch (err) {
    /* private mode; the choice just will not persist */
  }
}
