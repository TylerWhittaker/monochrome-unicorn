/* Parsing of the preprocessor's helper files. Run: node test/printer.test.mjs */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/js/printer.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { parseVarFile, decodeEntities, valuesMatch, extractPrinterError } = mod;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

check('reads framed name=value pairs', () => {
  const v = parseVarFile('@media.status=ok@\n@media.type=label@\n');
  assert.deepEqual(v, { 'media.status': 'ok', 'media.type': 'label' });
});

check('a value may span lines', () => {
  const v = parseVarFile('@device.host_status=412,0,0\n128,0,0\n0000,0@\n@appl.name=V74@\n');
  assert.equal(v['device.host_status'], '412,0,0\n128,0,0\n0000,0');
  assert.equal(v['appl.name'], 'V74');
});

check('the preprocessor’s entity escaping is undone', () => {
  // Exactly what the printer returned for device.location = A&B "q" <t> 'ap'
  const v = parseVarFile('@device.location=A&amp;B &quot;q&quot; &lt;t&gt; &apos;ap&apos;@\n');
  assert.equal(v['device.location'], 'A&B "q" <t> \'ap\'');
});

check('double-escaped text decodes only one level', () => {
  assert.equal(decodeEntities('&amp;quot;'), '&quot;');
});

check('numeric character references decode', () => {
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
});

check('an unknown entity is left alone', () => {
  assert.equal(decodeEntities('100&percnt; &bogus; ok'), '100&percnt; &bogus; ok');
});

check('an empty value is kept', () => {
  assert.deepEqual(parseVarFile('@device.location=@\n'), { 'device.location': '' });
});

check('write verification tolerates the printer’s normalisation', () => {
  assert.ok(valuesMatch('5.0', '5'));
  assert.ok(valuesMatch('ON', 'on'));
  assert.ok(!valuesMatch('label', 'journal'));
  // The read-back of a value containing & must now compare equal.
  assert.ok(valuesMatch('A&B', 'A&B'));
});

check('printer error pages are recognised', () => {
  assert.equal(extractPrinterError('<P><B>ERROR:</B> Invalid password.</P>'), 'Invalid password.');
  assert.equal(extractPrinterError('<H3>The script save has been queued.</H3>'), null);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
