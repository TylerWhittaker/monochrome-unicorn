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

/* Round-trip checks for the ZPL model. Run: node test/zpl.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// zpl.js is written for the inliner, which strips the module keywords.
const src = readFileSync(new URL('../src/js/zpl.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const {
  toZpl,
  parseZpl,
  newLabel,
  newElement,
  findFieldNumbers,
  escapeFieldData,
  tokenizeZpl,
  nextFieldNumber,
  formatZpl,
  expandClock,
  elementZpl,
  isStoredFont,
  storedFonts,
  SYMBOLOGIES,
} = mod;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const DPI = 300;

check('generate then parse preserves label setup', () => {
  const doc = newLabel(DPI);
  doc.width = 900;
  doc.height = 600;
  doc.orientation = 'I';
  doc.darkness = 5;
  doc.speed = 3;
  doc.copies = 2;
  const { doc: back } = parseZpl(toZpl(doc), DPI);
  assert.equal(back.width, 900);
  assert.equal(back.height, 600);
  assert.equal(back.orientation, 'I');
  assert.equal(back.darkness, 5);
  assert.equal(back.speed, 3);
  assert.equal(back.copies, 2);
});

check('text round-trips position, font, size and content', () => {
  const doc = newLabel(DPI);
  const t = {
    ...newElement('text', doc, DPI),
    x: 120,
    y: 240,
    font: 'D',
    height: 48,
    width: 36,
    text: 'Hello World',
    rotation: 'R',
  };
  doc.elements = [t];
  const { doc: back, unsupported } = parseZpl(toZpl(doc), DPI);
  assert.deepEqual(unsupported, [], 'nothing should be unsupported');
  assert.equal(back.elements.length, 1);
  const got = back.elements[0];
  assert.equal(got.type, 'text');
  assert.equal(got.x, 120);
  assert.equal(got.y, 240);
  assert.equal(got.font, 'D');
  assert.equal(got.rotation, 'R');
  assert.equal(got.height, 48);
  assert.equal(got.width, 36);
  assert.equal(got.text, 'Hello World');
});

check('caret and tilde in text survive the round-trip', () => {
  const doc = newLabel(DPI);
  doc.elements = [{ ...newElement('text', doc, DPI), text: 'A^B~C_D\\E' }];
  const zpl = toZpl(doc);
  assert.ok(!/\^FDA\^B/.test(zpl), 'raw caret must not reach the field data');
  const { doc: back } = parseZpl(zpl, DPI);
  assert.equal(back.elements[0].text, 'A^B~C_D\\E');
});

check('1D barcode round-trips', () => {
  const doc = newLabel(DPI);
  doc.elements = [
    {
      ...newElement('barcode', doc, DPI),
      x: 50,
      y: 60,
      symbology: 'code128',
      data: 'ABC-123',
      height: 90,
      moduleWidth: 3,
      showText: false,
    },
  ];
  const { doc: back, unsupported } = parseZpl(toZpl(doc), DPI);
  assert.deepEqual(unsupported, []);
  const got = back.elements[0];
  assert.equal(got.type, 'barcode');
  assert.equal(got.symbology, 'code128');
  assert.equal(got.data, 'ABC-123');
  assert.equal(got.height, 90);
  assert.equal(got.moduleWidth, 3);
  assert.equal(got.showText, false);
});

check('QR round-trips data and error level', () => {
  const doc = newLabel(DPI);
  doc.elements = [
    {
      ...newElement('barcode', doc, DPI),
      symbology: 'qr',
      data: 'https://example.com/x?a=1',
      errorLevel: 'H',
      magnification: 6,
    },
  ];
  const { doc: back } = parseZpl(toZpl(doc), DPI);
  const got = back.elements[0];
  assert.equal(got.symbology, 'qr');
  assert.equal(got.data, 'https://example.com/x?a=1');
  assert.equal(got.errorLevel, 'H');
  assert.equal(got.magnification, 6);
});

check('box and line stay distinct', () => {
  const doc = newLabel(DPI);
  doc.elements = [
    { ...newElement('box', doc, DPI), x: 10, y: 20, w: 300, h: 150, thickness: 4, rounding: 2 },
    { ...newElement('line', doc, DPI), x: 10, y: 400, length: 500, thickness: 3, vertical: false },
  ];
  const { doc: back } = parseZpl(toZpl(doc), DPI);
  assert.equal(back.elements[0].type, 'box');
  assert.equal(back.elements[0].w, 300);
  assert.equal(back.elements[0].rounding, 2);
  assert.equal(back.elements[1].type, 'line');
  assert.equal(back.elements[1].length, 500);
  assert.equal(back.elements[1].vertical, false);
});

check('image round-trips its source object', () => {
  const doc = newLabel(DPI);
  doc.elements = [{ ...newElement('image', doc, DPI), x: 5, y: 7, source: 'E:LOGO.PNG' }];
  const { doc: back } = parseZpl(toZpl(doc), DPI);
  assert.equal(back.elements[0].type, 'image');
  assert.equal(back.elements[0].source, 'E:LOGO.PNG');
});

check('^FN placeholders keep position, font and default', () => {
  const src =
    '^XA^PW900^LL600^FO40,100^A0N,45,45^FN1^FS^FO40,160^ADN,30,20^FN2"CITY"^FDPortland^FS^XZ';
  const { doc, unsupported } = parseZpl(src, DPI);
  assert.deepEqual(unsupported, [], 'a ^FN format should parse cleanly');
  const fields = doc.elements.filter((e) => e.type === 'field');
  assert.equal(fields.length, 2);
  assert.deepEqual(
    fields.map((f) => [f.number, f.x, f.y, f.font, f.height, f.name, f.initial]),
    [
      [1, 40, 100, '0', 45, '', ''],
      [2, 40, 160, 'D', 30, 'CITY', 'Portland'],
    ],
  );

  // Re-emitting must keep every field where it was.
  const again = parseZpl(toZpl(doc), DPI).doc.elements.filter((e) => e.type === 'field');
  assert.deepEqual(
    again.map((f) => [f.number, f.x, f.y, f.font, f.height, f.name, f.initial]),
    [
      [1, 40, 100, '0', 45, '', ''],
      [2, 40, 160, 'D', 30, 'CITY', 'Portland'],
    ],
  );
});

check('an unsupported command keeps the field origin it belonged to', () => {
  const { doc } = parseZpl('^XA^FO70,90^SNSERIAL,1,Y^FS^XZ', DPI);
  const out = toZpl(doc);
  assert.ok(out.includes('^FO70,90'), `origin lost: ${out}`);
  assert.ok(
    out.indexOf('^FO70,90') < out.indexOf('^SN'),
    'origin must precede the command it positions',
  );
});

check('a stored GRF uses ^XG and round-trips its scale', () => {
  const doc = newLabel(DPI);
  doc.elements = [
    { ...newElement('image', doc, DPI), x: 12, y: 34, source: 'E:LOGO.GRF', scaleX: 2, scaleY: 3 },
  ];
  const zpl = toZpl(doc);
  assert.ok(zpl.includes('^XGE:LOGO.GRF,2,3'), zpl);
  const got = parseZpl(zpl, DPI).doc.elements[0];
  assert.equal(got.source, 'E:LOGO.GRF');
  assert.equal(got.scaleX, 2);
  assert.equal(got.scaleY, 3);
  assert.equal(got.x, 12);
});

check('other image formats still use ^IM', () => {
  const doc = newLabel(DPI);
  doc.elements = [{ ...newElement('image', doc, DPI), source: 'E:PHOTO.PNG' }];
  assert.ok(toZpl(doc).includes('^IME:PHOTO.PNG'));
});

check('unknown commands are reported and preserved', () => {
  const { doc, unsupported } = parseZpl('^XA^PW600^FO10,10^A0N,30,30^FDhi^FS^BY2^FWR^XZ', DPI);
  assert.ok(unsupported.includes('^FW'), `expected ^FW in ${JSON.stringify(unsupported)}`);
  assert.ok(toZpl(doc).includes('^FW'), 'unsupported command must survive regeneration');
});

check('^FN fields are discovered in order, with names and defaults', () => {
  const fields = findFieldNumbers(
    '^XA^FO10,10^FN3"CITY"^FS^FO10,50^FN1^FS^FO10,90^FN2^FDdefault^FS^XZ',
  );
  assert.deepEqual(
    fields.map((f) => f.number),
    [1, 2, 3],
  );
  assert.equal(fields.find((f) => f.number === 3).name, 'CITY');
  assert.equal(fields.find((f) => f.number === 2).initial, 'default');
  assert.equal(fields.find((f) => f.number === 1).initial, '');
});

check('a filled format recall escapes field data', () => {
  const zpl = mod.buildFormatCall('E', 'SHIP.ZPL', [
    [1, 'A^B'],
    [2, 'plain'],
  ]);
  assert.ok(zpl.includes('^XFE:SHIP.ZPL^FS'));
  assert.ok(zpl.includes('^FN1^FH^FDA_5EB^FS'));
  assert.ok(zpl.includes('^FN2^FH^FDplain^FS'));
});

check('tokenizer handles ^A font suffix', () => {
  const tokens = tokenizeZpl('^A0N,30,30^AAN,18,10');
  assert.equal(tokens[0].cmd, 'A');
  assert.equal(tokens[0].args, '0N,30,30');
  assert.equal(tokens[1].args, 'AN,18,10');
});

check('a duplicated field takes the next free ^FN number', () => {
  const doc = {
    elements: [
      { type: 'field', number: 1 },
      { type: 'text', text: 'not a field' },
      { type: 'field', number: 7 },
    ],
    passthrough: [],
  };
  assert.equal(nextFieldNumber(doc), 8);
});

check('^FN numbers the canvas does not model still count', () => {
  // A field inside a command the visual editor kept verbatim would
  // otherwise be handed out a second time.
  const doc = {
    elements: [{ type: 'field', number: 2 }],
    passthrough: ['^FO10,10^FN12"lot"^FS'],
  };
  assert.equal(nextFieldNumber(doc), 13);
});

check('a label with no fields starts at one', () => {
  assert.equal(nextFieldNumber({ elements: [], passthrough: [] }), 1);
  assert.equal(nextFieldNumber({}), 1);
});

check('formatting puts one field on a line, and nothing else', () => {
  const out = formatZpl('^XA^PW600^LL200^FO50,50^A0N,30,30^FDHello^FS^FO50,99^GB10,10,2^FS^XZ');
  assert.deepEqual(out.trim().split('\n'), [
    '^XA',
    '^PW600',
    '^LL200',
    '^FO50,50^A0N,30,30^FDHello^FS',
    '^FO50,99^GB10,10,2^FS',
    '^XZ',
  ]);
});

check('formatting only moves line breaks; every byte survives', () => {
  const src = '^XA^FO10,10^FDone^FS\r\n^FO10,40^FDtwo^FS^XZ';
  const strip = (t) => t.replace(/\s/g, '');
  assert.equal(strip(formatZpl(src)), strip(src));
  assert.equal(formatZpl(formatZpl(src)), formatZpl(src), 'and it settles after one pass');
});

check('a caret inside field data does not split the line', () => {
  // ^FD data is taken verbatim to ^FS, so a caret in it is text, not a
  // command, and a line break there would change what prints.
  const out = formatZpl('^XA^FO10,10^FDprice ^ 5^FS^XZ').trim().split('\n');
  assert.deepEqual(out, ['^XA', '^FO10,10^FDprice ^ 5^FS', '^XZ']);
});

check('^CT~ keeps its argument', () => {
  // The tilde is what ^CT sets the control character to. Read as a
  // command it used to become a line of its own that never settled.
  assert.deepEqual(formatZpl('^XA^CT~^FWN^XZ').trim().split('\n'), ['^XA', '^CT~', '^FWN', '^XZ']);
  const tokens = tokenizeZpl('^CT~^FWN');
  assert.deepEqual(
    tokens.map((t) => t.cmd),
    ['CT', 'FW'],
  );
});

check('a date element is written as ^FC then ^FD, and read back', () => {
  const doc = newLabel(DPI);
  const item = newElement('date', doc, DPI);
  item.x = 40;
  item.y = 50;
  item.format = '%Y-%m-%d %H:%M';
  doc.elements.push(item);
  const zpl = toZpl(doc);
  assert.match(zpl, /\^FO40,50\^A0N,\d+,\d+\^FC%\^FH\^FD%Y-%m-%d %H:%M\^FS/);
  const back = parseZpl(zpl, DPI).doc.elements;
  assert.equal(back.length, 1);
  assert.equal(back[0].type, 'date');
  assert.equal(back[0].format, '%Y-%m-%d %H:%M');
  assert.equal(back[0].clock, '%');
  assert.equal(back[0].height, item.height);
});

check('a hand-written clock field with its own indicators opens as a date', () => {
  const { doc, unsupported } = parseZpl('^XA^FO10,20^ADR,36,20^FC{,#^FDMade {d/{m ^FS^XZ', DPI);
  assert.deepEqual(unsupported, []);
  const [item] = doc.elements;
  assert.equal(item.type, 'date');
  assert.equal(item.clock, '{,#');
  assert.equal(item.format, 'Made {d/{m ');
  assert.equal(item.rotation, 'R');
  assert.equal(item.font, 'D');
  assert.match(toZpl(doc), /\^FC\{,#\^FH\^FDMade \{d\/\{m \^FS/);
});

check('a reversed, wrapped clock field keeps ^FR and ^FB', () => {
  const src = '^XA^FO5,5^A0N,30,30^FB400,1,0,C,0^FR^FC%^FH^FD%d %B^FS^XZ';
  const { doc } = parseZpl(src, DPI);
  assert.equal(doc.elements[0].type, 'date');
  assert.match(toZpl(doc), /\^FO5,5\^A0N,30,30\^FB400,1,0,C,0\^FR\^FC%\^FH\^FD%d %B\^FS/);
});

check('^FC on a barcode or a ^FN field survives a round trip', () => {
  const src = [
    '^XA',
    '^FO10,10^BY2,3,50^BCN,50,Y,N,N^FC%^FD%y%j^FS',
    '^FO10,90^A0N,30,30^FC%^FN3^FD%m/%d^FS',
    '^XZ',
  ].join('\n');
  const { doc } = parseZpl(src, DPI);
  assert.deepEqual(
    doc.elements.map((e) => [e.type, e.clock]),
    [
      ['barcode', '%'],
      ['field', '%'],
    ],
  );
  const out = toZpl(doc);
  assert.match(out, /\^BCN,50,Y,N,N\^FC%\^FH\^FD%y%j\^FS/);
  assert.match(out, /\^FC%\^FN3\^FH\^FD%m\/%d\^FS/);
});

check('expandClock fills in what the printer will', () => {
  const at = new Date(2026, 0, 5, 14, 7, 9); // Monday 5 January 2026
  assert.equal(expandClock('%m/%d/%Y', '%', at), '01/05/2026');
  assert.equal(expandClock('%a %d %b %y', '%', at), 'Mon 05 Jan 26');
  assert.equal(expandClock('%A, %B', '%', at), 'Monday, January');
  assert.equal(expandClock('%H:%M:%S = %I%p', '%', at), '14:07:09 = 02PM');
  assert.equal(expandClock('day %j, wd %w', '%', at), 'day 005, wd 01');
  // 2026 starts on a Thursday: the 4th is the first Sunday, the 5th the first Monday.
  assert.equal(expandClock('%U %W', '%', at), '01 01');
  assert.equal(expandClock('#d %d %q', '#,{', at), '05 %d %q', 'only the primary indicator');
});

check('a new label takes the size it is given, else 4x6 inches', () => {
  const sized = newLabel(300, { width: 1200, height: 1800 });
  assert.equal(sized.width, 1200);
  assert.equal(sized.height, 1800);
  const half = newLabel(203, { width: 600 });
  assert.deepEqual([half.width, half.height], [600, 1218]);
  assert.deepEqual([newLabel(203).width, newLabel(203).height], [812, 1218]);
});

check('a char width equal to the height is read as following it', () => {
  const src = '^XA^FO10,10^A0N,40,40^FDsame^FS^FO10,60^A0N,40,25^FDnarrow^FS^XZ';
  const { doc } = parseZpl(src, DPI);
  assert.equal(doc.elements[0].width, 0, 'follows the height');
  assert.equal(doc.elements[1].width, 25, 'set on its own');
  assert.match(toZpl(doc), /\^A0N,40,40\^FH\^FDsame/, 'and is written back the same');
});

check('a label with no fields yet has nothing the visual editor would lose', () => {
  assert.deepEqual(parseZpl(toZpl(newLabel(DPI)), DPI).unsupported, []);
  assert.deepEqual(parseZpl('^XA\n^XZ', DPI).unsupported, []);
  assert.deepEqual(parseZpl('', DPI).unsupported, []);
});

check('text that is not ZPL at all is flagged', () => {
  assert.deepEqual(parseZpl('N\nA50,0,0,1,1,1,N,"hi"\nP1\n', DPI).unsupported, [
    '(text that is not ZPL)',
  ]);
});

const roundTrip = (items) => {
  const doc = newLabel(DPI);
  doc.elements = items;
  const zpl = toZpl(doc);
  const { doc: back, unsupported } = parseZpl(zpl, DPI);
  assert.deepEqual(unsupported, [], `nothing unmodelled in ${zpl}`);
  assert.equal(toZpl(back), zpl, 'regenerates the same ZPL');
  return { zpl, back: back.elements };
};

check('a serial number is ^SN in place of ^FD, and comes back as one', () => {
  const doc = newLabel(DPI);
  const item = newElement('serial', doc, DPI);
  const { zpl, back } = roundTrip([item]);
  assert.match(zpl, /\^A0N,\d+,\d+\^SN0001,1,Y\^FS/);
  assert.equal(back[0].type, 'text');
  assert.equal(back[0].text, '0001');
  assert.deepEqual(back[0].serial, { step: 1, zeros: true });
});

check('a barcode can count too, downwards', () => {
  const item = {
    ...newElement('barcode', newLabel(DPI), DPI),
    data: 'LOT100',
    serial: { step: -5, zeros: false },
  };
  const { zpl, back } = roundTrip([item]);
  assert.match(zpl, /\^BC[^^]*\^SNLOT100,-5,N\^FS/);
  assert.deepEqual(back[0].serial, { step: -5, zeros: false });
});

check('a serial starting value drops what ^SN cannot carry', () => {
  const item = { ...newElement('serial', newLabel(DPI), DPI), text: 'A,B^C~1' };
  assert.match(elementZpl(item), /\^SNABC1,1,Y/);
});

check('an ellipse is ^GE, a circle ^GC', () => {
  const doc = newLabel(DPI);
  const oval = { ...newElement('ellipse', doc, DPI), w: 200, h: 100, thickness: 4 };
  const round = { ...newElement('ellipse', doc, DPI), w: 150, h: 150, thickness: 2, invert: true };
  const { zpl, back } = roundTrip([oval, round]);
  assert.match(zpl, /\^GE200,100,4,B\^FS/);
  assert.match(zpl, /\^GC150,2,W\^FS/);
  assert.equal(back[1].type, 'ellipse');
  assert.equal(back[1].h, 150);
  assert.equal(back[1].invert, true);
});

check('a diagonal line is ^GD, leaning either way', () => {
  const doc = newLabel(DPI);
  const up = { ...newElement('line', doc, DPI), diagonal: true, w: 300, h: 100, lean: 'R' };
  const down = { ...up, id: 'x', lean: 'L' };
  const { zpl, back } = roundTrip([up, down]);
  assert.match(zpl, /\^GD300,100,3,B,R\^FS/);
  assert.match(zpl, /\^GD300,100,3,B,L\^FS/);
  assert.equal(back[0].diagonal, true);
  assert.equal(back[1].lean, 'L');
});

check('vertical and reverse text are ^FP', () => {
  const doc = newLabel(DPI);
  const item = { ...newElement('text', doc, DPI), direction: 'V' };
  const { zpl, back } = roundTrip([item]);
  assert.match(zpl, /\^FPV,0/);
  assert.equal(back[0].direction, 'V');
});

check('a stored TrueType font is recalled with ^A@', () => {
  const doc = newLabel(DPI);
  const item = { ...newElement('text', doc, DPI), font: 'E:TT0003M_.TTF', height: 40 };
  const { zpl, back } = roundTrip([item]);
  assert.match(zpl, /\^A@N,40,40,E:TT0003M_\.TTF\^FH\^FD/);
  assert.equal(back[0].font, 'E:TT0003M_.TTF');
  assert.equal(isStoredFont(back[0].font), true);
});

check('only TrueType fonts join the font list, and not font 0 itself', () => {
  const files = [
    { name: 'E:TT0003M_.TTF', dev: 'E', oname: 'TT0003M_', otype: 'TTF' },
    { name: 'Z:0.TTF', dev: 'Z', oname: '0', otype: 'TTF' },
    { name: 'Z:A.FNT', dev: 'Z', oname: 'A', otype: 'FNT' },
  ];
  assert.deepEqual(
    storedFonts(files).map((f) => f.value),
    ['E:TT0003M_.TTF'],
  );
});

check('every symbology survives a round trip as itself', () => {
  const doc = newLabel(DPI);
  for (const [key, spec] of Object.entries(SYMBOLOGIES)) {
    const item = { ...newElement('barcode', doc, DPI), symbology: key, data: spec.example };
    const { back } = roundTrip([item]);
    assert.equal(back[0].symbology, key, `${key} came back as ${back[0].symbology}`);
    assert.equal(back[0].data, spec.example, key);
  }
});

check('GS1-128 is Code 128 in UCC/EAN mode', () => {
  const item = { ...newElement('barcode', newLabel(DPI), DPI), symbology: 'gs1_128' };
  assert.match(elementZpl(item), /\^BCN,\d+,Y,N,N,D\^FH\^FD/);
});

check('the postal codes are one command with a type', () => {
  const doc = newLabel(DPI);
  const imb = { ...newElement('barcode', doc, DPI), symbology: 'imb', showText: false };
  assert.match(elementZpl(imb), /\^BZN,\d+,N,N,3\^/);
  // ^B5 is PLANET on its own.
  const { doc: back } = parseZpl('^XA^FO10,10^B5N,40,N,N^FD12345678901^FS^XZ', DPI);
  assert.equal(back.elements[0].symbology, 'planet');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
