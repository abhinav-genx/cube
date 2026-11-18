// Writes test vectors for the native decrypters (modules/cube-native CubeCrypto.swift / .kt):
// blobs made by lib/vault.ts, with their keys and plaintexts. Usage (from the repo root):
//   node --import ./tests/register.mjs tests/native/make-vectors.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { encryptBlob, encryptChunked } from '../../lib/vault.ts';
import { stripImageMetadata } from '../../lib/strip.ts';
import { stripDocumentMetadata } from '../../lib/docmeta.ts';
import { strToU8, zipSync } from 'fflate';

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
// Documents. PDFs: CubeDocClean's PdfCleaner must give exactly these bytes, whatever the piece sizes.
// Office files: the native output is checked by check-native-out.mjs (same parts as lib/docmeta.ts).
const doc = path.join(out, 'doc');
fs.mkdirSync(doc, { recursive: true });
const te = (t) => new TextEncoder().encode(t);
const pdfs = new Map([
  ['real.pdf', new Uint8Array(fs.readFileSync(new URL('doc.pdf', fixtures)))],
  ['tricky.pdf', te(String.raw`%PDF-1.4 /Title (a\) b) /Author (x\) (y) z) /Producer <41 42> /Creator<</Author (n)>> /Keywords9 (k) ` +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" q="1"><rdf:RDF><dc:creator>Jane</dc:creator></rdf:RDF></x:xmpmeta> <rdf:RDF a="b">' +
    'Doe and some more text so the packet is long enough to hold the empty tag</rdf:RDF> <x:xmpmeta> unclosed')],
]);
// a large one: strings and packets across 64 KiB and 1 MiB boundaries
const filler = (n) => 'stream ' + 'q'.repeat(n) + ' endstream ';
pdfs.set('large.pdf', te('%PDF-1.7 ' + filler(65_520) + '/Author (Straddling the boundary)' + filler(1_048_000) +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">' + 'Jane Doe '.repeat(4000) + '</x:xmpmeta>' + filler(70_000) + '/Subject <4A616E65>'));
for (const [name, bytes] of pdfs) {
  fs.writeFileSync(path.join(doc, `${name}.in`), bytes);
  fs.writeFileSync(path.join(doc, `${name}.out`), stripDocumentMetadata(bytes.slice()));
}
const office = new Map([
  ['real.docx', new Uint8Array(fs.readFileSync(new URL('doc.docx', fixtures)))],
  ['descriptor.docx', new Uint8Array(fs.readFileSync(new URL('doc-descriptor.docx', fixtures)))],
  ['custom.xlsx', zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'docProps/custom.xml': strToU8('<Properties><property name="Client"><vt:lpwstr>Big Client Ltd</vt:lpwstr></property></Properties>'),
    'xl/workbook.xml': strToU8('<workbook/>'),
  })],
  ['plain.zip', zipSync({ 'a.txt': strToU8('not an office file') })],
  ['clean.docx', zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<w:document/>') })],
]);
for (const [name, bytes] of office) fs.writeFileSync(path.join(doc, `${name}.office`), bytes);
console.log(`${cases.length} crypto vectors, ${inputs.size} strip vectors, ${pdfs.size} PDF and ${office.size} Office vectors in ${out}`);
