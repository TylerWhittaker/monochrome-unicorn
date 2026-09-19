/* Round-trip checks for the ZPL model. Run: node test/zpl.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// zpl.js is written for the inliner, which strips the module keywords.
const src = readFileSync(new URL('../src/js/zpl.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { toZpl, parseZpl, newLabel, newElement, findFieldNumbers, escapeFieldData, tokenizeZpl } = mod;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

const DPI = 300;

check('generate then parse preserves label setup', () => {
  const doc = newLabel(DPI);
  doc.width = 900; doc.height = 600; doc.orientation = 'I';
  doc.darkness = 5; doc.speed = 3; doc.copies = 2;
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
  const t = { ...newElement('text', doc, DPI), x: 120, y: 240, font: 'D', height: 48, width: 36, text: 'Hello World', rotation: 'R' };
  doc.elements = [t];
  const { doc: back, unsupported } = parseZpl(toZpl(doc), DPI);
  assert.deepEqual(unsupported, [], 'nothing should be unsupported');
  assert.equal(back.elements.length, 1);
  const got = back.elements[0];
  assert.equal(got.type, 'text');
  assert.equal(got.x, 120); assert.equal(got.y, 240);
  assert.equal(got.font, 'D'); assert.equal(got.rotation, 'R');
  assert.equal(got.height, 48); assert.equal(got.width, 36);
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
  doc.elements = [{ ...newElement('barcode', doc, DPI), x: 50, y: 60, symbology: 'code128', data: 'ABC-123', height: 90, moduleWidth: 3, showText: false }];
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
  doc.elements = [{ ...newElement('barcode', doc, DPI), symbology: 'qr', data: 'https://example.com/x?a=1', errorLevel: 'H', magnification: 6 }];
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
  const src = '^XA^PW900^LL600^FO40,100^A0N,45,45^FN1^FS^FO40,160^ADN,30,20^FN2"CITY"^FDPortland^FS^XZ';
  const { doc, unsupported } = parseZpl(src, DPI);
  assert.deepEqual(unsupported, [], 'a ^FN format should parse cleanly');
  const fields = doc.elements.filter((e) => e.type === 'field');
  assert.equal(fields.length, 2);
  assert.deepEqual(
    fields.map((f) => [f.number, f.x, f.y, f.font, f.height, f.name, f.initial]),
    [[1, 40, 100, '0', 45, '', ''], [2, 40, 160, 'D', 30, 'CITY', 'Portland']]
  );

  // Re-emitting must keep every field where it was.
  const again = parseZpl(toZpl(doc), DPI).doc.elements.filter((e) => e.type === 'field');
  assert.deepEqual(
    again.map((f) => [f.number, f.x, f.y, f.font, f.height, f.name, f.initial]),
    [[1, 40, 100, '0', 45, '', ''], [2, 40, 160, 'D', 30, 'CITY', 'Portland']]
  );
});

check('an unsupported command keeps the field origin it belonged to', () => {
  const { doc } = parseZpl('^XA^FO70,90^SNSERIAL,1,Y^FS^XZ', DPI);
  const out = toZpl(doc);
  assert.ok(out.includes('^FO70,90'), `origin lost: ${out}`);
  assert.ok(out.indexOf('^FO70,90') < out.indexOf('^SN'), 'origin must precede the command it positions');
});

check('unknown commands are reported and preserved', () => {
  const { doc, unsupported } = parseZpl('^XA^PW600^FO10,10^A0N,30,30^FDhi^FS^BY2^SNSERIAL,1,Y^XZ', DPI);
  assert.ok(unsupported.includes('^SN'), `expected ^SN in ${JSON.stringify(unsupported)}`);
  assert.ok(toZpl(doc).includes('^SN'), 'unsupported command must survive regeneration');
});

check('^FN fields are discovered in order, with names and defaults', () => {
  const fields = findFieldNumbers('^XA^FO10,10^FN3"CITY"^FS^FO10,50^FN1^FS^FO10,90^FN2^FDdefault^FS^XZ');
  assert.deepEqual(fields.map((f) => f.number), [1, 2, 3]);
  assert.equal(fields.find((f) => f.number === 3).name, 'CITY');
  assert.equal(fields.find((f) => f.number === 2).initial, 'default');
  assert.equal(fields.find((f) => f.number === 1).initial, '');
});

check('a filled format recall escapes field data', () => {
  const zpl = mod.buildFormatCall('E', 'SHIP.ZPL', [[1, 'A^B'], [2, 'plain']]);
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

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
