// Writes test vectors for the native decrypters (modules/cube-native CubeCrypto.swift / .kt):
// blobs made by lib/vault.ts, with their keys and plaintexts. Usage (from the repo root):
//   node --import ./tests/register.mjs tests/native/make-vectors.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { encryptBlob, encryptChunked } from '../../lib/vault.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: make-vectors.mjs <out-dir>');
fs.mkdirSync(out, { recursive: true });
const bytes = (n, seed) => new Uint8Array(n).map((_, i) => (i * 131 + seed * 17 + (i >> 8)) & 0xff);
const cases = [];
const add = (name, format, key, plain, blob, ok = true) => {
  for (const [ext, data] of [['key', key], ['plain', plain], ['blob', blob]]) fs.writeFileSync(path.join(out, `${name}.${ext}`), data);
  cases.push({ name, format, ok });
};
let seed = 1;
for (const n of [0, 1, 1000, 65_535, 65_536, 65_537, 200_000]) {
  const key = bytes(32, seed++);
  const plain = bytes(n, seed++);
  add(`v2-${n}`, 2, key, plain, encryptChunked(key, plain));
  add(`v1-${n}`, 1, key, plain, encryptBlob(key, plain));
}
const key = bytes(32, 99);
const blob = encryptChunked(key, bytes(150_000, 98));
const flipped = blob.slice();
flipped[blob.length - 5] ^= 1;
add('v2-tampered', 2, key, new Uint8Array(0), flipped, false);
add('v2-truncated', 2, key, new Uint8Array(0), blob.subarray(0, blob.length - 65_552), false);
add('v2-wrong-key', 2, bytes(32, 97), new Uint8Array(0), blob, false);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(cases, null, 1));
console.log(`${cases.length} vectors in ${out}`);
