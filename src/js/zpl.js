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
 * zpl.js -- the label document model, plus ZPL generation and parsing.
 *
 * The visual editor works on a plain object; the source editor works on
 * ZPL text. Both directions have to exist so the two views can be toggled,
 * and parsing is the harder half: ZPL is a printer control language, not a
 * document format, so parseZpl() recognises the subset this editor emits
 * (plus the common shapes people actually write) and reports everything
 * else as unsupported rather than quietly dropping it.
 */

/* ------------------------------------------------------------------ *
 * Barcode symbologies
 * ------------------------------------------------------------------ */

/*
 * `kind` is how the canvas draws one: '1d' as bars, '2d' as a matrix.
 * `sizes` is which of the size controls mean anything to it -- bar
 * `height`, `module` width from ^BY, the wide:narrow `ratio`, the
 * interpretation line (`text`), `mag`nification -- so the inspector
 * offers only those. `example` is data it will accept, for a new one.
 */
export const SYMBOLOGIES = {
  code128: {
    label: 'Code 128',
    cmd: 'BC',
    kind: '1d',
    sizes: ['height', 'module', 'text'],
    example: '12345678',
  },
  gs1_128: {
    label: 'GS1-128 (UCC/EAN-128)',
    cmd: 'BC',
    kind: '1d',
    sizes: ['height', 'module', 'text'],
    example: '(01)12345678901231',
  },
  code39: {
    label: 'Code 39',
    cmd: 'B3',
    kind: '1d',
    sizes: ['height', 'module', 'ratio', 'text'],
    example: 'ABC123',
  },
  code93: {
    label: 'Code 93',
    cmd: 'BA',
    kind: '1d',
    sizes: ['height', 'module', 'text'],
    example: 'ABC123',
  },
  i2of5: {
    label: 'Interleaved 2 of 5',
    cmd: 'B2',
    kind: '1d',
    sizes: ['height', 'module', 'ratio', 'text'],
    example: '12345678',
  },
  codabar: {
    label: 'Codabar',
    cmd: 'BK',
    kind: '1d',
    sizes: ['height', 'module', 'ratio', 'text'],
    example: '123456',
  },
  ean13: {
    label: 'EAN-13',
    cmd: 'BE',
    kind: '1d',
    sizes: ['height', 'module', 'text'],
    example: '123456789012',
  },
  ean8: {
    label: 'EAN-8',
    cmd: 'B8',
    kind: '1d',
    sizes: ['height', 'module', 'text'],
    example: '1234567',
  },
  upca: {
    label: 'UPC-A',
    cmd: 'BU',
    kind: '1d',
    sizes: ['height', 'module', 'text'],
    example: '12345678901',
  },
  upce: {
    label: 'UPC-E',
    cmd: 'B9',
    kind: '1d',
    sizes: ['height', 'module', 'text'],
    example: '1230000045',
  },
  databar: {
    label: 'GS1 DataBar',
    cmd: 'BR',
    kind: '1d',
    sizes: ['mag'],
    example: '1234567890123',
  },
  postnet: {
    label: 'USPS POSTNET',
    cmd: 'BZ',
    kind: '1d',
    sizes: ['height', 'text'],
    example: '12345',
  },
  planet: {
    label: 'USPS PLANET',
    cmd: 'BZ',
    kind: '1d',
    sizes: ['height', 'text'],
    example: '12345678901',
  },
  imb: {
    label: 'USPS Intelligent Mail',
    cmd: 'BZ',
    kind: '1d',
    sizes: ['height', 'text'],
    example: '0123456709498765432101234567891',
  },
  qr: { label: 'QR Code', cmd: 'BQ', kind: '2d', sizes: ['mag'], example: '12345678' },
  datamatrix: {
    label: 'Data Matrix',
    cmd: 'BX',
    kind: '2d',
    sizes: ['module'],
    example: '12345678',
  },
  pdf417: {
    label: 'PDF417',
    cmd: 'B7',
    kind: '2d',
    sizes: ['height', 'module'],
    example: '12345678',
  },
  micropdf: {
    label: 'MicroPDF417',
    cmd: 'BF',
    kind: '2d',
    sizes: ['height', 'module'],
    example: '12345678',
  },
  aztec: { label: 'Aztec', cmd: 'B0', kind: '2d', sizes: ['mag'], example: '12345678' },
  maxicode: { label: 'MaxiCode', cmd: 'BD', kind: '2d', sizes: [], example: 'MAXICODE 12345' },
};

/** The GS1 DataBar family, the second argument of ^BR. */
export const DATABAR_TYPES = [
  { value: 1, label: 'Omnidirectional' },
  { value: 2, label: 'Truncated' },
  { value: 3, label: 'Stacked' },
  { value: 4, label: 'Stacked Omnidirectional' },
  { value: 5, label: 'Limited' },
  { value: 6, label: 'Expanded' },
];

/** ^BZ's last argument says which of the postal codes it draws. */
const POSTAL_TYPES = { postnet: 0, planet: 1, imb: 3 };

/**
 * The symbology a barcode command draws. Mostly the command alone, but
 * ^BC in UCC/EAN mode is GS1-128 and ^BZ is three postal codes.
 */
function symbologyFor(cmd, args) {
  if (cmd === 'BC' && (args[5] || '').trim().toUpperCase() === 'D') return 'gs1_128';
  if (cmd === 'BZ') {
    const type = num(args[4], 0);
    return Object.keys(POSTAL_TYPES).find((k) => POSTAL_TYPES[k] === type) || 'postnet';
  }
  if (cmd === 'B5') return 'planet';
  return Object.keys(SYMBOLOGIES).find((key) => SYMBOLOGIES[key].cmd === cmd) || null;
}

export const ROTATIONS = [
  { value: 'N', label: 'Normal' },
  { value: 'R', label: 'Rotated 90°' },
  { value: 'I', label: 'Inverted 180°' },
  { value: 'B', label: 'Bottom-up 270°' },
];

/**
 * The scalable built-in font, plus the bitmap ones people still use. A
 * TrueType font stored on the printer is named by its path instead
 * ("E:TT0003M_.TTF") and recalled with ^A@.
 */
export const FONTS = [
  { value: '0', label: 'Scalable (0)' },
  { value: 'A', label: 'A — 9x5' },
  { value: 'B', label: 'B — 11x7' },
  { value: 'D', label: 'D — 18x10' },
  { value: 'E', label: 'E — 28x15 OCR-B' },
  { value: 'F', label: 'F — 26x13' },
  { value: 'G', label: 'G — 60x40' },
  { value: 'H', label: 'H — 21x13 OCR-A' },
];

/** Whether a font value names a stored file rather than a built-in font. */
export function isStoredFont(font) {
  return String(font || '').includes(':');
}

/** Stored TrueType fonts, from a drive listing, for the font lists. */
export function storedFonts(files) {
  return (
    (files || [])
      .filter((f) => ['TTF', 'TTE'].includes(f.otype))
      // Z:0.TTF is font 0 itself, which the list already has.
      .filter((f) => !(f.dev === 'Z' && f.oname === '0'))
      .filter((f, i, all) => all.findIndex((g) => g.name === f.name) === i)
      .map((f) => ({ value: f.name, label: `${f.oname} (${f.dev}: TrueType)` }))
  );
}

/** ^FP: which way a text field's characters run. */
export const TEXT_DIRECTIONS = [
  { value: 'H', label: 'Horizontal' },
  { value: 'V', label: 'Vertical (stacked)' },
  { value: 'R', label: 'Reverse (right to left)' },
];

/*
 * Date and time fields.
 *
 * ^FC names the clock indicator (normally %) for one field, and the
 * printer then replaces "%d", "%Y" and the rest in that field's ^FD with
 * its real-time clock as the label is formatted. Without the ^FC in the
 * same field the codes print as typed.
 */
export const DATE_FORMATS = [
  { value: '%m/%d/%Y', label: '01/31/2026' },
  { value: '%d/%m/%Y', label: '31/01/2026' },
  { value: '%Y-%m-%d', label: '2026-01-31' },
  { value: '%m/%d/%y', label: '01/31/26' },
  { value: '%d %b %Y', label: '31 Jan 2026' },
  { value: '%B %d, %Y', label: 'January 31, 2026' },
  { value: '%a %d %b %Y', label: 'Sat 31 Jan 2026' },
  { value: '%m/%d/%Y %H:%M', label: '01/31/2026 14:05' },
  { value: '%Y-%m-%d %H:%M:%S', label: '2026-01-31 14:05:09' },
  { value: '%I:%M %p', label: '02:05 PM' },
  { value: '%H:%M', label: '14:05' },
  { value: '%y%j', label: '26031 (year + day of year)' },
];

/** The command characters the manual lists, and what each becomes. */
export const CLOCK_CODES = [
  ['a', 'weekday, short'],
  ['A', 'weekday'],
  ['b', 'month, short'],
  ['B', 'month'],
  ['d', 'day of month, 01-31'],
  ['H', 'hour, 00-23'],
  ['I', 'hour, 01-12'],
  ['j', 'day of year, 001-366'],
  ['m', 'month, 01-12'],
  ['M', 'minute'],
  ['p', 'AM or PM'],
  ['S', 'second'],
  ['U', 'week of year, from Sunday'],
  ['W', 'week of year, from Monday'],
  ['w', 'day of week, 00 = Sunday'],
  ['y', 'year, 2 digits'],
  ['Y', 'year, 4 digits'],
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The primary indicator from ^FC's arguments ("%", or "%,{,#"). */
export function primaryClockIndicator(clock) {
  return String(clock || '%')[0] || '%';
}

/**
 * What a clock field will print at `date`, for the canvas.
 *
 * Only the primary clock is expanded: the secondary and third are the
 * primary plus a ^SO offset that lives in the printer, not the label, so
 * their codes are left as written. The preview shows the real thing.
 */
export function expandClock(format, clock, date = new Date()) {
  const ind = primaryClockIndicator(clock);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const dayOfYear =
    Math.round(
      (new Date(date.getFullYear(), date.getMonth(), date.getDate()) - startOfYear) / 86400000,
    ) + 1;
  // Week 01 starts on the year's first Sunday (%U) or Monday (%W); the
  // days before it are week 00.
  const week = (firstDay) => {
    const offset = (7 + firstDay - startOfYear.getDay()) % 7;
    return Math.floor((dayOfYear - 1 - offset + 7) / 7);
  };
  const hour12 = date.getHours() % 12 || 12;
  const codes = {
    a: WEEKDAYS[date.getDay()].slice(0, 3),
    A: WEEKDAYS[date.getDay()],
    b: MONTHS[date.getMonth()].slice(0, 3),
    B: MONTHS[date.getMonth()],
    d: pad(date.getDate()),
    H: pad(date.getHours()),
    I: pad(hour12),
    j: pad(dayOfYear, 3),
    m: pad(date.getMonth() + 1),
    M: pad(date.getMinutes()),
    p: date.getHours() < 12 ? 'AM' : 'PM',
    S: pad(date.getSeconds()),
    U: pad(week(0)),
    W: pad(week(1)),
    w: pad(date.getDay()),
    y: pad(date.getFullYear() % 100),
    Y: String(date.getFullYear()),
  };
  let out = '';
  const text = String(format);
  for (let i = 0; i < text.length; i++) {
    const code = text[i] === ind ? codes[text[i + 1]] : undefined;
    if (code !== undefined) {
      out += code;
      i++;
    } else {
      out += text[i];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Document
 * ------------------------------------------------------------------ */

let nextId = 1;
export function elementId() {
  return `el${nextId++}`;
}

/**
 * A blank label at the printer's resolution: the size given, in dots, or
 * 4x6 inches for whatever is not.
 */
export function newLabel(dpi = 203, { width, height } = {}) {
  return {
    width: width || Math.round(4 * dpi),
    height: height || Math.round(6 * dpi),
    unit: 'in',
    orientation: 'N',
    darkness: null,
    speed: null,
    mediaType: null,
    homeX: 0,
    homeY: 0,
    copies: 1,
    elements: [],
    /** ZPL we parsed but do not model; preserved so a round-trip is lossless. */
    passthrough: [],
  };
}

export function newElement(type, doc, dpi = 203) {
  const base = {
    id: elementId(),
    type,
    x: Math.round(dpi * 0.2),
    y: Math.round(dpi * 0.2),
    rotation: 'N',
  };
  if (type === 'text') {
    return {
      ...base,
      font: '0',
      height: Math.round(dpi * 0.2),
      width: 0,
      text: 'Text',
      blockWidth: 0,
      reverse: false,
    };
  }
  if (type === 'serial') {
    // A text field that counts: ^SN in place of ^FD.
    return {
      ...newElement('text', doc, dpi),
      text: '0001',
      serial: { step: 1, zeros: true },
    };
  }
  if (type === 'barcode') {
    return {
      ...base,
      symbology: 'code128',
      data: SYMBOLOGIES.code128.example,
      height: Math.round(dpi * 0.4),
      moduleWidth: Math.max(2, Math.round(dpi / 100)),
      ratio: 3,
      showText: true,
      magnification: 4,
      errorLevel: 'Q',
      databarType: 1,
    };
  }
  if (type === 'image') {
    return { ...base, source: '', scaleX: 1, scaleY: 1 };
  }
  if (type === 'box') {
    return {
      ...base,
      w: Math.round(dpi),
      h: Math.round(dpi * 0.5),
      thickness: 3,
      rounding: 0,
      invert: false,
    };
  }
  if (type === 'ellipse') {
    return { ...base, w: Math.round(dpi), h: Math.round(dpi * 0.6), thickness: 3, invert: false };
  }
  if (type === 'line') {
    // `diagonal` lines use w, h and lean; the others length and vertical.
    return {
      ...base,
      length: Math.round(dpi * 1.5),
      thickness: 3,
      vertical: false,
      diagonal: false,
      w: Math.round(dpi),
      h: Math.round(dpi * 0.5),
      lean: 'R',
    };
  }
  if (type === 'field') {
    return {
      ...base,
      font: '0',
      height: Math.round(dpi * 0.15),
      width: 0,
      number: 1,
      name: '',
      initial: '',
    };
  }
  if (type === 'date') {
    return {
      ...base,
      font: '0',
      height: Math.round(dpi * 0.15),
      width: 0,
      format: DATE_FORMATS[0].value,
      clock: '%',
      blockWidth: 0,
      reverse: false,
    };
  }
  throw new Error(`Unknown element type: ${type}`);
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

/**
 * Escape field data for ^FD. With ^FH active, "_xx" is a hex escape, so
 * the three characters that would otherwise be read as commands (and the
 * escape character itself) are encoded.
 */
export function escapeFieldData(text) {
  return String(text).replace(
    /[\^~_\\]/g,
    (c) => '_' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
}

/** ^A for a built-in font, ^A@ for one stored on the printer. */
function fontZpl(item) {
  const size = `${item.height},${item.width || item.height}`;
  return isStoredFont(item.font)
    ? `^A@${item.rotation},${size},${item.font}`
    : `^A${item.font}${item.rotation},${size}`;
}

/*
 * ^SN's starting value is an argument, not field data: no ^FH escapes
 * reach it, and a comma would end it. So those, and the characters that
 * would start a command, are dropped.
 */
export function serialStart(text) {
  return String(text).replace(/[\^~,\r\n]/g, '');
}

/**
 * A field's data: ^FD, or ^SN where the value counts up (or down) by
 * `step` on each label, keeping its width when `zeros` is set.
 */
function dataZpl(item, data) {
  if (item.serial) {
    const step = Math.round(Number(item.serial.step)) || 1;
    return `^SN${serialStart(data)},${step},${item.serial.zeros ? 'Y' : 'N'}`;
  }
  return `^FH^FD${escapeFieldData(data)}`;
}

function textZpl(item) {
  const parts = [`^FO${item.x},${item.y}`];
  parts.push(fontZpl(item));
  if (item.direction === 'V' || item.direction === 'R') parts.push(`^FP${item.direction},0`);
  if (item.blockWidth > 0) {
    parts.push(`^FB${item.blockWidth},${item.blockLines || 4},0,${item.justify || 'L'},0`);
  }
  if (item.reverse) parts.push('^FR');
  parts.push(`${dataZpl(item, item.text)}^FS`);
  return parts.join('');
}

function barcodeZpl(item) {
  const spec = SYMBOLOGIES[item.symbology] || SYMBOLOGIES.code128;
  const pos = `^FO${item.x},${item.y}`;
  const show = item.showText ? 'Y' : 'N';

  const data = `${dataZpl(item, item.data)}^FS`;

  if (item.symbology === 'qr') {
    // ^BQ takes the model and magnification; the data carries the error
    // correction level and input mode as a "LA," style prefix.
    const level = ['H', 'Q', 'M', 'L'].includes(item.errorLevel) ? item.errorLevel : 'Q';
    return `${pos}^BQ${item.rotation},2,${item.magnification}^FH^FD${level}A,${escapeFieldData(item.data)}^FS`;
  }
  if (item.symbology === 'datamatrix') {
    return `${pos}^BX${item.rotation},${item.moduleWidth},200${data}`;
  }
  if (item.symbology === 'pdf417') {
    return `${pos}^B7${item.rotation},${item.moduleWidth},5,,${Math.max(3, Math.round(item.height / 10))},N${data}`;
  }
  if (item.symbology === 'aztec') {
    return `${pos}^B0${item.rotation},${item.magnification},N,0,N,1${data}`;
  }
  if (item.symbology === 'maxicode') {
    // Mode 4 is the standard symbol for any data; 2 and 3 want a
    // structured carrier message. ^BD has no rotation.
    return `${pos}^BD${item.maxiMode || 4},1,1${data}`;
  }
  if (item.symbology === 'micropdf') {
    // ^BF's height is per row; the width of a module comes from ^BY.
    return `${pos}^BY${item.moduleWidth}^BF${item.rotation},${item.height},0${data}`;
  }
  if (item.symbology === 'databar') {
    const type = item.databarType || 1;
    return `${pos}^BR${item.rotation},${type},${item.magnification},1,${item.height || 25},22${data}`;
  }

  // 1D symbologies share ^BY for module width and ratio.
  const by = `^BY${item.moduleWidth},${item.ratio},${item.height}`;
  const cmd = spec.cmd;
  let params;
  if (item.symbology === 'gs1_128') params = `${item.rotation},${item.height},${show},N,N,D`;
  else if (cmd === 'BC') params = `${item.rotation},${item.height},${show},N,N`;
  else if (cmd === 'B3') params = `${item.rotation},N,${item.height},${show},N`;
  else if (cmd === 'BA') params = `${item.rotation},${item.height},${show},N,N`;
  else if (cmd === 'B2') params = `${item.rotation},${item.height},${show},N,N`;
  else if (cmd === 'BK') params = `${item.rotation},N,${item.height},${show},N,A,A`;
  else if (cmd === 'BZ') {
    params = `${item.rotation},${item.height},${show},N,${POSTAL_TYPES[item.symbology] || 0}`;
  } else params = `${item.rotation},${item.height},${show},N`;
  return `${pos}${by}^${cmd}${params}${data}`;
}

/**
 * A ^FN placeholder: the variable part of a stored format. The position
 * and font live here; the data is supplied later, either by the printer's
 * host or by the Stored Formats mode.
 */
function fieldZpl(item) {
  const parts = [`^FO${item.x},${item.y}`];
  parts.push(fontZpl(item));
  parts.push(`^FN${item.number}` + (item.name ? `"${item.name}"` : ''));
  if (item.initial) parts.push(`^FH^FD${escapeFieldData(item.initial)}`);
  parts.push('^FS');
  return parts.join('');
}

/**
 * A date or time, filled in from the printer's clock as it prints. Laid
 * out exactly like text, with the ^FC that makes the printer read the
 * codes in its data.
 */
function dateZpl(item) {
  return withClock(textZpl({ ...item, text: item.format }), item.clock || '%');
}

/**
 * Put a ^FC read from someone else's label back where it was: ahead of
 * the field's data, or of its ^FN when it has none.
 */
function withClock(zpl, clock) {
  if (!clock) return zpl;
  const at = zpl.search(/\^FN|\^FH\^FD/);
  return at === -1 ? zpl : `${zpl.slice(0, at)}^FC${clock}${zpl.slice(at)}`;
}

/**
 * ^XG recalls a stored .GRF and can scale it; ^IM places the other
 * formats at their own size. Which one is right follows the extension.
 */
function imageZpl(item) {
  if (!item.source) return '';
  const pos = `^FO${item.x},${item.y}`;
  if (/\.GRF$/i.test(item.source)) {
    const sx = Math.min(10, Math.max(1, Math.round(item.scaleX || 1)));
    const sy = Math.min(10, Math.max(1, Math.round(item.scaleY || sx)));
    return `${pos}^XG${item.source},${sx},${sy}^FS`;
  }
  return `${pos}^IM${item.source}^FS`;
}

function boxZpl(item) {
  const color = item.invert ? 'W' : 'B';
  return `^FO${item.x},${item.y}^GB${item.w},${item.h},${item.thickness},${color},${item.rounding || 0}^FS`;
}

/** ^GC when it is a circle, ^GE otherwise. */
function ellipseZpl(item) {
  const color = item.invert ? 'W' : 'B';
  const pos = `^FO${item.x},${item.y}`;
  if (item.w === item.h) return `${pos}^GC${item.w},${item.thickness},${color}^FS`;
  return `${pos}^GE${item.w},${item.h},${item.thickness},${color}^FS`;
}

function lineZpl(item) {
  if (item.diagonal) {
    // ^GD: R leans like "/", L like "\".
    return `^FO${item.x},${item.y}^GD${item.w},${item.h},${item.thickness},B,${item.lean === 'L' ? 'L' : 'R'}^FS`;
  }
  // ^GB draws a line when one side collapses to the stroke thickness.
  const w = item.vertical ? item.thickness : item.length;
  const h = item.vertical ? item.length : item.thickness;
  return `^FO${item.x},${item.y}^GB${w},${h},${item.thickness},B,0^FS`;
}

export function elementZpl(item) {
  switch (item.type) {
    case 'text':
      return textZpl(item);
    case 'barcode':
      return withClock(barcodeZpl(item), item.clock);
    case 'image':
      return imageZpl(item);
    case 'box':
      return boxZpl(item);
    case 'ellipse':
      return ellipseZpl(item);
    case 'line':
      return lineZpl(item);
    case 'field':
      return withClock(fieldZpl(item), item.clock);
    case 'date':
      return dateZpl(item);
    default:
      return '';
  }
}

/** Render a whole document to ZPL. */
export function toZpl(doc) {
  const lines = ['^XA'];

  lines.push(`^PW${doc.width}`);
  lines.push(`^LL${doc.height}`);
  if (doc.homeX || doc.homeY) lines.push(`^LH${doc.homeX},${doc.homeY}`);
  lines.push(`^PO${doc.orientation}`);
  if (doc.mediaType) lines.push(`^MN${doc.mediaType}`);
  if (doc.darkness !== null && doc.darkness !== undefined && doc.darkness !== '') {
    lines.push(`^MD${doc.darkness}`);
  }
  if (doc.speed !== null && doc.speed !== undefined && doc.speed !== '') {
    lines.push(`^PR${doc.speed}`);
  }
  // UTF-8 so field data round-trips characters outside the default page.
  lines.push('^CI28');

  for (const item of doc.elements) {
    const zpl = elementZpl(item);
    if (zpl) lines.push(zpl);
  }

  for (const raw of doc.passthrough || []) lines.push(raw);

  if (doc.copies > 1) lines.push(`^PQ${doc.copies}`);
  lines.push('^XZ');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * Split ZPL into {cmd, args} tokens. Commands start with ^ or ~ and are
 * two characters, except ^A which is "^A" plus a one-character font id.
 */
/*
 * Formatting
 * ------------------------------------------------------------------
 * ZPL has no line breaks of its own -- a whole label is legal as one
 * line, and that is how the printer stores one. People do not write it
 * that way, and the convention in every hand-written label is the same
 * one: a field goes on a line, from wherever it is positioned through
 * its ^FS, and anything that is not part of a field gets a line to
 * itself. Measured over 333 label files: 5082 lines start with ^FO and
 * 6357 end with ^FS.
 *
 * So there is one rule -- a command joins the line above it only while
 * a field is open -- and it needs no table of command names.
 */

/** Commands that open a field: everything up to ^FS belongs with them. */
const FIELD_OPENERS = new Set(['FO', 'FT', 'FN', 'FX', 'FD', 'FV']);

/**
 * Lay ZPL out the way it is written by hand.
 *
 * Only line breaks change. Every byte of every command is re-emitted
 * from the source exactly as it was found, so this cannot alter what a
 * label prints -- including commands this editor knows nothing about.
 *
 * The one thing it does discard is line breaks that were already inside
 * a command's arguments, which is where the printer ignores them.
 */
export function formatZpl(text) {
  const src = String(text);
  const tokens = tokenizeZpl(src);
  if (!tokens.length) return src.trim();

  const lines = [];
  let line = src
    .slice(0, tokens[0].start)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  let fieldOpen = false;

  const flush = () => {
    if (line.trim()) lines.push(line.trim());
    line = '';
  };

  for (const token of tokens) {
    const piece = src.slice(token.start, token.end).replace(/[\r\n]+/g, '');

    // A label's own start and end always stand alone -- unless they
    // turn up inside field data, where they are text, not commands.
    if (!fieldOpen && (token.cmd === 'XA' || token.cmd === 'XZ')) {
      flush();
      lines.push(piece.trim());
      continue;
    }

    if (fieldOpen) {
      line += piece;
    } else {
      flush();
      line = piece;
    }

    if (FIELD_OPENERS.has(token.cmd)) fieldOpen = true;
    if (token.cmd === 'FS') {
      flush();
      fieldOpen = false;
    }
  }

  flush();
  return lines.join('\n') + '\n';
}

/**
 * Whether position `k` begins a command rather than being data.
 *
 * A caret or tilde only introduces a command when a letter follows it.
 * Anything else is an argument: ^CT~ sets the control character *to* a
 * tilde, and reading that tilde as a command turns one line into two.
 */
function isCommandStart(src, k) {
  const ch = src[k];
  if (ch !== '^' && ch !== '~') return false;
  const next = src[k + 1];
  return next !== undefined && /[A-Za-z@]/.test(next);
}

export function tokenizeZpl(text) {
  const tokens = [];
  const src = String(text);
  let i = 0;

  while (i < src.length) {
    if (!isCommandStart(src, i)) {
      i++;
      continue;
    }
    const ch = src[i];

    let cmd = src.slice(i + 1, i + 3).toUpperCase();
    let argStart = i + 3;
    // ^A embeds the font in the command: ^A0N,30,30 or ^AN,30,30.
    if (cmd[0] === 'A') {
      cmd = 'A';
      argStart = i + 2;
    }

    let j = argStart;
    while (j < src.length && !isCommandStart(src, j)) j++;
    tokens.push({ prefix: ch, cmd, args: src.slice(argStart, j), start: i, end: j });
    i = j;
  }
  return tokens;
}

function num(value, fallback = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Undo escapeFieldData. Only meaningful when ^FH was in effect. */
export function unescapeFieldData(text, active) {
  if (!active) return text;
  return String(text).replace(/_([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * Parse ZPL into a document.
 *
 * Returns {doc, unsupported}. `unsupported` lists commands the visual
 * editor cannot represent; they are kept in doc.passthrough so generating
 * ZPL again does not lose them, but they will not be draggable.
 */
export function parseZpl(text, dpi = 203) {
  const doc = newLabel(dpi);
  doc.elements = [];
  doc.passthrough = [];

  const tokens = tokenizeZpl(text);
  const unsupported = [];

  // Field-level state, reset by every ^FS.
  let field = null;
  const resetField = () => {
    field = { x: 0, y: 0, hexEscape: false, reverse: false };
  };
  resetField();

  let lastBy = { moduleWidth: 2, ratio: 3, height: 10 };
  let sawFieldOrigin = false;

  const source = String(text);

  /**
   * Keep a command we do not model, together with the field origin it
   * belongs to. Without the ^FO the command would be re-emitted at
   * whatever position happened to be current, quietly moving it.
   */
  const flushUnsupported = (token) => {
    unsupported.push(token.prefix + token.cmd);
    if (sawFieldOrigin && !field.passedThrough) {
      doc.passthrough.push(`^FO${field.x},${field.y}`);
      field.passedThrough = true;
    }
    doc.passthrough.push(source.slice(token.start, token.end).trim());
  };

  /**
   * A field's data has arrived (^FD, or ^SN counting from `raw`): it
   * becomes whichever element the commands before it describe.
   */
  const placeData = (raw, serial) => {
    if (field.fieldElement) {
      // "^FN1^FDtext^FS" gives the field its default value.
      field.fieldElement.initial = raw;
    } else if (field.barcode) {
      const item = { ...field.barcode, id: elementId(), x: field.x, y: field.y, data: raw };
      if (field.clock) item.clock = field.clock;
      if (serial) item.serial = serial;
      if (item.symbology === 'qr') {
        // "QA,payload" -- strip the error-correction/mode prefix.
        const match = /^([HQML])([AMNK]),?([\s\S]*)$/.exec(raw);
        if (match) {
          item.errorLevel = match[1];
          item.data = match[3];
        }
      }
      doc.elements.push(item);
    } else if (field.clock) {
      // A ^FC makes this a clock field, whether or not it has a font.
      const font = field.pending || { rotation: 'N', font: '0', height: 30, width: 0 };
      doc.elements.push({
        id: elementId(),
        type: 'date',
        x: field.x,
        y: field.y,
        rotation: font.rotation,
        font: font.font,
        height: font.height,
        width: font.width,
        format: raw,
        clock: field.clock,
        reverse: field.reverse,
        direction: field.direction || 'H',
        blockWidth: field.block ? field.block.blockWidth : 0,
        blockLines: field.block ? field.block.blockLines : 0,
        justify: field.block ? field.block.justify : 'L',
      });
    } else if (field.pending) {
      doc.elements.push({
        id: elementId(),
        type: 'text',
        x: field.x,
        y: field.y,
        rotation: field.pending.rotation,
        font: field.pending.font,
        height: field.pending.height,
        width: field.pending.width,
        text: raw,
        reverse: field.reverse,
        direction: field.direction || 'H',
        blockWidth: field.block ? field.block.blockWidth : 0,
        blockLines: field.block ? field.block.blockLines : 0,
        justify: field.block ? field.block.justify : 'L',
        ...(serial ? { serial } : {}),
      });
    } else if (raw.trim() !== '') {
      // Data with no preceding font or barcode command: the printer
      // would use whatever ^CF set, which we do not track.
      doc.elements.push({
        id: elementId(),
        type: 'text',
        x: field.x,
        y: field.y,
        rotation: 'N',
        font: '0',
        height: 30,
        width: 0,
        text: raw,
        reverse: false,
        blockWidth: 0,
        ...(serial ? { serial } : {}),
      });
    }
  };

  for (const token of tokens) {
    const args = token.args.split(',');

    switch (token.cmd) {
      case 'XA':
      case 'XZ':
      case 'CI':
      case 'FS':
        if (token.cmd === 'FS') {
          if (field.passedThrough) doc.passthrough.push('^FS');
          resetField();
        }
        break;

      case 'PW':
        doc.width = num(args[0], doc.width);
        break;
      case 'LL':
        doc.height = num(args[0], doc.height);
        break;
      case 'PO':
        doc.orientation = (token.args.trim().toUpperCase() || 'N')[0] === 'I' ? 'I' : 'N';
        break;
      case 'MD':
        doc.darkness = num(args[0], 0);
        break;
      case 'PR':
        doc.speed = num(args[0], null);
        break;
      case 'MN':
        doc.mediaType = (token.args.trim().toUpperCase() || 'N')[0];
        break;
      case 'PQ':
        doc.copies = num(args[0], 1);
        break;
      case 'LH':
        doc.homeX = num(args[0], 0);
        doc.homeY = num(args[1], 0);
        break;

      case 'FO':
      case 'FT':
        field.x = num(args[0], 0);
        field.y = num(args[1], 0);
        sawFieldOrigin = true;
        break;

      case 'FH':
        field.hexEscape = true;
        break;
      case 'FR':
        field.reverse = true;
        break;
      case 'FC':
        field.clock = token.args.trim() || '%';
        break;

      case 'FN': {
        const match = /^\s*(\d+)\s*(?:"([^"]*)")?/.exec(token.args);
        const pending = field.pending || {};
        field.fieldElement = {
          id: elementId(),
          type: 'field',
          x: field.x,
          y: field.y,
          rotation: pending.rotation || 'N',
          font: pending.font || '0',
          height: pending.height || 30,
          width: pending.width || 0,
          number: match ? parseInt(match[1], 10) : 0,
          name: (match && match[2]) || '',
          initial: '',
        };
        if (field.clock) field.fieldElement.clock = field.clock;
        doc.elements.push(field.fieldElement);
        break;
      }

      // "^A0N,30,30": the font id and rotation are glued to the command,
      // so args[0] is "0N" and the sizes start at args[1].
      case 'A':
        field.pending = {
          type: 'text',
          // ^A@o,h,w,d:f.x names a stored font by its path.
          font:
            token.args[0] === '@'
              ? (args[3] || '').trim().toUpperCase() || '0'
              : (token.args[0] || '0').toUpperCase(),
          rotation: normalizeRotation(token.args[1]),
          height: num(args[1], 30),
          // A width equal to the height is the ordinary proportional font,
          // and is kept as 0, "follows the height": what is written back
          // is the same, and the editor keeps the two locked together.
          width: num(args[2], 0) === num(args[1], 30) ? 0 : num(args[2], 0),
        };
        break;

      case 'BY':
        lastBy = {
          moduleWidth: num(args[0], 2),
          ratio: num(args[1], 3),
          height: num(args[2], lastBy.height),
        };
        break;

      case 'FP':
        field.direction = normalizeDirection(args[0]);
        break;

      case 'FB':
        field.block = {
          blockWidth: num(args[0], 0),
          blockLines: num(args[1], 1),
          justify: (args[3] || 'L').trim().toUpperCase(),
        };
        break;

      case 'GB': {
        const w = num(args[0], 0);
        const h = num(args[1], 0);
        const thickness = num(args[2], 1);
        const invert = (args[3] || 'B').trim().toUpperCase() === 'W';
        const rounding = num(args[4], 0);
        // A rectangle whose width or height equals the stroke is a line.
        const isLine = (w <= thickness || h <= thickness) && rounding === 0 && !invert;
        doc.elements.push(
          isLine
            ? {
                id: elementId(),
                type: 'line',
                x: field.x,
                y: field.y,
                rotation: 'N',
                vertical: w <= thickness,
                length: Math.max(w, h),
                thickness,
              }
            : {
                id: elementId(),
                type: 'box',
                x: field.x,
                y: field.y,
                rotation: 'N',
                w,
                h,
                thickness,
                rounding,
                invert,
              },
        );
        break;
      }

      case 'GC':
      case 'GE': {
        const circle = token.cmd === 'GC';
        const w = num(args[0], 3);
        doc.elements.push({
          id: elementId(),
          type: 'ellipse',
          x: field.x,
          y: field.y,
          rotation: 'N',
          w,
          h: circle ? w : num(args[1], 3),
          thickness: num(args[circle ? 1 : 2], 1),
          invert: (args[circle ? 2 : 3] || 'B').trim().toUpperCase() === 'W',
        });
        break;
      }

      case 'GD': {
        const lean = (args[4] || 'R').trim().toUpperCase();
        doc.elements.push({
          id: elementId(),
          type: 'line',
          x: field.x,
          y: field.y,
          rotation: 'N',
          diagonal: true,
          w: num(args[0], 3),
          h: num(args[1], 3),
          thickness: num(args[2], 1),
          lean: lean === 'L' || lean === '\\' ? 'L' : 'R',
          vertical: false,
          length: num(args[0], 3),
        });
        break;
      }

      case 'IM':
      case 'XG': {
        const parts = token.args.split(',');
        doc.elements.push({
          id: elementId(),
          type: 'image',
          x: field.x,
          y: field.y,
          rotation: 'N',
          source: parts[0].trim(),
          scaleX: num(parts[1], 1) || 1,
          scaleY: num(parts[2], 1) || 1,
        });
        break;
      }

      case 'FD':
        placeData(unescapeFieldData(token.args, field.hexEscape), null);
        break;

      // ^SNv,n,z stands where ^FD would, with a value that counts.
      case 'SN':
        placeData((args[0] || '').trim(), {
          step: num(args[1], 1) || 1,
          zeros: (args[2] || 'N').trim().toUpperCase() === 'Y',
        });
        break;

      default: {
        const symbology = /^B[0-9A-Z]$/.test(token.cmd) && symbologyFor(token.cmd, args);
        if (symbology) {
          field.barcode = barcodeFromArgs(symbology, args, lastBy);
        } else {
          flushUnsupported(token);
        }
      }
    }
  }

  // Text with no ZPL in it at all (EPL pasted in, say) would vanish in
  // the visual editor. A label that is ZPL but has no fields yet -- a new
  // one, or one being written -- loses nothing, so it is not flagged.
  if (tokens.length === 0 && text.trim() !== '') {
    unsupported.push('(text that is not ZPL)');
  }

  return { doc, unsupported: [...new Set(unsupported)] };
}

function normalizeDirection(ch) {
  const d = String(ch || 'H')
    .trim()
    .toUpperCase();
  return ['H', 'V', 'R'].includes(d) ? d : 'H';
}

function normalizeRotation(ch) {
  const r = String(ch || 'N').toUpperCase();
  return ['N', 'R', 'I', 'B'].includes(r) ? r : 'N';
}

function barcodeFromArgs(symbology, args, by) {
  const base = {
    type: 'barcode',
    symbology,
    rotation: normalizeRotation((args[0] || 'N').trim()),
    moduleWidth: by.moduleWidth,
    ratio: by.ratio,
    height: by.height,
    showText: true,
    magnification: 4,
    errorLevel: 'Q',
    databarType: 1,
  };

  if (symbology === 'qr') {
    base.magnification = num(args[2], 4);
    base.height = 0;
  } else if (symbology === 'datamatrix') {
    base.moduleWidth = num(args[1], by.moduleWidth);
    base.height = 0;
  } else if (symbology === 'pdf417') {
    base.moduleWidth = num(args[1], by.moduleWidth);
    base.height = num(args[4], 10) * 10;
  } else if (symbology === 'aztec') {
    base.magnification = num(args[1], 4);
    base.height = 0;
  } else if (symbology === 'maxicode') {
    base.rotation = 'N';
    base.maxiMode = num(args[0], 2);
    base.height = 0;
  } else if (symbology === 'micropdf') {
    base.height = num(args[1], by.height);
  } else if (symbology === 'databar') {
    base.databarType = num(args[1], 1);
    base.magnification = num(args[2], 2);
    base.height = num(args[4], 25);
    base.showText = false;
  } else if (symbology === 'code39' || symbology === 'codabar') {
    // Both put a check-digit flag ahead of the height.
    base.height = num(args[2], by.height);
    base.showText = (args[3] || 'Y').trim().toUpperCase() !== 'N';
  } else if (['postnet', 'planet', 'imb'].includes(symbology)) {
    base.height = num(args[1], by.height);
    // The postal codes default to no interpretation line.
    base.showText = (args[2] || 'N').trim().toUpperCase() === 'Y';
  } else {
    base.height = num(args[1], by.height);
    base.showText = (args[2] || 'Y').trim().toUpperCase() !== 'N';
  }
  return base;
}

/* ------------------------------------------------------------------ *
 * ^FN fields (used by Stored Formats)
 * ------------------------------------------------------------------ */

/**
 * Find the ^FN field numbers in a stored format, in the order they appear.
 * ^FN takes a number and may be followed by ^FDdefault, and newer firmware
 * allows a name via ^FN1"ORDER_ID".
 */
/**
 * The number a new ^FN field should take: one past the highest already
 * in the label.
 *
 * Counts the fields the canvas models *and* any ^FN inside the commands
 * it does not -- a duplicate that reused a number would quietly merge
 * itself with another field when the format is filled in, which is the
 * one thing a duplicate must not do.
 */
export function nextFieldNumber(doc) {
  let highest = 0;
  for (const item of (doc && doc.elements) || []) {
    if (item.type !== 'field') continue;
    const number = Number(item.number);
    if (Number.isFinite(number)) highest = Math.max(highest, number);
  }
  for (const raw of (doc && doc.passthrough) || []) {
    for (const found of findFieldNumbers(raw)) highest = Math.max(highest, found.number);
  }
  return highest + 1;
}

export function findFieldNumbers(zpl) {
  const found = new Map();
  const tokens = tokenizeZpl(zpl);
  let hexEscape = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.cmd === 'FH') {
      hexEscape = true;
      continue;
    }
    if (token.cmd === 'FS') {
      hexEscape = false;
      continue;
    }
    if (token.cmd !== 'FN') continue;

    const match = /^\s*(\d+)\s*(?:"([^"]*)")?/.exec(token.args);
    if (!match) continue;
    const number = parseInt(match[1], 10);

    // "^FN1^FDtext^FS" inside a stored format supplies that field's
    // default, which is the right thing to prefill an input with.
    let initial = '';
    const next = tokens[i + 1];
    if (next && (next.cmd === 'FD' || next.cmd === 'FV')) {
      initial = unescapeFieldData(next.args, hexEscape);
    }

    if (!found.has(number)) {
      found.set(number, { number, name: match[2] || '', initial });
    } else {
      const existing = found.get(number);
      if (match[2] && !existing.name) existing.name = match[2];
      if (initial && !existing.initial) existing.initial = initial;
    }
  }
  return [...found.values()].sort((a, b) => a.number - b.number);
}

/**
 * Build the ZPL that recalls a stored format and fills in its fields.
 * ^XF recalls; each ^FN/^FD pair supplies one field's data.
 */
export function buildFormatCall(device, name, fieldValues) {
  const lines = ['^XA', `^XF${device}:${name}^FS`];
  for (const [number, value] of fieldValues) {
    lines.push(`^FN${number}^FH^FD${escapeFieldData(value)}^FS`);
  }
  lines.push('^XZ');
  return lines.join('\n');
}
