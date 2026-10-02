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
 * zpl-reference.mjs -- what each ZPL command does, and each parameter.
 *
 * Written for this console from the ZPL II programming guide (Zebra's
 * "ZPL II, ZBI 2, Set-Get-Do, Mirror, WML" guide, P1012728), in our own
 * words: a sentence or two on the command, and for each parameter what
 * it means, the values it takes and its default. The guide has the full
 * story -- tables, examples, and the interactions between commands --
 * and tools/zpl-manual-extract.mjs pulls its sections out for checking
 * this against a newer edition.
 *
 * The source view shows the entry for the command under the cursor. The
 * build writes this out as JSON in a file of its own on the printer
 * (ZPLREF.SHTML), read the first time the source view wants it, so it
 * costs the page nothing until then.
 *
 * Each entry: { name, does, format, params: [[letter, name, about,
 * values, default]], note?, alias? }. `alias` points a second spelling
 * (~CC for ^CC) at the entry that describes both.
 */

/** One parameter. */
const p = (letter, name, about, values = '', fallback = '') => [letter, name, about, values, fallback];

const ROTATION = 'N normal · R 90° clockwise · I 180° · B 270° (read bottom up)';
const YN = 'Y yes · N no';

/** The orientation every field command starts with. */
const orient = (letter = 'o', fallback = 'the ^FW setting') =>
  p(letter, 'Orientation', 'Which way the field is turned on the label.', ROTATION, fallback);
const barHeight = (letter = 'h') =>
  p(letter, 'Bar height', 'Height of the bars, in dots.', '1–32000', 'the ^BY height');
const lineBelow = (fallback = 'Y') =>
  p('f', 'Interpretation line', 'Print the human-readable text with the bars.', YN, fallback);
const lineAbove = p(
  'g',
  'Text above',
  'Put the interpretation line above the bars rather than below.',
  YN,
  'N',
);
const objectName = (letter = 'd:o.x', what = 'the object') =>
  p(letter, 'Object', `Drive, name and extension of ${what}, e.g. E:LOGO.GRF.`, 'drive R:, E:, B: or A:; name up to 16 characters', '');

export const ZPL = {};

/* ------------------------------------------------------------------ *
 * Fonts and barcodes
 * ------------------------------------------------------------------ */

Object.assign(ZPL, {
  '^A': {
    name: 'Scalable/Bitmapped Font',
    does: 'Chooses the font, rotation and size for the next field only; the field after it goes back to the ^CF default.',
    format: '^Afo,h,w',
    params: [
      p('f', 'Font', 'The font, by its one-character name, written straight after ^A.', 'A–Z, 0–9 (resident or downloaded fonts)', 'A'),
      orient(),
      p('h', 'Character height', 'Height in dots. A bitmap font is scaled by whole multiples of its own size.', '10–32000 (scalable), or a multiple of the font’s height', 'the ^CF height'),
      p('w', 'Width', 'Character width in dots. Given only one of height and width, the font keeps its own proportions.', '10–32000 (scalable), or a multiple of the font’s width', 'the ^CF width'),
    ],
  },
  '^A@': {
    name: 'Use Font Name to Call Font',
    does: 'Chooses a stored font by its file name rather than a letter -- the way to use a TrueType font on the printer. It stays in force until the next ^A@.',
    format: '^A@o,h,w,d:f.x',
    params: [
      orient(),
      p('h', 'Character height', 'Height in dots.', '10–32000', 'the ^CF height'),
      p('w', 'Width', 'Character width in dots.', '10–32000', 'the ^CF width'),
      p('d', 'Drive', 'Where the font is stored.', 'R:, E:, B:, A: or Z:', 'R:'),
      p('f', 'Font name', 'The font’s object name.', 'up to 16 characters', 'unknown'),
      p('x', 'Extension', 'The font file’s type.', '.TTF, .TTE, .FNT', '.FNT'),
    ],
  },
  '^B0': {
    name: 'Aztec Barcode',
    does: 'A 2-D matrix symbol built in rings around a bullseye; the data comes from the ^FD that follows. Same as ^BO.',
    format: '^B0a,b,c,d,e,f,g',
    params: [
      orient('a'),
      p('b', 'Magnification', 'Size of each module, in dots.', '1–10', '2 at 200 dpi, 3 at 300 dpi'),
      p('c', 'ECICs in data', 'Whether the data contains Extended Channel Interpretation codes.', YN, 'N'),
      p('d', 'Error correction / size', '0 lets the printer choose; 1–99 sets a minimum error-correction percentage; 101–104 a compact symbol of 1–4 layers; 201–232 a full-range symbol of 1–32 layers; 300 a Rune.', '0, 1–99, 101–104, 201–232, 300', '0'),
      p('e', 'Menu symbol', 'Make it a reader-programming (menu) symbol.', YN, 'N'),
      p('f', 'Structured append count', 'How many symbols the data is split across.', '1–26', '1'),
      p('g', 'Structured append ID', 'Identifier shared by the symbols of one message.', 'text, up to 24 characters', 'none'),
    ],
  },
  '^B1': {
    name: 'Code 11 Barcode',
    does: 'Code 11 (USD-8): digits and the hyphen only.',
    format: '^B1o,e,h,f,g',
    params: [
      orient(),
      p('e', 'Check digits', 'Y adds one check digit, N adds two.', 'Y one · N two', 'N'),
      barHeight(),
      lineBelow(),
      lineAbove,
    ],
  },
  '^B2': {
    name: 'Interleaved 2 of 5 Barcode',
    does: 'Interleaved 2 of 5: dense, numeric only, an even number of digits (a leading zero is added if needed).',
    format: '^B2o,h,f,g,e,j',
    params: [
      orient(),
      barHeight(),
      lineBelow(),
      lineAbove,
      p('e', 'Mod 10 check digit', 'Calculate and add a Mod 10 check digit.', YN, 'N'),
      p('j', 'Plain text line', 'Print the interpretation line without the check digit or start/stop characters.', YN, 'N'),
    ],
  },
  '^B3': {
    name: 'Code 39 Barcode',
    does: 'Code 39 (3 of 9): capitals, digits and a few symbols. Start the data with +$ for full-ASCII mode.',
    format: '^B3o,e,h,f,g',
    params: [orient(), p('e', 'Mod-43 check digit', 'Add a Mod-43 check digit.', YN, 'N'), barHeight(), lineBelow(), lineAbove],
  },
  '^B4': {
    name: 'Code 49 Barcode',
    does: 'Code 49: a stacked symbol of two to eight rows that encodes all 128 ASCII characters.',
    format: '^B4o,h,f,m',
    params: [
      orient(),
      p('h', 'Row height multiplier', 'Multiplied by the module width to give each row’s height in dots.', '1 to the label height (1 is too small to read)', 'the ^BY height'),
      p('f', 'Interpretation line', 'Where to print the human-readable text.', 'N none · A above · B below', 'N'),
      p('m', 'Starting mode', 'The encoding mode the symbol starts in; A lets the printer decide from the data.', '0 alphanumeric · 1 multiple-read alphanumeric · 2 numeric · 3 group alphanumeric · 4 shift 1 · 5 shift 2 · A automatic', 'A'),
    ],
  },
  '^B5': {
    name: 'Planet Code Barcode',
    does: 'USPS PLANET code: digits only.',
    format: '^B5o,h,f,g',
    params: [orient(), p('h', 'Bar height', 'Height of the bars, in dots.', '1–9999', 'the ^BY height'), lineBelow('N'), lineAbove],
  },
  '^B7': {
    name: 'PDF417 Barcode',
    does: 'PDF417: a stacked 2-D symbol of 3 to 90 rows, holding up to about 3 KB of data.',
    format: '^B7o,h,s,c,r,t',
    params: [
      orient(),
      p('h', 'Row height', 'Height of each row, in dots (multiplied by the module width).', '1 to the label height', 'the ^BY height divided by the rows'),
      p('s', 'Security level', 'Error-correction level; higher survives more damage but makes a bigger symbol.', '1–8', '0 (error detection only)'),
      p('c', 'Columns', 'Data columns across, which sets the width.', '1–30', 'a 1:2 row-to-column ratio'),
      p('r', 'Rows', 'Rows down, which sets the height. Columns × rows must stay under 928.', '3–90', 'a 1:2 row-to-column ratio'),
      p('t', 'Truncate', 'Drop the right-hand row indicators and stop pattern (Truncated PDF417).', YN, 'N'),
    ],
  },
  '^B8': {
    name: 'EAN-8 Barcode',
    does: 'EAN-8: exactly seven digits; the printer adds the check digit, padding or trimming the data on the left.',
    format: '^B8o,h,f,g',
    params: [orient(), barHeight(), lineBelow(), lineAbove],
  },
  '^B9': {
    name: 'UPC-E Barcode',
    does: 'UPC-E: the zero-suppressed form of UPC-A, for number system 0.',
    format: '^B9o,h,f,g,e',
    params: [orient(), barHeight(), lineBelow(), lineAbove, p('e', 'Check digit', 'Print the check digit.', YN, 'Y')],
  },
  '^BA': {
    name: 'Code 93 Barcode',
    does: 'Code 93: like Code 39 but denser, and able to encode all 128 ASCII characters using paired substitute characters.',
    format: '^BAo,h,f,g,e',
    params: [orient(), barHeight(), lineBelow(), lineAbove, p('e', 'Check digit', 'Print the check digit.', YN, 'N')],
  },
  '^BB': {
    name: 'CODABLOCK Barcode',
    does: 'CODABLOCK: a stacked symbol of up to 44 rows, each row a Code 39 or Code 128 line.',
    format: '^BBo,h,s,c,r,m',
    params: [
      orient('o', 'N'),
      p('h', 'Row height', 'Height of each row, in dots (multiplied by the module width).', '2–32000', '8'),
      p('s', 'Security', 'Add symbol checksums (can only be turned off in mode A).', YN, 'Y'),
      p('c', 'Characters per row', 'Data characters across, which sets the width.', '2–62', 'from the data and r'),
      p('r', 'Rows', 'How many rows to encode.', '1–22 (mode A), 2–4 (E and F)', 'from the data and c'),
      p('m', 'Mode', 'Which CODABLOCK variant.', 'A (Code 39 based) · E (Code 128 with FNC1) · F (Code 128)', 'F'),
    ],
  },
  '^BC': {
    name: 'Code 128 Barcode (Subsets A, B, and C)',
    does: 'Code 128: dense and alphanumeric. Mode D makes it GS1-128 (UCC/EAN-128), with application identifiers in brackets.',
    format: '^BCo,h,f,g,e,m',
    params: [
      orient(),
      barHeight(),
      lineBelow(),
      lineAbove,
      p('e', 'UCC check digit', 'Add a Mod 10 check digit as well as the Mod 103 one that is always there.', YN, 'N'),
      p('m', 'Mode', 'How the data is packed. A picks subsets automatically; D is GS1-128, stripping the brackets and spaces from the bars but printing them in the text.', 'N none · U UCC case mode (19 digits) · A automatic · D UCC/EAN', 'N'),
    ],
  },
  '^BD': {
    name: 'UPS MaxiCode Barcode',
    does: 'MaxiCode, the UPS shipping symbol: fixed in size, with no rotation and no interpretation line. Modes 2 and 3 expect a structured carrier message in the ^FD.',
    format: '^BDm,n,t',
    params: [
      p('m', 'Mode', 'What the symbol carries.', '2 US carrier message (numeric postcode) · 3 international carrier message · 4 standard · 5 full error correction · 6 reader programming', '2'),
      p('n', 'Symbol number', 'This symbol’s place in a structured-append sequence.', '1–8', '1'),
      p('t', 'Total symbols', 'How many symbols the sequence has.', '1–8', '1'),
    ],
  },
  '^BE': {
    name: 'EAN-13 Barcode',
    does: 'EAN-13: twelve data digits plus a check digit the printer calculates; used in retail worldwide.',
    format: '^BEo,h,f,g',
    params: [orient(), barHeight(), lineBelow(), lineAbove],
  },
});

Object.assign(ZPL, {
  '^BF': {
    name: 'MicroPDF417 Barcode',
    does: 'MicroPDF417: a narrower relative of PDF417 for small amounts of data, with the size and error correction picked by mode.',
    format: '^BFo,h,m',
    params: [
      orient(),
      p('h', 'Row height', 'Height of each row, in dots.', '1–9999', 'the ^BY height, or 10'),
      p('m', 'Mode', 'Picks the columns, rows and error-correction share together (the guide’s MicroPDF417 mode table).', '0–33', '0'),
    ],
  },
  '^BI': {
    name: 'Industrial 2 of 5 Barcode',
    does: 'Industrial 2 of 5: numeric, with all its information in the bars.',
    format: '^BIo,h,f,g',
    params: [orient(), barHeight(), lineBelow(), lineAbove],
  },
  '^BJ': {
    name: 'Standard 2 of 5 Barcode',
    does: 'Standard 2 of 5: numeric, with wide bars three times the narrow ones.',
    format: '^BJo,h,f,g',
    params: [orient(), barHeight(), lineBelow(), lineAbove],
  },
  '^BK': {
    name: 'ANSI Codabar Barcode',
    does: 'Codabar (NW-7, USD-4): digits and - $ : / . +, with letters A–D as start and stop characters; used by libraries and blood banks.',
    format: '^BKo,e,h,f,g,k,l',
    params: [
      orient(),
      p('e', 'Check digit', 'Always N: Codabar has no check digit here.', 'N', 'N'),
      barHeight(),
      lineBelow(),
      lineAbove,
      p('k', 'Start character', 'The character the symbol starts with.', 'A, B, C, D', 'A'),
      p('l', 'Stop character', 'The character the symbol ends with.', 'A, B, C, D', 'A'),
    ],
  },
  '^BL': {
    name: 'LOGMARS Barcode',
    does: 'LOGMARS: the US Department of Defense form of Code 39, always with a Mod 43 check digit; lower case is printed as capitals.',
    format: '^BLo,h,g',
    params: [orient(), barHeight(), lineAbove],
  },
  '^BM': {
    name: 'MSI Barcode',
    does: 'MSI: a numeric variant of Plessey, up to 14 digits (13 with two check digits).',
    format: '^BMo,e,h,f,g,e2',
    params: [
      orient(),
      p('e', 'Check digits', 'Which check digits to add.', 'A none · B one Mod 10 · C two Mod 10 · D one Mod 11 and one Mod 10', 'B'),
      barHeight(),
      lineBelow(),
      lineAbove,
      p('e2', 'Check digit in text', 'Show the check digit in the interpretation line.', YN, 'N'),
    ],
  },
  '^BO': { alias: '^B0' },
  '^BP': {
    name: 'Plessey Barcode',
    does: 'Plessey: a numeric symbology (digits and A–F).',
    format: '^BPo,e,h,f,g',
    params: [orient(), p('e', 'Check digit', 'Print the check digit.', YN, 'N'), barHeight(), lineBelow(), lineAbove],
  },
  '^BQ': {
    name: 'QR Code Barcode',
    does: 'QR Code. The ^FD starts with the error-correction level and input mode, e.g. ^FDQA,data (Q level, automatic input); mixed mode and structured append use other prefixes.',
    format: '^BQa,b,c,d,e',
    params: [
      p('a', 'Orientation', 'Always N: a QR code is not rotated, and ^FW does not affect it.', 'N', 'N'),
      p('b', 'Model', 'Model 2 is the enhanced, recommended one.', '1 original · 2 enhanced', '2'),
      p('c', 'Magnification', 'Size of each module, in dots.', '1–100', '2 at 200 dpi, 3 at 300 dpi'),
      p('d', 'Error correction', 'Normally given in the ^FD prefix instead; this is the fallback.', 'H ultra-high · Q high · M standard · L high density', 'Q'),
      p('e', 'Mask', 'The mask pattern; 7 lets the printer choose.', '0–7', '7'),
    ],
  },
  '^BR': {
    name: 'GS1 Databar',
    does: 'GS1 DataBar (formerly RSS), and its composite forms, for small retail items. Note the default orientation is R.',
    format: '^BRa,b,c,d,e,f',
    params: [
      orient('a', 'R'),
      p('b', 'Type', 'Which member of the family.', '1 Omnidirectional · 2 Truncated · 3 Stacked · 4 Stacked Omnidirectional · 5 Limited · 6 Expanded · 7 UPC-A · 8 UPC-E · 9 EAN-13 · 10 EAN-8 · 11 UCC/EAN-128 & CC-A/B · 12 UCC/EAN-128 & CC-C', '1'),
      p('c', 'Magnification', 'Size of each module, in dots.', '1–10', '2 (at 8 dots/mm and below)'),
      p('d', 'Separator height', 'Height of the separator between stacked parts, in modules.', '1 or 2', '1'),
      p('e', 'Bar height', 'Height of the linear part, in dots (UCC/EAN and composite types only).', '1–32000', '25'),
      p('f', 'Segments per row', 'For Expanded: how many segments to a row.', '2–22, even only', '22'),
    ],
  },
  '^BS': {
    name: 'UPC/EAN Extensions',
    does: 'The 2- or 5-digit add-on printed beside a UPC or EAN barcode (as on books and magazines); give it its own ^FO beside the main symbol.',
    format: '^BSo,h,f,g',
    params: [orient(), barHeight(), lineBelow(), p('g', 'Text above', 'Put the interpretation line above the bars.', YN, 'Y')],
  },
  '^BT': {
    name: 'TLC39 Barcode',
    does: 'TLC39, the telecommunications (TCIF CLEI) tag: a Code 39 symbol with a MicroPDF417 beside it.',
    format: '^BTo,w1,r1,h1,w2,h2',
    params: [
      p('o', 'Orientation', 'Which way the field is turned on the label.', ROTATION, 'N'),
      p('w1', 'Code 39 module width', 'Narrow-bar width of the Code 39 part, in dots.', '1–10', '2 (4 at 600 dpi)'),
      p('r1', 'Code 39 ratio', 'Wide to narrow bar ratio of the Code 39 part.', '2.0–3.0 in steps of 0.1', '2.0'),
      p('h1', 'Code 39 height', 'Height of the Code 39 part, in dots.', '1–9999', '40 (200 dpi), 60 (300 dpi), 120 (600 dpi)'),
      p('w2', 'MicroPDF417 module width', 'Narrow-bar width of the MicroPDF417 part, in dots.', '1–10', '2 (4 at 600 dpi)'),
      p('h2', 'MicroPDF417 row height', 'Row height of the MicroPDF417 part, in dots.', '1–255', '4 (8 at 600 dpi)'),
    ],
  },
  '^BU': {
    name: 'UPC-A Barcode',
    does: 'UPC-A: eleven data digits plus a check digit; the standard North American retail code.',
    format: '^BUo,h,f,g,e',
    params: [orient(), p('h', 'Bar height', 'Height of the bars, in dots.', '1–9999', 'the ^BY height'), lineBelow(), lineAbove, p('e', 'Check digit', 'Print the check digit.', YN, 'Y')],
  },
  '^BX': {
    name: 'Data Matrix Barcode',
    does: 'Data Matrix: a square 2-D symbol. Use quality 200 (ECC 200) for anything new.',
    format: '^BXo,h,s,c,r,f,g,a',
    params: [
      orient(),
      p('h', 'Module size', 'Size of each square module, in dots. 0 sizes the symbol from the ^BY height instead.', '1 to the label width', '0'),
      p('s', 'Quality (ECC)', 'Error-correction scheme; 200 is Reed-Solomon and the one readers expect.', '0, 50, 80, 100, 140, 200', '0'),
      p('c', 'Columns', 'Force the number of columns; normally worked out from the data.', '9–49 (odd for ECC 0–140), 10–144 (even for ECC 200)', 'automatic'),
      p('r', 'Rows', 'Force the number of rows.', '9–49, or 10–144 for ECC 200', 'automatic'),
      p('f', 'Format ID', 'The character set of the data (not used with ECC 200).', '1 digits + space · 2 capitals + space · 3 capitals, digits and . , - / · 4 capitals and digits · 5 7-bit ASCII · 6 8-bit ISO', '6'),
      p('g', 'Escape character', 'With ECC 200, introduces control sequences (FNC1 and so on) in the data.', 'any character', '~ (_ on older firmware)'),
      p('a', 'Aspect ratio', 'Square or rectangular symbol (newer firmware).', '1 square · 2 rectangular', '1'),
    ],
  },
  '^BY': {
    name: 'Bar Code Field Default',
    does: 'Sets the module width, wide-to-narrow ratio and height used by the barcodes after it, until the next ^BY.',
    format: '^BYw,r,h',
    params: [
      p('w', 'Module width', 'Width of the narrowest bar, in dots.', '1–10', '2 at power-up'),
      p('r', 'Wide:narrow ratio', 'How much wider the wide bars are; ignored by fixed-ratio symbologies.', '2.0–3.0 in steps of 0.1', '3.0'),
      p('h', 'Bar height', 'Default barcode height, in dots.', 'any', '10 at power-up'),
    ],
  },
  '^BZ': {
    name: 'POSTAL Barcode',
    does: 'The USPS postal codes: POSTNET, PLANET or the Intelligent Mail barcode, picked by the last parameter.',
    format: '^BZo,h,f,g,t',
    params: [
      orient(),
      barHeight(),
      lineBelow('N'),
      lineAbove,
      p('t', 'Postal code type', 'Which postal symbology.', '0 POSTNET · 1 PLANET · 3 USPS Intelligent Mail', '0'),
    ],
  },
  '^CC': {
    name: 'Change Caret',
    does: 'Changes the character that starts format commands (normally ^). ~CC does the same at once, as a control command.',
    format: '^CCx or ~CCx',
    params: [p('x', 'New prefix', 'The character to use instead of ^. Leave it off and the next character received becomes the prefix.', 'any ASCII character', 'required')],
  },
  '~CC': { alias: '^CC' },
  '^CD': {
    name: 'Change Delimiter',
    does: 'Changes the character that separates parameters (normally a comma).',
    format: '^CDa or ~CDa',
    params: [p('a', 'New delimiter', 'The character to use instead of the comma.', 'any ASCII character', 'required')],
  },
  '~CD': { alias: '^CD' },
});

Object.assign(ZPL, {
  '^CF': {
    name: 'Change Alphanumeric Default Font',
    does: 'Sets the font and size a text field uses when it has no ^A of its own.',
    format: '^CFf,h,w',
    params: [
      p('f', 'Font', 'The default font’s one-character name.', 'A–Z, 0–9', 'A at power-up'),
      p('h', 'Height', 'Default character height, in dots.', '0–32000', '9 at power-up'),
      p('w', 'Width', 'Default character width, in dots.', '0–32000', '5 at power-up'),
    ],
  },
  '^CI': {
    name: 'Change International Font/Encoding',
    does: 'Chooses how the bytes in field data are read as characters -- a national variant, a code page, or Unicode -- and can remap individual characters. ^CI28 (UTF-8) is the usual choice today.',
    format: '^CIa,s1,d1,s2,d2,...',
    params: [
      p('a', 'Character set', 'The encoding of the field data that follows.', '0–12 national variants of code page 850 (0 USA 1, 1 USA 2, 2 UK, 3 Holland, 4 Denmark/Norway, 5 Sweden/Finland, 6 Germany, 7 France 1, 8 France 2, 9 Italy, 10 Spain, 11 misc., 12 Japan) · 13 code page 850 · 14 double-byte Asian · 15 Shift-JIS · 16 EUC-JP/EUC-CN · 24 single-byte Asian · 26 multibyte Asian with ASCII · 27 code page 1252 · 28 UTF-8 · 29 UTF-16 BE · 30 UTF-16 LE · 31 code page 1250 · 33 1251 · 34 1253 · 35 1254 · 36 1255', '0'),
      p('s1', 'Source', 'A character code to remap (only with sets 0–13).', '0–255', ''),
      p('d1', 'Destination', 'The character to print in its place. More source/destination pairs may follow.', '0–255', ''),
    ],
  },
  '^CM': {
    name: 'Change Memory Letter Designation',
    does: 'Gives the printer’s storage devices different drive letters, so a format written for one letter finds its objects on another. Save with ^JUS.',
    format: '^CMa,b,c,d,e',
    params: [
      p('a', 'Letter for B:', 'Which letter B: answers to.', 'B:, E:, R:, A:, NONE', 'B:'),
      p('b', 'Letter for E:', 'Which letter E: answers to.', 'B:, E:, R:, A:, NONE', 'E:'),
      p('c', 'Letter for R:', 'Which letter R: answers to.', 'B:, E:, R:, A:, NONE', 'R:'),
      p('d', 'Letter for A:', 'Which letter A: answers to.', 'B:, E:, R:, A:, NONE', 'A:'),
      p('e', 'Multiple alias', 'M lets two devices share a letter; otherwise a clash resets them all.', 'M or nothing', 'nothing'),
    ],
  },
  '^CN': {
    name: 'Cut Now',
    does: 'Kiosk printers: cycle the cutter now. Only works in kiosk print mode (^MMK).',
    format: '^CNa',
    params: [p('a', 'Cut mode', '0 cuts the ^KV kiosk cut amount; 1 ignores it and cuts fully.', '0, 1', 'none (required)')],
  },
  '^CO': {
    name: 'Cache On',
    does: 'Turns the cache for scaled characters on or off and sizes it; big Asian fonts may need the internal buffer type.',
    format: '^COa,b,c',
    params: [
      p('a', 'Cache on', 'Keep scaled characters in a cache.', YN, 'Y'),
      p('b', 'Extra memory', 'Kilobytes to add to the 40 KB cache.', '1–9999', '40'),
      p('c', 'Cache type', 'Which buffer to use.', '0 cache buffer (normal fonts) · 1 internal buffer (Asian fonts)', '0'),
    ],
  },
  '^CP': {
    name: 'Remove Label',
    does: 'Kiosk printers: deal with the label waiting in the presenter.',
    format: '^CPa',
    params: [p('a', 'Present mode', 'What to do with the presented label.', '0 eject · 1 retract · 2 as ^KV’s c parameter says', 'none (required)')],
  },
  '^CT': {
    name: 'Change Tilde',
    does: 'Changes the character that starts control commands (normally ~).',
    format: '^CTa or ~CTa',
    params: [p('a', 'New prefix', 'The character to use instead of ~.', 'any ASCII character', 'required')],
  },
  '~CT': { alias: '^CT' },
  '^CV': {
    name: 'Code Validation',
    does: 'Checks barcode data for bad characters, wrong check digits and wrong lengths, and prints an error message in place of a bad symbol. Lasts until turned off or the printer restarts.',
    format: '^CVa',
    params: [p('a', 'Validate', 'Check barcode data.', YN, 'N')],
  },
  '^CW': {
    name: 'Font Identifier',
    does: 'Gives a stored font a one-character name, so ^A and ^CF can use it -- replacing a built-in font if the letter is taken.',
    format: '^CWa,d:o.x',
    params: [
      p('a', 'Letter', 'The name to give the font.', 'A–Z, 0–9', 'required'),
      p('d', 'Drive', 'Where the font is stored.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Font name', 'The font’s object name.', 'up to 8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'The font’s type.', '.FNT, .TTF, .TTE', ''),
    ],
  },
  '~DB': {
    name: 'Download Bitmap Font',
    does: 'Downloads a bitmap font: this command describes the font, and a structured data block of characters follows it.',
    format: '~DBd:o.x,a,h,w,base,space,#char,©,data',
    params: [
      p('d', 'Drive', 'Where to store the font.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The font’s name.', '1–8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'Always .FNT.', '.FNT', ''),
      p('a', 'Orientation', 'Always normal.', 'N', 'N'),
      p('h', 'Cell height', 'Tallest character cell, in dots.', '1–32000', 'required'),
      p('w', 'Cell width', 'Widest character cell, in dots.', '1–32000', 'required'),
      p('base', 'Baseline', 'Dots from the top of the cell to the baseline.', '1–32000', 'required'),
      p('space', 'Space width', 'Width of a space, or of a missing character.', '1–32000', 'required'),
      p('#char', 'Character count', 'How many characters follow; must match the data.', '1–256', 'required'),
      p('©', 'Copyright', 'A copyright notice.', '1–63 characters', 'required'),
      p('data', 'Characters', 'One block per character: #code.h.w.x.y.i.bitmap.', '', ''),
    ],
  },
  '~DE': {
    name: 'Download Encoding',
    does: 'Downloads a character translation table (.DAT), used to print non-standard characters with TrueType fonts.',
    format: '~DEd:o.x,s,data',
    params: [
      p('d', 'Drive', 'Where to store the table.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The table’s name.', 'up to 8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'Always .DAT.', '.DAT', ''),
      p('s', 'Size', 'Bytes in the table.', 'any', 'required'),
      p('data', 'Data', 'The table as ASCII hex.', 'hex digits', 'required'),
    ],
  },
  '^DF': {
    name: 'Download Format',
    does: 'Stores the rest of the format (to ^XZ) as a template instead of printing it; ^XF recalls it, with ^FN fields filled in.',
    format: '^DFd:o.x',
    params: [
      p('d', 'Drive', 'Where to store the format.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The format’s name.', '1–16 characters', 'UNKNOWN'),
      p('x', 'Extension', 'Always .ZPL.', '.ZPL', '.ZPL'),
    ],
  },
  '~DG': {
    name: 'Download Graphics',
    does: 'Downloads a one-bit graphic as ASCII hex, stored as a .GRF for ^XG or ^IM to place.',
    format: '~DGd:o.x,t,w,data',
    params: [
      p('d', 'Drive', 'Where to store the graphic.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The graphic’s name (no spaces or dots).', '1–8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'Always .GRF.', '.GRF', '.GRF'),
      p('t', 'Total bytes', 'Bytes in the whole image: bytes per row × rows.', 'any', 'required'),
      p('w', 'Bytes per row', 'Width in dots ÷ 8, rounded up.', 'any', 'required'),
      p('data', 'Image', 'ASCII hex, each digit four dots across, row after row.', 'hex digits', 'required'),
    ],
  },
  '~DN': {
    name: 'Abort Download Graphic',
    does: 'Ends a ~DG download early and returns the printer to normal operation.',
    format: '~DN',
    params: [],
  },
  '~DS': {
    name: 'Download Intellifont (Scalable Font)',
    does: 'Downloads a scalable Intellifont, as converted by Zebra’s font tools.',
    format: '~DSd:o.x,s,data',
    params: [
      p('d', 'Drive', 'Where to store the font.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The font’s name.', '1–8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'Always .FNT.', '.FNT', ''),
      p('s', 'Size', 'Bytes in the font, as the conversion tool says.', 'fixed by the tool', ''),
      p('data', 'Font', 'The font as ASCII hex.', 'hex digits', ''),
    ],
  },
  '~DT': {
    name: 'Download Bounded TrueType Font',
    does: 'Downloads a converted TrueType font of fewer than 256 characters.',
    format: '~DTd:o.x,s,data',
    params: [
      p('d', 'Drive', 'Where to store the font.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The font’s name.', 'up to 8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'Always .DAT.', '.DAT', ''),
      p('s', 'Size', 'Bytes in the font.', 'any', 'required'),
      p('data', 'Font', 'The font as ASCII hex, two digits a byte.', 'hex digits', 'required'),
    ],
  },
  '~DU': {
    name: 'Download Unbounded TrueType Font',
    does: 'Downloads a converted TrueType font of more than 256 characters (Asian fonts). ~DY is faster on newer firmware.',
    format: '~DUd:o.x,s,data',
    params: [
      p('d', 'Drive', 'Where to store the font.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The font’s name.', '1–8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'Always .FNT.', '.FNT', ''),
      p('s', 'Size', 'Bytes in the font.', 'any', 'required'),
      p('data', 'Font', 'The font as ASCII hex, two digits a byte.', 'hex digits', 'required'),
    ],
  },
  '~DY': {
    name: 'Download Objects',
    does: 'Downloads a file of almost any kind -- graphic, TrueType font, certificate, WML menu -- in ASCII hex, ZB64 or binary.',
    format: '~DYd:f,b,x,t,w,data',
    params: [
      p('d', 'Drive', 'Where to store the file.', 'R:, E:, B:, A:', 'R:'),
      p('f', 'Name', 'The file’s name, without extension.', '1–8 characters (longer on newer firmware)', 'UNKNOWN'),
      p('b', 'Data format', 'How the data is sent.', 'A ASCII hex or ZB64 · B binary · C AR-compressed · P PNG in ZB64', 'required'),
      p('x', 'Stored as', 'The kind of file to store.', 'B bitmap · E .TTE · G .GRF · P .PNG · T .TTF/.OTF · X .PCX · NRD · PAC · C .WML · F .HTM · H .GET', 'required'),
      p('t', 'Total bytes', 'Size of the file itself (for a .GRF, the size once decompressed).', 'any', 'required'),
      p('w', 'Bytes per row', 'For a .GRF only; ignored for other types.', 'any', ''),
      p('data', 'Data', 'The file, encoded as b says.', '', 'required'),
    ],
  },
  '~EG': {
    name: 'Erase Download Graphics',
    does: 'Deletes downloaded graphics. Documented under ^ID, which does the same with more control.',
    format: '~EG',
    params: [],
  },
  '^FB': {
    name: 'Field Block',
    does: 'Wraps the field’s text into a block of a given width and number of lines, and justifies it. In the data, \\& is a line break, \\(*) a soft hyphen and \\\\ a backslash.',
    format: '^FBa,b,c,d,e',
    params: [
      p('a', 'Block width', 'Width of each line, in dots. Too narrow for the font and nothing prints.', '0 to the label width', '0'),
      p('b', 'Maximum lines', 'Lines in the block; text beyond them overprints the last line.', '1–9999', '1'),
      p('c', 'Line spacing', 'Dots to add (or, negative, remove) between lines.', '-9999 to 9999', '0'),
      p('d', 'Justification', 'How lines are aligned; with J the last line is left aligned.', 'L left · C centre · R right · J justified', 'L'),
      p('e', 'Hanging indent', 'Indent of the second and following lines, in dots.', '0–9999', '0'),
    ],
  },
});

Object.assign(ZPL, {
  '^FC': {
    name: 'Field Clock',
    does: 'Turns on the real-time clock for this field: the printer replaces codes like %d, %m and %Y in its data with the date and time as it prints. Needed in every field that uses the clock.',
    format: '^FCa,b,c',
    params: [
      p('a', 'Primary indicator', 'The character that starts a clock code, for the printer’s own clock.', 'any ASCII character', '%'),
      p('b', 'Secondary indicator', 'Starts a code for the secondary clock (the primary plus the ^SO offset).', 'any character but a or c', 'none'),
      p('c', 'Third indicator', 'Starts a code for the third clock.', 'any character but a or b', 'none'),
    ],
  },
  '^FD': {
    name: 'Field Data',
    does: 'The text or barcode data of a field. ^ and ~ cannot appear in it unless written as hex after ^FH, or the prefixes are changed.',
    format: '^FDa',
    params: [p('a', 'Data', 'What the field prints or encodes.', 'up to 3072 bytes', 'none')],
  },
  '^FE': {
    name: 'Field Concatenation',
    does: 'Builds a field’s data out of other ^FN fields, whole or in part, using a delimiter character to mark the references in the ^FD that follows.',
    format: '^FEa',
    params: [p('a', 'Delimiter', 'Marks field references in the data, e.g. #2# for field 2 or #2,f,1,5# for five characters from the first.', 'any character except ^, ~ and ,', 'none')],
  },
  '^FH': {
    name: 'Field Hexadecimal Indicator',
    does: 'Lets the next ^FD give characters as hex codes -- _5E for ^, say -- for anything that cannot be typed or would be read as a command.',
    format: '^FHa',
    params: [p('a', 'Indicator', 'The character that introduces a two-digit hex code.', 'any character but the command prefixes', '_ (underscore)')],
  },
  '^FL': {
    name: 'Font Linking',
    does: 'Links TrueType fonts, so a character missing from the base font is taken from a linked one. Lasts until unlinked or the printer restarts (^JUS saves it).',
    format: '^FL<ext>,<base>,<link>',
    params: [
      p('ext', 'Linked font', 'The font to fall back on, e.g. E:SWISS721.TTF.', 'a stored TrueType font', ''),
      p('base', 'Base font', 'The font that gets the link.', 'a stored TrueType font', ''),
      p('link', 'Link', '1 makes the link, 0 breaks it.', '0, 1', ''),
    ],
  },
  '^FM': {
    name: 'Multiple Field Origin Locations',
    does: 'Positions the several symbols of a structured-append PDF417 or MicroPDF417, which follow on as the data overflows each one.',
    format: '^FMx1,y1,x2,y2,...',
    params: [
      p('x1', 'First symbol X', 'Where the first symbol goes across, in dots; e leaves it out.', '0–32000, e', 'required'),
      p('y1', 'First symbol Y', 'Where it goes down, in dots.', '0–32000, e', 'required'),
      p('x2', 'Second symbol X', 'And so on, in pairs, up to 60 symbols.', '0–32000, e', 'required'),
      p('y2', 'Second symbol Y', '', '0–32000, e', 'required'),
    ],
  },
  '^FN': {
    name: 'Field Number',
    does: 'Numbers a field. In a stored format (^DF) it stands where the data will go; when the format is recalled (^XF), ^FN with ^FD supplies it.',
    format: '^FN#"a"',
    params: [
      p('#', 'Field number', 'The field’s number; fields sharing one print the same data.', '0–9999 (400 or fewer advised)', 'none'),
      p('a', 'Prompt', 'Optional name in quotes, shown as the prompt on a KDU keypad and by this console.', 'up to 255 characters', 'none'),
    ],
  },
  '^FO': {
    name: 'Field Origin',
    does: 'Where the field’s top-left corner goes, in dots from the label home (^LH), whatever its rotation.',
    format: '^FOx,y,z',
    params: [
      p('x', 'X', 'Dots across from the label home.', '0–32000', '0'),
      p('y', 'Y', 'Dots down from the label home.', '0–32000', '0'),
      p('z', 'Justification', 'Which side the field grows from (newer firmware).', '0 left · 1 right · 2 auto (by script)', 'the ^FW setting'),
    ],
  },
  '^FP': {
    name: 'Field Parameter',
    does: 'Prints the field’s characters downwards or right to left -- used mostly for Asian text.',
    format: '^FPd,g',
    params: [
      p('d', 'Direction', 'Which way the characters run.', 'H horizontal · V vertical (top to bottom) · R reverse (right to left)', 'H'),
      p('g', 'Extra gap', 'Dots added between characters.', '0–9999', '0'),
    ],
  },
  '^FR': {
    name: 'Field Reverse Print',
    does: 'Prints this field in reverse of whatever is under it: white on black, black on white. ^LR does it for every field.',
    format: '^FR',
    params: [],
  },
  '^FS': {
    name: 'Field Separator',
    does: 'Ends a field.',
    format: '^FS',
    params: [],
  },
  '^FT': {
    name: 'Field Typeset',
    does: 'Positions a field by its typesetting origin -- the baseline of text, the bottom-left of a barcode -- rather than its top-left corner. Left out, the field follows on from the last.',
    format: '^FTx,y,z',
    params: [
      p('x', 'X', 'Dots across from the label home.', '0–32000', 'just after the last text field'),
      p('y', 'Y', 'Dots down from the label home.', '0–32000', 'just after the last text field'),
      p('z', 'Justification', 'Which side the field grows from (newer firmware).', '0 left · 1 right · 2 auto (by script)', 'the ^FW setting'),
    ],
  },
  '^FV': {
    name: 'Field Variable',
    does: 'Like ^FD, but the data is cleared after the label prints -- for fields that change on every label.',
    format: '^FVa',
    params: [p('a', 'Data', 'What the field prints or encodes.', 'up to 3072 bytes', 'none')],
  },
  '^FW': {
    name: 'Field Orientation',
    does: 'Sets the rotation (and justification) every field uses when it does not give its own.',
    format: '^FWr,z',
    params: [
      p('r', 'Rotation', 'Default rotation for fields.', ROTATION, 'N at power-up'),
      p('z', 'Justification', 'Default justification (newer firmware).', '0 left · 1 right · 2 auto', 'auto for ^TB, left for the rest'),
    ],
  },
  '^FX': {
    name: 'Comment',
    does: 'A comment: everything up to the next command is ignored. End it with ^FS, and keep ^ and ~ out of it.',
    format: '^FXc',
    params: [p('c', 'Comment', 'Any text that does not contain the command prefixes.', '', '')],
  },
  '^GB': {
    name: 'Graphic Box',
    does: 'Draws a box -- or a line, when its width or height equals the border thickness. A thickness of half the smaller side fills it.',
    format: '^GBw,h,t,c,r',
    params: [
      p('w', 'Width', 'Box width in dots.', 't to 32000', 't, or 1'),
      p('h', 'Height', 'Box height in dots.', 't to 32000', 't, or 1'),
      p('t', 'Border thickness', 'Thickness of the border, in dots, inward from the edge.', '1–32000', '1'),
      p('c', 'Colour', 'Black, or white to knock out what is underneath.', 'B black · W white', 'B'),
      p('r', 'Corner rounding', 'How round the corners are.', '0 (square) – 8 (roundest)', '0'),
    ],
  },
  '^GC': {
    name: 'Graphic Circle',
    does: 'Draws a circle; the border grows inward from the outline.',
    format: '^GCd,t,c',
    params: [
      p('d', 'Diameter', 'Circle diameter in dots.', '3–4095', '3'),
      p('t', 'Border thickness', 'Thickness of the outline, in dots.', '2–4095', '1'),
      p('c', 'Colour', 'Black or white.', 'B black · W white', 'B'),
    ],
  },
  '^GD': {
    name: 'Graphic Diagonal Line',
    does: 'Draws a diagonal line from corner to corner of a box of the size given.',
    format: '^GDw,h,t,c,o',
    params: [
      p('w', 'Width', 'Width of the box it spans, in dots.', '3–32000', 't, or 3'),
      p('h', 'Height', 'Height of the box it spans, in dots.', '3–32000', 't, or 3'),
      p('t', 'Thickness', 'Thickness of the line, in dots, measured across.', '1–32000', '1'),
      p('c', 'Colour', 'Black or white.', 'B black · W white', 'B'),
      p('o', 'Lean', 'Which way the line leans.', 'R or / leans right · L or \\ leans left', 'R'),
    ],
  },
  '^GE': {
    name: 'Graphic Ellipse',
    does: 'Draws an ellipse filling a box of the size given.',
    format: '^GEw,h,t,c',
    params: [
      p('w', 'Width', 'Ellipse width in dots.', '3–4095', 't, or 1'),
      p('h', 'Height', 'Ellipse height in dots.', '3–4095', 't, or 1'),
      p('t', 'Border thickness', 'Thickness of the outline, in dots.', '2–4095', '1'),
      p('c', 'Colour', 'Black or white.', 'B black · W white', 'B'),
    ],
  },
  '^GF': {
    name: 'Graphic Field',
    does: 'Puts a bitmap straight into the label at the field origin, without storing it as an object first.',
    format: '^GFa,b,c,d,data',
    params: [
      p('a', 'Encoding', 'How the image data is sent.', 'A ASCII hex · B binary · C compressed binary (also Z64/B64 in the data)', 'A'),
      p('b', 'Bytes sent', 'Bytes of data that follow (for ASCII, the same as c).', '1–99999', 'required'),
      p('c', 'Image bytes', 'Size of the image: bytes per row × rows.', '1–99999', 'required'),
      p('d', 'Bytes per row', 'Width in dots ÷ 8, rounded up.', '1–99999', 'required'),
      p('data', 'Image', 'The bitmap, encoded as a says.', '', 'required'),
    ],
  },
  '^GS': {
    name: 'Graphic Symbol',
    does: 'Prints a symbol chosen by a letter in the ^FD: A ®, B ©, C ™, D the UL mark, E the CSA mark.',
    format: '^GSo,h,w',
    params: [
      orient('o', 'N, or the ^FW setting'),
      p('h', 'Height', 'Symbol height in dots.', '0–32000', 'the ^CF height'),
      p('w', 'Width', 'Symbol width in dots.', '0–32000', 'the ^CF width'),
    ],
  },
  '~HB': {
    name: 'Battery Status',
    does: 'Mobile printers: reports the head and battery voltages and the battery temperature back to the host.',
    format: '~HB',
    params: [],
  },
});

Object.assign(ZPL, {
  '~HD': {
    name: 'Head Diagnostic',
    does: 'Reports the power supply, head temperature and other diagnostics back to the host.',
    format: '~HD',
    params: [],
  },
  '^HF': {
    name: 'Host Format',
    does: 'Sends a stored format back to the host.',
    format: '^HFd:o.x',
    params: [
      p('d', 'Drive', 'Where the format is stored.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The format’s name.', '1–8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'Always .ZPL.', '.ZPL', ''),
    ],
  },
  '^HG': {
    name: 'Host Graphic',
    does: 'Sends a stored graphic back to the host, as a ~DG command it can resend to any printer.',
    format: '^HGd:o.x',
    params: [
      p('d', 'Drive', 'Where the graphic is stored.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The graphic’s name.', '1–8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'Always .GRF.', '.GRF', ''),
    ],
  },
  '^HH': {
    name: 'Configuration Label Return',
    does: 'Sends the printer’s configuration -- what its configuration label would print -- back to the host.',
    format: '^HH',
    params: [],
  },
  '~HI': {
    name: 'Host Identification',
    does: 'Reports the model, firmware version, resolution, memory and detected options back to the host.',
    format: '~HI',
    params: [],
  },
  '~HM': {
    name: 'Host RAM Status',
    does: 'Reports the total, maximum and free RAM in kilobytes back to the host.',
    format: '~HM',
    params: [],
  },
  '~HQ': {
    name: 'Host Query',
    does: 'Asks the printer for one kind of information, returned between STX and ETX.',
    format: '~HQquery-type',
    params: [
      p('query-type', 'Query', 'What to report.', 'ES error and warning flags · HA hardware (MAC) address · JT head test results · MA maintenance alert settings · MI maintenance information · OD odometer · PH printhead life · PP plug and play string · SN serial number · UI USB information', 'required'),
    ],
  },
  '~HS': {
    name: 'Host Status Return',
    does: 'Reports three lines of status -- paper out, paused, buffer full, head open, ribbon out, labels queued and more -- back to the host. Not answered while the printer is in some error states.',
    format: '~HS',
    params: [],
  },
  '^HT': {
    name: 'Host Linked Fonts List',
    does: 'Reports the font links (^FL) set up on the printer back to the host.',
    format: '^HT',
    params: [],
  },
  '~HU': {
    name: 'Return ZebraNet Alert Configuration',
    does: 'Reports the configured ZebraNet alerts back to the host.',
    format: '~HU',
    params: [],
  },
  '^HV': {
    name: 'Host Verification',
    does: 'Sends a numbered field’s data -- typically what an RFID tag was read as -- back to the host, with an optional header.',
    format: '^HV#,n,h,t,a',
    params: [
      p('#', 'Field number', 'The ^FN number of the field to return.', '0–9999', '0'),
      p('n', 'Bytes', 'How many bytes of it to return.', '1–256', '64'),
      p('h', 'Header', 'Text sent before the data (^FH escapes allowed).', '0–3072 bytes', 'none'),
      p('t', 'Terminator', 'Text sent after the data (^FH escapes allowed).', '0–3072 characters', 'none'),
      p('a', 'Applies to', 'Respond once per format, or once per label printed.', 'F format · L label', 'F'),
    ],
  },
  '^HW': {
    name: 'Host Directory List',
    does: 'Sends a listing of the objects on a drive back to the host, one fixed-width line each.',
    format: '^HWd:o.x,f',
    params: [
      p('d', 'Drive', 'The drive to list.', 'R:, E:, B:, A:, Z:', 'R:'),
      p('o', 'Name', 'Which objects; * and ? are wildcards.', '1–8 characters', '*'),
      p('x', 'Extension', 'Which types; * and ? are wildcards.', 'any extension', '*'),
      p('f', 'Layout', 'Column or default layout (newer firmware).', 'c column · d default', 'd'),
    ],
  },
  '^HY': {
    name: 'Upload Graphics',
    does: 'Sends a stored graphic back to the host as a ~DY command, in ZB64.',
    format: '^HYd:o.x',
    params: [
      p('d', 'Drive', 'Where the graphic is stored.', 'R:, E:, B:, A:', 'search all'),
      p('o', 'Name', 'The graphic’s name.', '1–8 characters', 'required'),
      p('x', 'Format', 'The format to send it in.', 'G .GRF · P .PNG', 'as stored'),
    ],
  },
  '^HZ': {
    name: 'Display Description Information',
    does: 'Sends the printer’s description back to the host in XML: settings, object listings, an object’s data, or status. ^HZO,d:o.x,l returns one object.',
    format: '^HZb',
    params: [
      p('b', 'What to return', 'Which part of the description.', 'a all · f format settings · l object directory · o one object (^HZO,d:o.x,l) · r status', 'required'),
    ],
  },
  '^ID': {
    name: 'Object Delete',
    does: 'Deletes stored objects -- formats, graphics, fonts -- with * as a wildcard in the name and extension.',
    format: '^IDd:o.x',
    params: [
      p('d', 'Drive', 'Where the objects are.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The object’s name; * matches any.', '1–8 characters (longer on newer firmware)', 'UNKNOWN'),
      p('x', 'Extension', 'The object’s type; * matches any.', 'any extension', '.GRF'),
    ],
  },
  '^IL': {
    name: 'Image Load',
    does: 'At the start of a format, loads an image saved with ^IS at ^FO0,0, for variable data to be printed over it.',
    format: '^ILd:o.x',
    params: [
      p('d', 'Drive', 'Where the image is stored.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The image’s name.', '1–8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'The image’s type.', '.GRF, .PNG', ''),
    ],
  },
  '^IM': {
    name: 'Image Move',
    does: 'Places a stored image at the field origin, at its own size. Faster than ^XG, which can scale it.',
    format: '^IMd:o.x',
    params: [
      p('d', 'Drive', 'Where the image is stored.', 'R:, E:, B:, A:', 'search all'),
      p('o', 'Name', 'The image’s name.', '1–8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'The image’s type.', '.GRF, .PNG', ''),
    ],
  },
  '^IS': {
    name: 'Image Save',
    does: 'Saves the label formatted so far as an image, to be recalled with ^IL and printed over -- which saves formatting time for fixed content.',
    format: '^ISd:o.x,p',
    params: [
      p('d', 'Drive', 'Where to store the image.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The image’s name.', '1–8 characters', 'UNKNOWN'),
      p('x', 'Extension', 'The format to save in.', '.GRF, .PNG', '.GRF'),
      p('p', 'Print it', 'Print the label as well as saving it.', YN, 'Y'),
    ],
  },
  '~JA': {
    name: 'Cancel All',
    does: 'Cancels every format waiting in the buffer and any batch in progress; the label being printed finishes.',
    format: '~JA',
    params: [],
  },
  '^JB': {
    name: 'Initialize Flash Memory',
    does: 'Erases and initialises a Flash drive. Everything on it is lost.',
    format: '^JBa',
    params: [p('a', 'Drive', 'Which Flash device to initialise.', 'A option Flash · B Flash card · E internal Flash', 'required')],
  },
  '~JB': {
    name: 'Reset Optional Memory',
    does: 'Clears the battery-backed B: memory card -- needed after its battery has been replaced.',
    format: '~JB',
    params: [],
  },
  '~JC': {
    name: 'Set Media Sensor Calibration',
    does: 'Feeds labels to measure the label length and set the media and ribbon sensors.',
    format: '~JC',
    params: [],
  },
  '~JD': {
    name: 'Enable Communications Diagnostics',
    does: 'Starts diagnostic mode: everything the printer receives is printed as characters and hex, with any communication errors.',
    format: '~JD',
    params: [],
  },
  '~JE': {
    name: 'Disable Diagnostics',
    does: 'Ends diagnostic mode and returns to normal printing.',
    format: '~JE',
    params: [],
  },
});

Object.assign(ZPL, {
  '~JF': {
    name: 'Set Battery Condition',
    does: 'Battery-powered printers: whether to pause when the battery reaches its second low-voltage level.',
    format: '~JFp',
    params: [p('p', 'Pause on low voltage', 'N is suggested when running from a car battery adapter.', YN, 'Y')],
  },
  '~JG': {
    name: 'Graphing Sensor Calibration',
    does: 'Calibrates the media sensor and prints a graph of its readings (the media sensor profile).',
    format: '~JG',
    params: [],
  },
  '^JH': {
    name: 'Early Warning Settings',
    does: 'Sets up the early warnings the printer shows for supplies and maintenance (on the models that have them). Save with ^JUS.',
    format: '^JHa,b,c,d,e,f,g,h,i,j',
    params: [
      p('a', 'Supplies warning', 'Warn when media or ribbon runs low.', 'E enable · D disable', 'D'),
      p('b', 'Labels per roll', 'Used to predict when the media runs out.', '100–9999', '900'),
      p('c', 'Media replaced', 'Say the media has just been replaced.', YN, 'N'),
      p('d', 'Ribbon length', 'The ribbon’s length, as a code: N none, 0 100 m, 1 150 m … up to 16 900 m.', 'N, 0–16', '7 (450 m)'),
      p('e', 'Ribbon replaced', 'Say the ribbon has just been replaced.', YN, 'N'),
      p('f', 'Maintenance warning', 'Warn when the head needs cleaning or replacing.', 'E enable · D disable', 'D'),
      p('g', 'Head cleaning interval', 'Metres of media between head cleanings.', '0–10000', 'model dependent'),
      p('h', 'Head cleaned', 'Say the head has just been cleaned.', YN, 'N'),
      p('i', 'Head life', 'Inches of media the head is expected to last.', '0–1000000', 'model dependent'),
      p('j', 'Head replaced', 'Say the head has just been replaced.', YN, 'N'),
    ],
  },
  '^JI': {
    name: 'Start ZBI (Zebra BASIC Interpreter)',
    does: 'Starts the Zebra BASIC interpreter, optionally running a program. Needs a ZBI licence.',
    format: '^JId:o.x,b,c,d',
    params: [
      p('d:o.x', 'Program', 'The .BAS or .BAE program to run once ZBI has started.', 'a stored program', 'none'),
      p('b', 'Console', 'Use this port as the interactive console.', YN, 'Y'),
      p('c', 'Echo', 'Echo what is received back to the console.', YN, 'Y'),
      p('d', 'Memory', 'Memory to allocate to ZBI.', 'model dependent', ''),
    ],
  },
  '~JI': {
    name: 'Start ZBI (Zebra BASIC Interpreter)',
    does: 'Starts the Zebra BASIC interpreter in interactive mode on the port it arrives on. Needs a ZBI licence.',
    format: '~JI',
    params: [],
  },
  '^JJ': {
    name: 'Set Auxiliary Port',
    does: 'Controls a verifier or applicator connected to the printer’s applicator port: how it signals, and what it does on an error.',
    format: '^JJa,b,c,d,e,f',
    params: [
      p('a', 'Operational mode', 'How a verifier works with the printer.', '0 off · 1 reprint on error · 2 maximum throughput', '0'),
      p('b', 'Application mode', 'How the End Print signal behaves.', '0 off · 1 high, low while printing · 2 low, high while printing · 3 high, low 20 ms after a label · 4 low, high 20 ms after a label', '0'),
      p('c', 'Application mode start signal', 'Print on the start signal as a pulse or as a level.', 'p pulse · l level', 'p'),
      p('d', 'Application label error mode', 'What to do when a label goes wrong.', 'e error mode (assert Service Required) · f feed mode', 'f'),
      p('e', 'Reprint mode', 'Reprint the last label when the Reprint signal is asserted.', 'e enabled · d disabled', 'd'),
      p('f', 'Ribbon low mode', 'Warn when the ribbon is low.', 'e enabled · d disabled', 'e'),
    ],
  },
  '~JL': {
    name: 'Set Label Length',
    does: 'Measures and sets the label length, feeding one or more blank labels.',
    format: '~JL',
    params: [],
  },
  '^JM': {
    name: 'Set Dots per Millimeter',
    does: 'Halves the printing resolution, doubling the size of everything (and the ^FO positions). Takes effect from the next format.',
    format: '^JMn',
    params: [p('n', 'Resolution', 'A full resolution, B half.', 'A full · B half', 'A')],
  },
  '~JN': {
    name: 'Head Test Fatal',
    does: 'Makes a failed head test stop the printer until the test is turned off (~JO) or the power is cycled.',
    format: '~JN',
    params: [],
  },
  '~JO': {
    name: 'Head Test Non-Fatal',
    does: 'Reports a failed head test and stops, but Pause carries on. The default head-test behaviour.',
    format: '~JO',
    params: [],
  },
  '~JP': {
    name: 'Pause and Cancel Format',
    does: 'Clears the next format waiting to print and pauses the printer; each further ~JP clears another.',
    format: '~JP',
    params: [],
  },
  '~JQ': {
    name: 'Terminate Zebra BASIC Interpreter',
    does: 'Ends the ZBI session.',
    format: '~JQ',
    params: [],
  },
  '~JR': {
    name: 'Power On Reset',
    does: 'Resets the printer as if the power had been cycled: self-test, buffers cleared, settings back to the last saved ones.',
    format: '~JR',
    params: [],
  },
  '^JS': {
    name: 'Sensor Select',
    does: 'Chooses which media sensor the printer uses.',
    format: '^JSa',
    params: [p('a', 'Sensor', 'Which sensor.', 'A auto · R reflective (black mark) · T transmissive (gap)', 'A on most printers')],
  },
  '~JS': {
    name: 'Change Backfeed Sequence',
    does: 'Sets when a label is pulled back after cutting or peeling: before the next label prints, after, or a mix.',
    format: '~JSb',
    params: [p('b', 'Backfeed', 'Share of the backfeed done after the label is removed; the rest is before the next one prints.', 'A 100% after · B 0% (all before) · N normal (90%) · O off · 10–90 percent', 'N')],
  },
  '^JT': {
    name: 'Head Test Interval',
    does: 'Runs the printhead test every so many labels, optionally over a chosen range of elements.',
    format: '^JT####,a,b,c',
    params: [
      p('####', 'Interval', 'Labels between head tests (four digits).', '0000–9999', '0000 (off)'),
      p('a', 'Manual range', 'Test only the elements from b to c.', YN, 'N'),
      p('b', 'First element', 'First element to test when a is Y.', '0–9999', '0'),
      p('c', 'Last element', 'Last element to test when a is Y.', '0–9999', '9999'),
    ],
  },
  '^JU': {
    name: 'Configuration Update',
    does: 'Saves the current settings, or reloads saved or factory ones.',
    format: '^JUa',
    params: [p('a', 'Action', 'What to do. A, F and N take effect now but are lost at power-off unless followed by ^JUS.', 'S save current · R recall last saved · F factory settings · N factory network settings · A factory and network settings', 'required')],
  },
  '^JW': {
    name: 'Set Ribbon Tension',
    does: 'PAX printers: sets the ribbon tension.',
    format: '^JWt',
    params: [p('t', 'Tension', 'How tight the ribbon is held.', 'L low · M medium · H high', 'required')],
  },
  '~JX': {
    name: 'Cancel Current Partially Input Format',
    does: 'Cancels the format still being received, leaving those already printing or queued alone.',
    format: '~JX',
    params: [],
  },
  '^JZ': {
    name: 'Reprint After Error',
    does: 'Whether a label spoiled by ribbon out, media out or the head opening is reprinted once the problem is fixed.',
    format: '^JZa',
    params: [p('a', 'Reprint', 'Reprint the spoiled label.', YN, 'Y')],
  },
  '~KB': {
    name: 'Kill Battery (Battery Discharge Mode)',
    does: 'Battery-powered printers: drains the battery without printing, to keep a rechargeable one in condition.',
    format: '~KB',
    params: [],
  },
  '^KD': {
    name: 'Select Date and Time Format',
    does: 'How the real-time clock’s date and time appear on the configuration label and the idle display.',
    format: '^KDa',
    params: [p('a', 'Format', 'Which layout.', '0 firmware version instead · 1 MM/DD/YY 24 h · 2 MM/DD/YY 12 h · 3 DD/MM/YY 24 h · 4 DD/MM/YY 12 h', '0')],
  },
  '^KL': {
    name: 'Define Language',
    does: 'The language of the control panel.',
    format: '^KLa',
    params: [p('a', 'Language', 'Which language (not every printer has all).', '1 English · 2 Spanish · 3 French · 4 German · 5 Italian · 6 Norwegian · 7 Portuguese · 8 Swedish · 9 Danish · 10 Spanish 2 · 11 Dutch · 12 Finnish · 13 Japanese · 14 Korean · 15 Simplified Chinese · 16 Traditional Chinese · 17 Russian · 18 Polish · 19 Czech · 20 Romanian', '1')],
  },
  '^KN': {
    name: 'Define Printer Name',
    does: 'Sets the printer’s network name and description, shown on its web page and configuration label.',
    format: '^KNa,b',
    params: [
      p('a', 'Name', 'The printer’s name.', 'up to 16 characters', 'ZBR plus the end of the MAC address'),
      p('b', 'Description', 'Shown after the name on the web page.', 'up to 35 characters', 'erased if left out'),
    ],
  },
  '^KP': {
    name: 'Define Password',
    does: 'Sets the four-digit password that guards the control panel’s settings -- and that this console asks for to save and delete files. Not available in Protected Mode.',
    format: '^KPa,b',
    params: [
      p('a', 'Password', 'The new password.', '0000–9999', '1234'),
      p('b', 'Level', 'S4M printers only: which settings it protects.', '1–4', '3'),
    ],
  },
  '^KV': {
    name: 'Kiosk Values',
    does: 'Kiosk printers in kiosk mode (^MMK): how labels are cut and presented.',
    format: '^KVa,b,c,d,e',
    params: [
      p('a', 'Cut amount', '0 is a full cut; otherwise millimetres left uncut.', '0, 10–60', '0'),
      p('b', 'Cut margin', 'Millimetres of margin.', '2–9', '9'),
      p('c', 'Present type', 'What happens to a presented label when the next prints.', '0 eject · 1 retract · 2 nothing', '0'),
      p('d', 'Present timeout', 'Seconds before an untaken label is retracted; 0 never.', '0–300', '0'),
      p('e', 'Loop length', 'Presenter loop length in millimetres; 0 feeds straight through.', '0, 3–1023', '400'),
    ],
  },
});

Object.assign(ZPL, {
  '^LF': {
    name: 'List Font Links',
    does: 'Prints a list of the font links (^FL) set up on the printer.',
    format: '^LF',
    params: [],
  },
  '^LH': {
    name: 'Label Home',
    does: 'Moves the point every ^FO and ^FT is measured from -- useful for preprinted labels. Must come before the first ^FS.',
    format: '^LHx,y',
    params: [
      p('x', 'X', 'Dots across from the label’s top-left corner.', '0–32000', '0, or the last saved value'),
      p('y', 'Y', 'Dots down from the label’s top-left corner.', '0–32000', '0, or the last saved value'),
    ],
  },
  '^LL': {
    name: 'Label Length',
    does: 'The length of the label in dots -- essential on continuous media, where nothing else marks where a label ends. Kept across a power cycle only after ^JUS.',
    format: '^LLy,x',
    params: [
      p('y', 'Length', 'Label length in dots (inches × dpi).', '1–32000, up to the printer’s maximum', 'from the panel or calibration'),
      p('x', 'All media', 'Apply the length to gap and mark media too, not just continuous.', YN, 'N'),
    ],
  },
  '^LR': {
    name: 'Label Reverse Print',
    does: 'Prints every field after it in reverse (white on black and back), as if each had ^FR. Lasts until ^LRN.',
    format: '^LRa',
    params: [p('a', 'Reverse', 'Reverse all following fields.', YN, 'N, or the last saved value')],
  },
  '^LS': {
    name: 'Label Shift',
    does: 'Shifts every field left (or right, negative) -- for formats written for printers narrower than this one. Must come before the first ^FS.',
    format: '^LSa',
    params: [p('a', 'Shift', 'Dots to move everything left.', '-9999 to 9999', '0')],
  },
  '^LT': {
    name: 'Label Top',
    does: 'Moves the whole format up (negative) or down by up to 120 dot rows, to fine-tune where it lands on the label.',
    format: '^LTx',
    params: [p('x', 'Offset', 'Dot rows to move: negative towards the top of the label.', '-120 to 120 (most printers)', 'required')],
  },
  '^MA': {
    name: 'Set Maintenance Alerts',
    does: 'Makes the printer print (or show) reminders to clean or replace the printhead after a set distance.',
    format: '^MAtype,print,printlabel_threshold,frequency,units',
    params: [
      p('type', 'Alert', 'Which reminder.', 'R replace head · C clean head', 'required'),
      p('print', 'Print it', 'Print a reminder label when it is due.', YN, 'N'),
      p('printlabel_threshold', 'Threshold', 'Distance before the reminder, in the units below.', 'distance; 0 off', 'R 50 km · C off'),
      p('frequency', 'Repeat every', 'Metres between repeated reminders; 0 only at power-up.', '0–2000 m', '0'),
      p('units', 'Units', 'Units for the odometer and printhead reports.', 'C centimetres · I inches · M metres', 'I'),
    ],
  },
  '^MC': {
    name: 'Map Clear',
    does: 'N keeps the current label’s image to print under the next one; Y (normal) clears it after each label.',
    format: '^MCa',
    params: [p('a', 'Clear', 'Clear the bitmap after printing.', YN, 'Y')],
  },
  '^MD': {
    name: 'Media Darkness',
    does: 'Adjusts darkness relative to the printer’s configured darkness, for this and later labels.',
    format: '^MDa',
    params: [p('a', 'Adjustment', 'How much darker (or, negative, lighter) than the configured setting.', '-30 to 30', '0')],
  },
  '^MF': {
    name: 'Media Feed',
    does: 'What the printer does with the media at power-up and when the head is closed.',
    format: '^MFp,h',
    params: [
      p('p', 'At power-up', 'Action when the printer is switched on.', 'F feed to the next label · C calibrate (~JC) · L measure length (~JL) · N nothing · S short calibration', 'C'),
      p('h', 'After closing the head', 'Action when the printhead is closed.', 'F · C · L · N · S, as above', 'C'),
    ],
  },
  '^MI': {
    name: 'Set Maintenance Information Message',
    does: 'Sets the text of the head-cleaning or head-replacement reminder that ^MA prints.',
    format: '^MItype,message',
    params: [
      p('type', 'Which message', 'The replace or the clean reminder.', 'R replace head · C clean head', 'R'),
      p('message', 'Text', 'The message to print.', 'up to 63 characters', 'the built-in text'),
    ],
  },
  '^ML': {
    name: 'Maximum Label Length',
    does: 'The longest label the printer will look for while calibrating; it must be at least as long as the real label. Not used with continuous media.',
    format: '^MLa',
    params: [p('a', 'Maximum length', 'In dot rows.', 'twice the dpi up to the printer’s maximum', 'the last saved value')],
  },
  '^MM': {
    name: 'Print Mode',
    does: 'What happens after a label prints: tear off, peel, rewind, cut and so on, as the printer is fitted.',
    format: '^MMa,b',
    params: [
      p('a', 'Mode', 'The print mode.', 'T tear-off · P peel-off · R rewind · A applicator · C cutter · D delayed cutter · F RFID · K kiosk', 'depends on the printer'),
      p('b', 'Prepeel', 'Peel a little of the next label ahead (not on Link-OS printers).', YN, 'N'),
    ],
  },
  '^MN': {
    name: 'Media Tracking',
    does: 'The kind of media loaded, so the printer knows how to find where each label starts.',
    format: '^MNa,b',
    params: [
      p('a', 'Media', 'How labels are separated.', 'N continuous · V continuous, variable length · Y or W gap/notch (web) · M black mark · A detect at calibration', 'required'),
      p('b', 'Mark offset', 'For black-mark media: dots from the mark to the point where labels separate.', '-80 to 283', '0'),
    ],
  },
  '^MP': {
    name: 'Mode Protection',
    does: 'Locks a front-panel function so it can no longer be changed. One function per ^MP.',
    format: '^MPa',
    params: [p('a', 'Function', 'What to lock, or E to unlock everything.', 'D darkness · P position · C calibration · E enable all · S stop saving changes · W pause · F feed · X cancel · M menu changes', 'required')],
  },
  '^MT': {
    name: 'Media Type',
    does: 'Thermal transfer (with ribbon) or direct thermal (heat-sensitive media, no ribbon).',
    format: '^MTa',
    params: [p('a', 'Type', 'The media in use.', 'T thermal transfer · D direct thermal', 'required')],
  },
  '^MU': {
    name: 'Set Units of Measurement',
    does: 'Lets the format give positions and sizes in inches or millimetres instead of dots, or be written for a lower resolution than the head. Put it at the start of the format.',
    format: '^MUa,b,c',
    params: [
      p('a', 'Units', 'The units used from here on.', 'D dots · I inches · M millimetres', 'D'),
      p('b', 'Written for', 'The resolution the format was written for.', '150, 200, 300', ''),
      p('c', 'Print at', 'The resolution to convert to; equal to b turns conversion off.', '300, 600', ''),
    ],
  },
  '^MW': {
    name: 'Modify Head Cold Warning',
    does: 'Turns the warning that the printhead is too cold on or off.',
    format: '^MWa',
    params: [p('a', 'Warning', 'Show the head-cold warning.', YN, 'Y')],
  },
  '^PA': {
    name: 'Advanced Text Properties',
    does: 'Advanced text layout for TrueType fonts: missing-glyph boxes, right-to-left text, Arabic-style shaping, OpenType features.',
    format: '^PAa,b,c,d',
    params: [
      p('a', 'Default glyph', 'Show a missing character as the font’s own default glyph (often a box) rather than a space.', '0 space · 1 font’s glyph', '0'),
      p('b', 'Bidirectional', 'Lay out mixed left-to-right and right-to-left text.', '0 off · 1 on', '0'),
      p('c', 'Character shaping', 'Join and shape characters as scripts like Arabic need.', '0 off · 1 on', '0'),
      p('d', 'OpenType', 'Use the font’s OpenType tables.', '0 off · 1 on', '0'),
    ],
  },
  '^PF': {
    name: 'Slew Given Number of Dot Rows',
    does: 'Skips the given number of dot rows at the bottom of the label without printing, which speeds up labels with a blank bottom.',
    format: '^PF#',
    params: [p('#', 'Dot rows', 'How many rows to skip.', '0–32000', 'required')],
  },
  '^PH': {
    name: 'Slew to Home Position',
    does: 'Feeds one blank label: ^PH after the current format prints, ~PH at once (or when paused).',
    format: '^PH or ~PH',
    params: [],
  },
  '~PH': { alias: '^PH' },
  '~PL': {
    name: 'Present Length Addition',
    does: 'Kiosk printers: extra millimetres to eject when presenting, on top of the standard 50 mm.',
    format: '~PLa',
    params: [p('a', 'Extra length', 'Millimetres to add.', '000–255', '000')],
  },
  '^PM': {
    name: 'Printing Mirror Image of Label',
    does: 'Prints the whole label mirrored left to right, until ^PMN.',
    format: '^PMa',
    params: [p('a', 'Mirror', 'Mirror the label.', YN, 'N')],
  },
  '~PM': {
    name: 'Decommissioning Mode',
    does: 'Puts the printer into decommissioning mode, wiping its Flash -- for retiring a printer. Needs its serial number.',
    format: '~PMa,b',
    params: [
      p('a', 'Serial number', 'The printer’s serial number, to confirm.', 'text', 'required'),
      p('b', 'Wipe passes', 'How many times to overwrite the Flash.', 'number', '0'),
    ],
  },
  '^PN': {
    name: 'Present Now',
    does: 'Kiosk printers: run a present cycle, ejecting 50 mm + ~PL + this many millimetres.',
    format: '^PNa',
    params: [p('a', 'Eject length', 'Extra millimetres to eject.', '0–255', 'required')],
  },
  '^PO': {
    name: 'Print Orientation',
    does: 'Prints the whole label upside down (rotated 180°). Lasts until changed or the printer restarts.',
    format: '^POa',
    params: [p('a', 'Orientation', 'Normal or inverted.', 'N normal · I inverted', 'N')],
  },
});

const SPEED = '1–14 inches a second, as the printer allows (A–E are the old 2, 3, 4, 6 and 8)';
const ALERT_CONDITIONS =
  'A paper out · B ribbon out · C head too hot · D head too cold · E head open · F power supply too hot · G ribbon-in warning · H rewind full · I cut error · J paused · K ^PQ job done · L label ready · M head element out · N ZBI error · O ZBI initialised · P power on · Q clean head · R media low · S ribbon low · T replace head · U battery low · V RFID error · * all';
const ALERT_DESTINATIONS = 'A serial · B parallel · C e-mail · D TCP · E UDP · F SNMP trap';

Object.assign(ZPL, {
  '^PP': {
    name: 'Programmable Pause',
    does: 'Pauses the printer: ^PP after the current format prints, ~PP at once (after the label printing now). Resume with Pause or ~PS.',
    format: '^PP or ~PP',
    params: [],
  },
  '~PP': { alias: '^PP' },
  '^PQ': {
    name: 'Print Quantity',
    does: 'How many labels to print, pausing (or cutting) every so many, and how many copies of each serial number before it counts on.',
    format: '^PQq,p,r,o,e',
    params: [
      p('q', 'Quantity', 'Total labels to print.', '1–99,999,999', '1'),
      p('p', 'Pause every', 'Labels between pauses (or cuts).', '1–99,999,999', '0 (no pause)'),
      p('r', 'Replicates', 'Extra copies of each serial number (^SN) before it changes.', '0–99,999,999', '0'),
      p('o', 'No pause', 'Override the pause count: never pause.', YN, 'N'),
      p('e', 'Cut on error label', 'Cut after an RFID label that was voided.', YN, 'Y'),
    ],
  },
  '~PR': {
    name: 'Applicator Reprint',
    does: 'Reprints the last label, as the applicator’s Reprint signal would (when reprint is enabled with ^JJ).',
    format: '~PR',
    params: [],
  },
  '^PR': {
    name: 'Print Rate',
    does: 'Print, feed and backfeed speeds. Slower usually prints better; test with your media.',
    format: '^PRp,s,b',
    params: [
      p('p', 'Print speed', 'Speed while printing.', SPEED, 'A (2 ips)'),
      p('s', 'Slew speed', 'Speed while feeding a blank label.', SPEED, 'D (6 ips)'),
      p('b', 'Backfeed speed', 'Speed while pulling the label back.', SPEED, 'A (2 ips)'),
    ],
  },
  '~PS': {
    name: 'Print Start',
    does: 'Takes a paused printer out of pause, like pressing Pause.',
    format: '~PS',
    params: [],
  },
  '^PW': {
    name: 'Print Width',
    does: 'The printable width of the label, in dots.',
    format: '^PWa',
    params: [p('a', 'Width', 'Label width in dots; more than the head can print is cut to its maximum.', '2 to the head width', 'the last saved value')],
  },
  '~RO': {
    name: 'Reset Advanced Counters',
    does: 'Resets one of the printer’s odometer-style counters.',
    format: '~ROc',
    params: [p('c', 'Counter', 'Which counter to reset.', '1 user counter 1 · 2 user counter 2 · 3 valid RFID labels · 4 voided RFID labels · C head cleaned · R head replaced (and head cleaned)', 'required')],
  },
  '^SC': {
    name: 'Set Serial Communications',
    does: 'Sets up the serial port. Every parameter is needed; ^JUS keeps it after a restart.',
    format: '^SCa,b,c,d,e,f',
    params: [
      p('a', 'Baud rate', 'Speed of the line.', '110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 115200', 'required'),
      p('b', 'Data bits', 'Word length.', '7, 8', 'required'),
      p('c', 'Parity', 'Parity checking.', 'N none · E even · O odd', 'required'),
      p('d', 'Stop bits', 'Stop bits.', '1, 2', 'required'),
      p('e', 'Handshake', 'Flow control.', 'X XON/XOFF · D DTR/DSR · R RTS · M DTR/DSR and XON/XOFF', 'required'),
      p('f', 'Zebra protocol', 'Error-checking protocol.', 'A ACK/NAK · N none · Z Zebra', 'required'),
    ],
  },
  '~SD': {
    name: 'Set Darkness',
    does: 'Sets print darkness, as the darkness setting on the control panel does; ^MD adjusts relative to it.',
    format: '~SD##',
    params: [p('##', 'Darkness', 'Two digits; higher is darker.', '00–30', 'the last saved value')],
  },
  '^SE': {
    name: 'Select Encoding Table',
    does: 'Chooses a character encoding table (.DAT), used with some downloaded fonts.',
    format: '^SEd:o.x',
    params: [
      p('d', 'Drive', 'Where the table is.', 'R:, E:, B:, A:', 'R:'),
      p('o', 'Name', 'The table’s name.', '1–8 characters', 'required'),
      p('x', 'Extension', 'Always .DAT.', '.DAT', ''),
    ],
  },
  '^SF': {
    name: 'Serialization Field (with a Standard ^FD String)',
    does: 'Counts up a ^FD string from label to label, character by character according to a mask: digits, hex, letters, or left alone.',
    format: '^SFa,b',
    params: [
      p('a', 'Mask', 'One character per data character, from the right: D decimal, H hex, O octal, A letter, N letter or digit, % left alone.', 'D, H, O, A, N, %', 'required'),
      p('b', 'Increment', 'Added to the data on each label, aligned with the mask.', 'string', 'a decimal 1'),
    ],
  },
  '^SI': {
    name: 'Set Sensor Intensity',
    does: 'Sets the transmissive media sensor’s brightness or baseline, normally found by calibration.',
    format: '^SIa,b',
    params: [
      p('a', 'Setting', 'Which value to set.', '1 transmissive brightness · 2 transmissive baseline', 'required'),
      p('b', 'Value', 'The setting’s new value.', '0–196', 'required'),
    ],
  },
  '^SL': {
    name: 'Set Mode and Language (for Real-Time Clock)',
    does: 'Whether a label’s clock fields show when the format started or when the label prints, and the language of month and day names. Put it before the first ^FO.',
    format: '^SLa,b',
    params: [
      p('a', 'Mode', 'S start time (when ^XA arrived), T time now (when printed), or a number of seconds a time may lag before it is refreshed.', 'S, T, 1–999', 'S'),
      p('b', 'Language', 'Language of names like January and Monday.', '1 English · 2 Spanish · 3 French · 4 German · 5 Italian · 6 Norwegian · 7 Portuguese · 8 Swedish · 9 Danish · 10 Spanish 2 · 11 Dutch · 12 Finnish · 13 Japanese · 14 Korean · 15 Simplified Chinese · 16 Traditional Chinese · 17 Russian · 18 Polish', 'the panel language'),
    ],
  },
  '^SN': {
    name: 'Serialization Data',
    does: 'Used in place of ^FD: a value that counts up (or down) by a step on each label. Only the last number in it counts, up to 12 digits.',
    format: '^SNv,n,z',
    params: [
      p('v', 'Starting value', 'The first label’s value; may include text before the number.', 'up to 12 digits of number', '1'),
      p('n', 'Step', 'Added on each label; negative counts down.', 'up to 12 digits', '1'),
      p('z', 'Leading zeros', 'Keep the number’s width with leading zeros.', YN, 'N'),
    ],
  },
  '^SO': {
    name: 'Set Offset (for Real-Time Clock)',
    does: 'Sets the secondary or third clock as an offset from the printer’s clock -- a best-before date, say -- used through ^FC’s second and third indicators.',
    format: '^SOa,b,c,d,e,f,g',
    params: [
      p('a', 'Clock', 'Which clock to set.', '2 secondary · 3 third', 'required'),
      p('b', 'Months', 'Months to add (or take away).', '-32000 to 32000', '0'),
      p('c', 'Days', 'Days to add.', '-32000 to 32000', '0'),
      p('d', 'Years', 'Years to add.', '-32000 to 32000', '0'),
      p('e', 'Hours', 'Hours to add.', '-32000 to 32000', '0'),
      p('f', 'Minutes', 'Minutes to add.', '-32000 to 32000', '0'),
      p('g', 'Seconds', 'Seconds to add.', '-32000 to 32000', '0'),
    ],
  },
  '^SP': {
    name: 'Start Print',
    does: 'Starts printing a complicated label once the rows above the given one are formatted, while the rest is still being worked out.',
    format: '^SPa',
    params: [p('a', 'Dot row', 'Where the first printed segment ends.', '0–32000', '0')],
  },
  '^SQ': {
    name: 'Halt ZebraNet Alert',
    does: 'Stops (or restarts) the alerts for a condition being sent to a destination.',
    format: '^SQa,b,c',
    params: [
      p('a', 'Condition', 'Which alert.', ALERT_CONDITIONS, 'required'),
      p('b', 'Destination', 'Where it was going; * for all.', `${ALERT_DESTINATIONS} · *`, 'required'),
      p('c', 'Halt', 'Y stops the messages, N starts them again.', YN, 'Y'),
    ],
  },
  '^SR': {
    name: 'Set Printhead Resistance',
    does: 'Sets the printhead resistance, from the number on the head. Newer printers set it themselves; too high a value can damage the head.',
    format: '^SR####',
    params: [p('####', 'Resistance', 'Ohms, four digits.', '0488–1175', 'the last saved value')],
  },
  '^SS': {
    name: 'Set Media Sensors',
    does: 'Sets the sensor values and label length that calibration normally finds.',
    format: '^SSw,m,r,l,m2,r2,a,b,c',
    params: [
      p('w', 'Web', 'Sensor reading for the gap between labels.', '000–100', 'from calibration'),
      p('m', 'Media', 'Sensor reading for the label itself.', '000–100', 'from calibration'),
      p('r', 'Ribbon', 'Ribbon sensor reading.', '000–100', 'from calibration'),
      p('l', 'Label length', 'In dots.', '0001–32000', 'from calibration'),
      p('m2', 'Media LED', 'Intensity of the media sensor’s LED.', '000–255', 'from calibration'),
      p('r2', 'Ribbon LED', 'Intensity of the ribbon sensor’s LED.', '000–255', 'from calibration'),
      p('a', 'Mark', 'Black-mark sensor reading for the mark.', '000–100', 'from calibration'),
      p('b', 'Mark media', 'Black-mark sensor reading for the media.', '000–100', 'from calibration'),
      p('c', 'Mark LED', 'Intensity of the black-mark sensor’s LED.', '000–255', 'from calibration'),
    ],
  },
  '^ST': {
    name: 'Set Date and Time (for Real-Time Clock)',
    does: 'Sets the printer’s clock.',
    format: '^STa,b,c,d,e,f,g',
    params: [
      p('a', 'Month', '', '01–12', 'unchanged'),
      p('b', 'Day', '', '01–31', 'unchanged'),
      p('c', 'Year', '', '1998–2097', 'unchanged'),
      p('d', 'Hour', '', '00–23', 'unchanged'),
      p('e', 'Minute', '', '00–59', 'unchanged'),
      p('f', 'Second', '', '00–59', 'unchanged'),
      p('g', 'Format', 'How the hour is given.', 'A a.m. · P p.m. · M 24-hour', 'M'),
    ],
  },
  '^SX': {
    name: 'Set ZebraNet Alert',
    does: 'Sends an alert -- by e-mail, network message or SNMP trap -- when a condition (paper out, head open…) arises or clears.',
    format: '^SXa,b,c,d,e,f',
    params: [
      p('a', 'Condition', 'What to alert on.', ALERT_CONDITIONS, 'required'),
      p('b', 'Destination', 'How to send it.', ALERT_DESTINATIONS, 'required'),
      p('c', 'On set', 'Alert when the condition arises.', YN, 'Y'),
      p('d', 'On clear', 'Alert when it clears.', YN, 'N'),
      p('e', 'Address', 'E-mail address or IP address to send to.', 'address', ''),
      p('f', 'Port', 'TCP or UDP port.', '0–65535', ''),
    ],
  },
  '^SZ': {
    name: 'Set ZPL',
    does: 'Chooses between the original ZPL and ZPL II.',
    format: '^SZa',
    params: [p('a', 'Version', 'Which language.', '1 ZPL · 2 ZPL II', '2')],
  },
  '~TA': {
    name: 'Tear-off Adjust Position',
    does: 'Moves where the media stops after printing, and so where labels are torn or cut.',
    format: '~TA###',
    params: [p('###', 'Adjustment', 'Dot rows; three digits, negative moves back.', '-120 to 120', 'the last saved value')],
  },
  '^TB': {
    name: 'Text Blocks',
    does: 'A block of wrapped text of fixed width and height, with complex text layout; text that does not fit is cut off. Preferred to ^FB on newer firmware.',
    format: '^TBa,b,c',
    params: [
      orient('a', 'the last ^A rotation'),
      p('b', 'Width', 'Block width in dots.', '1 to the label width', '1'),
      p('c', 'Height', 'Block height in dots.', '1 to the label length', '1'),
    ],
  },
  '^TO': {
    name: 'Transfer Object',
    does: 'Copies stored objects from one drive to another; * is a wildcard. Files on Z: cannot be copied.',
    format: '^TOs:o.x,d:o.x',
    params: [
      p('s:o.x', 'From', 'Source drive, name and extension.', 'R:, E:, B:, A:; * wildcards', '* for name and extension'),
      p('d:o.x', 'To', 'Destination drive, and optionally a new name and extension.', 'R:, E:, B:, A:', 'required drive; same name'),
    ],
  },
  '~WC': {
    name: 'Print Configuration Label',
    does: 'Prints the configuration label: settings, network, firmware and storage. Only when the printer is idle.',
    format: '~WC',
    params: [],
  },
  '^WD': {
    name: 'Print Directory Label',
    does: 'Prints a label listing stored objects, fonts or barcodes.',
    format: '^WDd:o.x',
    params: [
      p('d', 'Drive', 'The drive to list.', 'R:, E:, B:, A:, Z:', 'R:'),
      p('o', 'Name', 'Which objects; * and ? are wildcards.', '1–8 characters', '*'),
      p('x', 'Extension', 'Which types, e.g. .FNT fonts, .BAR barcodes, .ZPL formats, .GRF graphics.', 'any extension', '*'),
    ],
  },
  '~WQ': {
    name: 'Write Query',
    does: 'Prints a label of odometer, maintenance alert or printhead history information.',
    format: '~WQquery-type',
    params: [p('query-type', 'Query', 'What to print.', 'ES error status · HA hardware address · JT head test · MA maintenance alerts · MI maintenance information · OD odometer · PH printhead life · PP plug and play · SN serial number · UI USB', 'required')],
  },
  '^XA': {
    name: 'Start Format',
    does: 'Starts a label format. Every format runs from ^XA to ^XZ.',
    format: '^XA',
    params: [],
  },
  '^XB': {
    name: 'Suppress Backfeed',
    does: 'Skips the feed to the tear-off position after this label, and so the backfeed before the next -- faster in a batch. Leave it off the last label.',
    format: '^XB',
    params: [],
  },
});

const IP_RESOLUTION = 'A all · B BOOTP · C DHCP and BOOTP · D DHCP · G gleaning only · R RARP · P permanent (fixed address)';
const ADDRESS = 'a dotted address, e.g. 192.168.1.10';

Object.assign(ZPL, {
  '^XF': {
    name: 'Recall Format',
    does: 'Recalls a format stored with ^DF; ^FN with ^FD after it fill in its numbered fields. This is how the Stored Formats tab prints.',
    format: '^XFd:o.x',
    params: [
      p('d', 'Drive', 'Where the format is.', 'R:, E:, B:, A:', 'search R:, E:, B:, A:'),
      p('o', 'Name', 'The format’s name.', '1–8 characters (longer on newer firmware)', 'UNKNOWN'),
      p('x', 'Extension', 'Always .ZPL.', '.ZPL', ''),
    ],
  },
  '^XG': {
    name: 'Recall Graphic',
    does: 'Places a stored .GRF at the field origin, optionally enlarged by whole multiples.',
    format: '^XGd:o.x,mx,my',
    params: [
      p('d', 'Drive', 'Where the graphic is.', 'R:, E:, B:, A:', 'search R:, E:, B:, A:'),
      p('o', 'Name', 'The graphic’s name.', '1–8 characters (longer on newer firmware)', 'UNKNOWN'),
      p('x', 'Extension', 'Always .GRF.', '.GRF', ''),
      p('mx', 'Scale across', 'Magnification left to right.', '1–10', '1'),
      p('my', 'Scale down', 'Magnification top to bottom.', '1–10', '1'),
    ],
  },
  '^XS': {
    name: 'Set Dynamic Media Calibration',
    does: 'Whether the printer adjusts its idea of the label length, sensor threshold and gain as it prints, to follow variations in the media.',
    format: '^XSlength,threshold,gain',
    params: [
      p('length', 'Length', 'Adjust the label length dynamically.', YN, 'Y'),
      p('threshold', 'Threshold', 'Adjust the sensor threshold dynamically.', YN, 'Y'),
      p('gain', 'Gain', 'Adjust the sensor gain dynamically.', YN, 'Y'),
    ],
  },
  '^XZ': {
    name: 'End Format',
    does: 'Ends the label format; the label prints.',
    format: '^XZ',
    params: [],
  },
  '^ZZ': {
    name: 'Printer Sleep',
    does: 'Battery printers (PA400/PT400): shut down after a period idle.',
    format: '^ZZt,b',
    params: [
      p('t', 'Idle time', 'Seconds idle before shutting down; 0 never.', '0–999999', 'the last saved value, or 0'),
      p('b', 'With labels queued', 'Shut down even with labels still waiting.', YN, 'N'),
    ],
  },
  '^KC': {
    name: 'Set Client Identifier (Option 61)',
    does: 'Sets the DHCP client identifier the print server sends.',
    format: '^KCa,b,c,d',
    params: [
      p('a', 'Enable', 'Whether to send one, and how it is given.', '0 off · 1 use the MAC address · 2 ASCII · 3 hex', '0'),
      p('b', 'Device', 'Which network interface.', '0 all · 1 wireless · 2 external wired · 3 internal wired', '1'),
      p('c', 'Prefix', 'Optional text before the identifier.', '11 ASCII characters or 22 hex digits', ''),
      p('d', 'Identifier', 'The identifier itself.', '2–60 ASCII characters or 120 hex digits', ''),
    ],
  },
  '^NB': {
    name: 'Search for Wired Print Server during Network Boot',
    does: 'Whether to look for a wired print server at start-up (older printers with both wired and wireless).',
    format: '^NBa',
    params: [p('a', 'Check', 'Look for a wired print server.', 'C check · S skip', 'S')],
  },
  '^NC': {
    name: 'Select the Primary Network Device',
    does: 'Chooses wired or wireless as the primary network interface.',
    format: '^NCa',
    params: [p('a', 'Primary', 'Which interface.', '1 wired · 2 wireless', '1')],
  },
  '~NC': {
    name: 'Network Connect',
    does: 'RS-485 networks: selects which printer, by network ID, the following data is for.',
    format: '~NC###',
    params: [p('###', 'Network ID', 'The printer’s ^NI number, three digits.', '001–999', 'required')],
  },
  '^ND': {
    name: 'Change Network Settings',
    does: 'Sets an interface’s IP settings: how it gets an address, the address itself, timeouts and the raw print port.',
    format: '^NDa,b,c,d,e,f,g,h,i,j',
    params: [
      p('a', 'Device', 'Which interface.', '1 external wired · 2 internal wired · 3 wireless', 'required'),
      p('b', 'IP resolution', 'How it gets its address.', IP_RESOLUTION, 'A'),
      p('c', 'IP address', 'The address, when it is permanent.', ADDRESS, ''),
      p('d', 'Subnet mask', '', ADDRESS, ''),
      p('e', 'Gateway', 'Default gateway.', ADDRESS, ''),
      p('f', 'WINS server', '', ADDRESS, ''),
      p('g', 'Timeout checking', 'Close idle connections.', YN, 'Y'),
      p('h', 'Timeout', 'Seconds before an idle connection is closed.', '0–9999', '300'),
      p('i', 'ARP interval', 'Minutes between ARP broadcasts; 0 none.', '0–30', '0'),
      p('j', 'Raw port', 'The TCP port for raw printing.', '1–65535', '9100'),
    ],
  },
  '^NI': {
    name: 'Network ID Number',
    does: 'RS-485 networks: gives the printer its network ID.',
    format: '^NI###',
    params: [p('###', 'Network ID', 'Three digits.', '001–999', 'required')],
  },
  '^NN': {
    name: 'Set SNMP',
    does: 'Sets the SNMP system details and community names.',
    format: '^NNa,b,c,d,e,f',
    params: [
      p('a', 'System name', 'Same as the printer name.', 'up to 17 characters', ''),
      p('b', 'Contact', 'Who to contact about the printer.', 'up to 50 characters', ''),
      p('c', 'Location', 'Where the printer is.', 'up to 50 characters', ''),
      p('d', 'Get community', 'Community name for reads.', 'up to 19 characters', 'public'),
      p('e', 'Set community', 'Community name for writes.', 'up to 19 characters', 'public'),
      p('f', 'Trap community', 'Community name for traps.', 'up to 20 characters', 'public'),
    ],
  },
  '^NP': {
    name: 'Set Primary/Secondary Device',
    does: 'Parallel-port print servers: use the printer’s or the print server’s network settings at start-up.',
    format: '^NPa',
    params: [p('a', 'Primary', 'Whose settings to use.', 'P printer · M print server', 'P')],
  },
  '~NR': {
    name: 'Set All Network Printers Transparent',
    does: 'RS-485 networks: makes every printer on the network transparent, whatever its ID.',
    format: '~NR',
    params: [],
  },
  '^NS': {
    name: 'Change Wired Networking Settings',
    does: 'Sets the wired print server’s IP settings. ^ND does the same for any interface.',
    format: '^NSa,b,c,d,e,f,g,h,i',
    params: [
      p('a', 'IP resolution', 'How it gets its address.', IP_RESOLUTION, 'A'),
      p('b', 'IP address', '', ADDRESS, ''),
      p('c', 'Subnet mask', '', ADDRESS, ''),
      p('d', 'Gateway', '', ADDRESS, ''),
      p('e', 'WINS server', '', ADDRESS, ''),
      p('f', 'Timeout checking', 'Close idle connections.', YN, 'Y'),
      p('g', 'Timeout', 'Seconds before an idle connection is closed.', '0–9999', '300'),
      p('h', 'ARP interval', 'Minutes between ARP broadcasts; 0 none.', '0–30', '0'),
      p('i', 'Raw port', 'The TCP port for raw printing.', '1–65535', '9100'),
    ],
  },
  '^NT': {
    name: 'Set SMTP',
    does: 'Sets the mail server and domain used for e-mail alerts.',
    format: '^NTa,b',
    params: [
      p('a', 'SMTP server', 'The mail server’s address.', ADDRESS, ''),
      p('b', 'Domain', 'The print server’s domain name, e.g. example.com.', 'a domain name', ''),
    ],
  },
  '~NT': {
    name: 'Set Currently Connected Printer Transparent',
    does: 'RS-485 networks: makes the printer now connected transparent.',
    format: '~NT',
    params: [],
  },
  '^NW': {
    name: 'Set Web Authentication Timeout Value',
    does: 'How long the printer’s web pages stay unlocked after the password is given.',
    format: '^NWa',
    params: [p('a', 'Timeout', 'Minutes; 0 asks for the password every time.', '0–255', '5')],
  },
  '^WA': {
    name: 'Set Antenna Parameters',
    does: 'Older wireless cards: which antennas to receive and transmit on.',
    format: '^WAa,b',
    params: [
      p('a', 'Receive', 'Receive antenna.', 'D diversity · L left · R right', 'D'),
      p('b', 'Transmit', 'Transmit antenna.', 'D diversity · L left · R right', 'D'),
    ],
  },
  '^WE': {
    name: 'Set WEP Mode',
    does: 'Older firmware: WEP wireless security and its keys. ^WX replaces it.',
    format: '^WEa,b,c,d,e,f,g,h',
    params: [
      p('a', 'Encryption', 'WEP strength.', 'OFF · 40 · 128', 'OFF'),
      p('b', 'Key index', 'Which key to use.', '1–4', '1'),
      p('c', 'Authentication', 'Open system or shared key.', 'O open · S shared key', 'O'),
      p('d', 'Key storage', 'How the keys are given.', 'H hex · S string', 'H'),
      p('e', 'Key 1', 'First key.', '10 or 26 hex digits', ''),
      p('f', 'Key 2', 'Second key.', '10 or 26 hex digits', ''),
      p('g', 'Key 3', 'Third key.', '10 or 26 hex digits', ''),
      p('h', 'Key 4', 'Fourth key.', '10 or 26 hex digits', ''),
    ],
  },
  '^WL': {
    name: 'Set LEAP Parameters',
    does: 'Older firmware: LEAP wireless authentication. ^WX replaces it.',
    format: '^WLa,b,c',
    params: [
      p('a', 'Mode', 'LEAP on or off.', 'OFF · ON', 'OFF'),
      p('b', 'User name', '', 'up to 32 characters', ''),
      p('c', 'Password', '', 'up to 32 characters', ''),
    ],
  },
  '~WL': {
    name: 'Print Network Configuration Label',
    does: 'Prints the network configuration label.',
    format: '~WL',
    params: [],
  },
  '^WP': {
    name: 'Set Wireless Password',
    does: 'Sets the four-digit wireless password (separate from the printer password); 0000 leaves wireless settings unprotected.',
    format: '^WPa,b',
    params: [
      p('a', 'Old password', 'The current wireless password.', '0000–9999', '0000'),
      p('b', 'New password', 'The new one.', '0000–9999', '0000'),
    ],
  },
  '^WR': {
    name: 'Set Transmit Rate',
    does: '802.11b print servers: which transmit rates to allow, and the transmit power.',
    format: '^WRa,b,c,d,e',
    params: [
      p('a', '1 Mb/s', 'Allow 1 Mb/s.', YN, ''),
      p('b', '2 Mb/s', 'Allow 2 Mb/s.', YN, ''),
      p('c', '5.5 Mb/s', 'Allow 5.5 Mb/s.', YN, ''),
      p('d', '11 Mb/s', 'Allow 11 Mb/s.', YN, ''),
      p('e', 'Power', 'Transmit power in milliwatts.', '1, 5, 20, 30, 50, 100', ''),
    ],
  },
  '~WR': {
    name: 'Reset Wireless Radio Card and Print Server',
    does: 'Restarts the wireless card and print server, which then rejoin the network.',
    format: '~WR',
    params: [],
  },
  '^WS': {
    name: 'Set Wireless Radio Card Values',
    does: 'Sets the network name (ESSID), mode and other radio settings.',
    format: '^WSe,o,p,h,i,j,k',
    params: [
      p('e', 'ESSID', 'The wireless network’s name; blank leaves it unchanged.', 'up to 32 characters', '125'),
      p('o', 'Mode', 'Infrastructure (through an access point) or ad hoc.', 'I infrastructure · A ad hoc', 'I'),
      p('p', 'Preamble', 'Radio preamble length.', 'L long · S short', 'L'),
      p('h', 'Wireless pulse', 'Send a keep-alive pulse, which some networks need.', '0 off · 1 on', '1'),
      p('i', 'Pulse interval', 'Seconds between pulses.', '5–300', '15'),
      p('j', 'Channel mask', 'Which channels may be used, as hex.', '0x0000–0xFFFF', '0x7FF'),
      p('k', 'International mode', 'Use the channels the access point offers.', '0 off · 1 on', '0'),
    ],
  },
  '^WX': {
    name: 'Configure Wireless Securities',
    does: 'Sets the wireless security type and its credentials in one command. Which parameters follow depends on the type.',
    format: '^WXa,...',
    params: [
      p('a', 'Security type', 'Two digits.', '01 none · 02 WEP 40-bit · 03 WEP 128-bit · 04 EAP-TLS · 05 EAP-TTLS · 06 EAP-FAST · 07 PEAP · 08 LEAP · 09 WPA PSK · 10 WPA EAP-TLS · 11 WPA EAP-TTLS · 12 WPA EAP-FAST · 13 WPA PEAP · 14 WPA LEAP · 15 Kerberos', 'required'),
      p('...', 'Settings', 'WEP keys (b–h), a user name and password (i, j), an optional private key password (k) or a pre-shared key (n), as the type needs.', '', ''),
    ],
  },
  '^HL': {
    name: 'Return RFID Data Log to Host',
    does: 'Sends the printer’s RFID data log back to the host: ~HL at once, ^HL after the formats before it.',
    format: '^HL or ~HL',
    params: [],
  },
  '~HL': { alias: '^HL' },
  '^HR': {
    name: 'Calibrate RFID Tag Position',
    does: 'Calibrates where on the label the RFID tag is best programmed, trying positions over a range, and reports a table of results. Can take minutes.',
    format: '^HRa,b,c,d,e,f,g,h,i',
    params: [
      p('a', 'Start text', 'Printed before the results table.', 'under 65 characters', 'start'),
      p('b', 'End text', 'Printed after the results table.', 'under 65 characters', 'end'),
      p('c', 'Start position', 'First position to try: millimetres forward (F) or backward (B) from the print line.', 'F0–Fxxx, B0–B30', 'B30'),
      p('d', 'End position', 'Last position to try.', 'F0–Fxxx, B0–B30', 'the label length'),
      p('e', 'Antenna and power', 'Choose the antenna and power levels automatically or manually.', 'A automatic · M manual', 'A'),
      p('f', 'Antenna', 'Antenna to use when manual.', 'model dependent', ''),
      p('g', 'Read power', 'When manual.', '0–30', ''),
      p('h', 'Write power', 'When manual.', '0–30', ''),
      p('i', 'Result', 'Whether to keep the best position found.', 'model dependent', ''),
    ],
  },
  '^RB': {
    name: 'Define EPC Data Structure',
    does: 'Defines how an RFID tag’s EPC is split into fields, for ^RF in EPC format. Kept for later formats.',
    format: '^RBn,p0,p1,p2, ..., p15',
    params: [
      p('n', 'Total bits', 'Bits in all the partitions together.', '1 to the tag’s size', '96'),
      p('p0 … p15', 'Partitions', 'Bits in each field, in order; they must add up to n.', 'up to 64 bits each', '1,…'),
    ],
  },
  '^RF': {
    name: 'Read or Write RFID Format',
    does: 'Reads or writes (encodes) an RFID tag, or its access password. The data comes from the ^FD that follows; read data can be printed through ^FN or sent back with ^HV.',
    format: '^RFo,f,b,n,m',
    params: [
      p('o', 'Operation', 'What to do.', 'W write · L write and lock · R read · P read password · S specify access and kill passwords', 'W'),
      p('f', 'Format', 'How the data is given.', 'A ASCII · H hex · E EPC (as ^RB defines)', 'H'),
      p('b', 'Start / password', 'Gen 2: the starting block (or word) to read or write, or which password.', '0 to the tag’s last block', '0'),
      p('n', 'Bytes', 'How many bytes to read or write.', '1 to the tag’s size', '1'),
      p('m', 'Memory bank', 'Gen 2 memory bank.', 'E EPC · 0 reserved · 1 EPC · 2 TID · 3 USER · A auto-adjust PC bits', 'E'),
    ],
  },
  '^RL': {
    name: 'Lock/Unlock RFID Tag Memory',
    does: 'Locks RFID tag memory: ^RLP everything permanently, ^RLB,s,n a run of blocks permanently, ^RLM,k,a,e,u each password and memory bank separately.',
    format: '^RLM,k,a,e,u',
    params: [
      p('k', 'Kill password', 'What to do with the kill password.', 'U unlock · L lock · O permanently unlock · P permanently lock', ''),
      p('a', 'Access password', 'What to do with the access password.', 'U · L · O · P', ''),
      p('e', 'EPC bank', 'What to do with the EPC memory bank.', 'U · L · O · P', ''),
      p('u', 'USER bank', 'What to do with the USER memory bank.', 'U · L · O · P', ''),
    ],
  },
  '^RS': {
    name: 'Set Up RFID Parameters',
    does: 'RFID setup: the tag type, where on the label the tag is programmed, and what happens when encoding fails.',
    format: '^RSt,p,v,n,e,a,c,s',
    params: [
      p('t', 'Tag type', 'Gen 2 is the only type current printers support.', '8 EPC Class 1 Gen 2', '8'),
      p('p', 'Program position', 'Where to stop the label to program the tag: F (forward) or B (backward) millimetres from the leading edge, or dots from the top.', 'F0–Fxxx, B0–B30, or dots', 'F0'),
      p('v', 'Void length', 'Length of the VOID printed over a failed label, in dots.', '0 to the label length', 'the label length'),
      p('n', 'Labels to try', 'How many labels to try before giving up.', '1–10', '3'),
      p('e', 'On error', 'What to do when they have all failed.', 'N drop the format · P pause · E error, then continue', 'N'),
      p('a', 'Signal', 'Applicator signal on a failed label.', 'S single pulse · D double pulse', 'S'),
      p('c', 'Certify', 'Reserved on current printers.', '', ''),
      p('s', 'Void speed', 'Print speed for VOID labels.', 'any print speed', 'the printer’s maximum'),
    ],
  },
  '^RU': {
    name: 'Read Unique RFID Chip Serialization',
    does: 'Builds a unique 38-bit serial number from the tag’s TID and puts it in the low bits of the EPC.',
    format: '^RUa,b',
    params: [
      p('a', 'Prefix', 'Bits (as 1s and 0s) to put before the serial number.', 'up to 38 binary digits', 'none'),
      p('b', 'Special character', 'Marks where the serial number goes in ^FD data, as in #H.', 'any character not otherwise in use', '#'),
    ],
  },
  '^RW': {
    name: 'Set RF Power Levels for Read and Write',
    does: 'Sets the RFID read and write power, when calibration (^HR) has not found good levels.',
    format: '^RWr,w,a',
    params: [
      p('r', 'Read power', 'Read power level.', '0–30, or H high · M medium · L low on some models', '16'),
      p('w', 'Write power', 'Write power level.', '0–30, or H · M · L', '16'),
      p('a', 'Antenna', 'Which antenna, on printers with several.', 'model dependent', 'the calibrated one'),
    ],
  },
});
