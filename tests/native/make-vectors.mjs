// Writes test vectors for the native decrypters (modules/cube-native CubeCrypto.swift / .kt):
// blobs made by lib/vault.ts, with their keys and plaintexts. Usage (from the repo root):
//   node --import ./tests/register.mjs tests/native/make-vectors.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { encryptBlob, encryptChunked } from '../../lib/vault.ts';
import { stripImageMetadata } from '../../lib/strip.ts';

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

// Metadata removal: the native ports (CubeStrip.swift / .kt) must produce exactly these bytes.
const strip = path.join(out, 'strip');
fs.mkdirSync(strip, { recursive: true });
const fixtures = new URL('../fixtures/', import.meta.url);
const inputs = new Map();
for (const f of ['photo.jpg', 'photo.heic', 'photo.png', 'photo.webp']) inputs.set(f, new Uint8Array(fs.readFileSync(new URL(f, fixtures))));
const jpg = inputs.get('photo.jpg');
const seg = (marker, body) => {
  const b = Buffer.concat([Buffer.from([0xff, marker, 0, 0]), Buffer.from(body)]);
  b.writeUInt16BE(body.length + 2, 2);
  return b;
};
inputs.set('xmp-iptc.jpg', new Uint8Array(Buffer.concat([
  jpg.subarray(0, 2),
  seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="48N"/></rdf:RDF></x:xmpmeta>'),
  seg(0xed, 'Photoshop 3.0\x008BIM\x04\x04\0\0\0\0\0\x10\x1c\x02\x5a\0\x0cCubeTestCity'),
  jpg.subarray(2),
])));
inputs.set('double.jpg', new Uint8Array(Buffer.concat([jpg, jpg])));
const broken = jpg.slice();
const t = Buffer.from(broken).indexOf('Exif\0\0') + 6;
new DataView(broken.buffer).setUint32(t + 4, 0x7fffffff, broken[t] === 0x49);
inputs.set('broken-exif.jpg', broken);
inputs.set('not-an-image.pdf', new Uint8Array(Buffer.from('%PDF-1.7 Exif\0\0MM\0*\0\0\0\x08 CubeTestMake')));
for (const [name, bytes] of inputs) {
  fs.writeFileSync(path.join(strip, `${name}.in`), bytes);
  fs.writeFileSync(path.join(strip, `${name}.out`), stripImageMetadata(bytes.slice()));
}
console.log(`${cases.length} crypto vectors and ${inputs.size} strip vectors in ${out}`);
