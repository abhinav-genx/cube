// Decrypts blobs that the native code encrypted (written by CubeCryptoTest.kt and
// crypto-check.swift into <vectors>/out/) with the JavaScript implementation.
//   node --import ./tests/register.mjs tests/native/check-native-out.mjs <vectors-dir>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chunkedSize, decryptChunked } from '../../lib/vault.ts';
import { stripDocumentMetadata } from '../../lib/docmeta.ts';
import { unzipSync } from 'fflate';

const dir = path.join(process.argv[2], 'out');
const blobs = fs.readdirSync(dir).filter((f) => f.endsWith('.blob'));
assert.ok(blobs.length > 0, 'no native output found');
for (const f of blobs) {
  const base = path.join(dir, f.slice(0, -5));
  const blob = new Uint8Array(fs.readFileSync(`${base}.blob`));
  const plain = new Uint8Array(fs.readFileSync(`${base}.plain`));
  assert.equal(blob.length, chunkedSize(plain.length), `${f}: size`);
  assert.deepEqual(decryptChunked(new Uint8Array(fs.readFileSync(`${base}.key`)), blob), plain, f);
  console.log(`PASS ${f}`);
}
console.log(`all ${blobs.length} native-encrypted blobs decrypt in JavaScript`);

// Office files cleaned natively: the same parts, with the same contents, as lib/docmeta.ts gives
// (the zip itself differs: native code stores changed parts and copies the rest still compressed).
const docDir = path.join(process.argv[2], 'doc');
const offices = fs.readdirSync(dir).filter((f) => f.endsWith('.office'));
assert.ok(offices.length > 0, 'no native Office output found');
for (const f of offices) {
  const input = new Uint8Array(fs.readFileSync(path.join(docDir, f.replace(/^(swift|kotlin)-/, ''))));
  const native = new Uint8Array(fs.readFileSync(path.join(dir, f)));
  const js = stripDocumentMetadata(input);
  if (js === input) {
    assert.deepEqual(native, input, `${f}: left as picked`);
  } else {
    const a = unzipSync(native), b = unzipSync(js);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${f}: same parts`);
    for (const k of Object.keys(b)) assert.deepEqual(a[k], b[k], `${f}: ${k}`);
    assert.equal(Object.keys(a)[0], '[Content_Types].xml', `${f}: content types first`);
  }
  console.log(`PASS ${f}`);
}
