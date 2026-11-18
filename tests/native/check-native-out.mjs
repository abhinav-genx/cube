// Decrypts blobs that the native code encrypted (written by CubeCryptoTest.kt and
// crypto-check.swift into <vectors>/out/) with the JavaScript implementation.
//   node --import ./tests/register.mjs tests/native/check-native-out.mjs <vectors-dir>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chunkedSize, decryptChunked } from '../../lib/vault.ts';

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
