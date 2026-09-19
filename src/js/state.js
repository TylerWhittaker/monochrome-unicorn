/*
 * state.js -- facts about the printer that every mode needs.
 *
 * Populated once at startup from the two inlined blocks in INDEX.SHTML:
 * the SGD schema captured at build time, and the boot values the SSI
 * preprocessor filled in when this page was served.
 */

import { parseVarFile } from './printer.js';

export const printer = {
  /** Compact SGD catalogue: {settings, ranges, types, access, branches, slow}. */
  schema: null,
  /** Live values read at page load, keyed by SGD name. */
  boot: {},
  /** Printhead resolution in dots per inch; drives every unit conversion. */
  dpi: 203,
  name: 'Zebra Printer',
  model: '',
  serial: '',
  status: '',
  firmware: '',
};

/** Read the inlined <script> blocks. Safe to call once, at startup. */
export function initState(document) {
  const schemaNode = document.getElementById('sgd-schema');
  if (schemaNode) {
    try {
      printer.schema = JSON.parse(schemaNode.textContent);
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
  printer.status = parseHostStatus(boot['device.host_status']);

  const dpi = parseInt(boot['head.resolution.in_dpi'], 10);
  if (Number.isFinite(dpi) && dpi > 0) printer.dpi = dpi;

  return printer;
}

/**
 * device.host_status is the ~HS three-line reply. The first line's third
 * comma-separated field is the paper-out flag and the fourth is pause;
 * anything else we summarise as ready.
 */
export function parseHostStatus(raw) {
  if (!raw) return 'unknown';
  const first = String(raw).split(/[\r\n]+/)[0] || '';
  const fields = first.split(',');
  if (fields[1] === '1') return 'paper out';
  if (fields[2] === '1') return 'paused';
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
