// Writes test vectors for the native decrypters (modules/cube-native CubeCrypto.swift / .kt):
// blobs made by lib/vault.ts, with their keys and plaintexts. Usage (from the repo root):
//   node --import ./tests/register.mjs tests/native/make-vectors.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { encryptBlob, encryptChunked } from '../../lib/vault.ts';
import { stripImageMetadata } from '../../lib/strip.ts';
import { cleanXml, encodeChain, RtfCleaner, stripDocumentMetadata, SVG_RULES, xmlRules } from '../../lib/docmeta.ts';
import { stripMediaMetadata } from '../../lib/mediameta.ts';
import { deflateSync } from 'node:zlib';
import { cfbFile, docxWithPeople, epub, jxl, odt, pdfA85, pdfParmsArray, pdfTight, pptCurrentUser, summaryInfo, xlsWorkbook, pdfHexRl, pdfIndirect, pdfJpeg, pdfLzw, pdfObjStmLength, pdfPredictor, pptxPeople, RTF, SVG, xlsxPeople, zip64 } from '../fixtures/docs.mjs';
import { frame, id3, FRAME, mp3AllTags, mp4LargeBox, withInsta360Trailer, withLocationTrack } from '../fixtures/media.mjs';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { pdf15 } from '../fixtures/pdf15.mjs';

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
inputs.set('photo.jxl', jxl());
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
  ['people.docx', docxWithPeople()],
  // an XML part over PART_MAX (32 MB): native code streams it through XmlCleaner
  ['big.docx', zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8('<w:document>' + '<w:ins w:author="Jane Doe" w:id="1"><w:r><w:t>Some text here</w:t></w:r></w:ins>'.repeat(480_000) + '</w:document>'),
  })],
  ['people.xlsx', xlsxPeople()],
  ['people.pptx', pptxPeople()],
  ['meta.odt', odt()],
  ['book.epub', epub()],
  ['zip64.docx', zip64({
    '[Content_Types].xml': strToU8('<Types/>'),
    'docProps/core.xml': strToU8('<cp:coreProperties><dc:creator>Jane Doe</dc:creator></cp:coreProperties>'),
    'word/document.xml': strToU8('<w:document><w:ins w:author="Jane Doe">Text</w:ins></w:document>'),
  })],
]);
for (const [name, bytes] of office) fs.writeFileSync(path.join(doc, `${name}.office`), bytes);
// Whole-PDF cleaning, compressed object and XMP streams included: the native output is checked by
// check-native-out.mjs (same length, same bytes outside the streams, same decompressed contents).
fs.writeFileSync(path.join(doc, 'p15.pdf.full'), pdf15());
const zlib = (b) => new Uint8Array(deflateSync(Buffer.from(b)));
fs.writeFileSync(path.join(doc, 'predictor.pdf.full'), pdfPredictor(zlib));
fs.writeFileSync(path.join(doc, 'indirect.pdf.full'), pdfIndirect(zlib));
fs.writeFileSync(path.join(doc, 'jpeg.pdf.full'), pdfJpeg());
// other filters: LZW, ASCII85 and hex over run-length encode the same in every port, so these
// must come out byte for byte as JavaScript writes them; ASCII85 over Flate is compared decoded
fs.writeFileSync(path.join(doc, 'lzw.pdf.full'), pdfLzw(encodeChain));
fs.writeFileSync(path.join(doc, 'lzw-early0.pdf.full'), pdfLzw(encodeChain, 0));
fs.writeFileSync(path.join(doc, 'a85.pdf.full'), pdfA85(encodeChain));
fs.writeFileSync(path.join(doc, 'hexrl.pdf.full'), pdfHexRl(encodeChain));
{
  // 40 KB of varied text: LZW codes grow to 12 bits and the table is cleared and started again
  let seed = 1;
  const words = Array.from({ length: 6000 }, () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8).toString(36).slice(0, 5)).join(' ');
  const info = Buffer.from(`4 0 <</Author(Jane Doe)/Title(Secret plan)>> ${words}`, 'latin1');
  const body = Buffer.from(encodeChain(info, ['LZWDecode']));
  fs.writeFileSync(path.join(doc, 'lzw-big.pdf.full'), Buffer.concat([
    Buffer.from(`%PDF-1.5\n5 0 obj <</Type/ObjStm/N 1/First 4/Filter/LZWDecode/Length ${body.length}>>stream\n`, 'latin1'), body,
    Buffer.from('\nendstream endobj\n', 'latin1')]));
}
// decode parameters per filter; a stream that only fits once squeezed (zlib's best compressed it)
fs.writeFileSync(path.join(doc, 'parms-array.pdf.full'), pdfParmsArray(encodeChain));
fs.writeFileSync(path.join(doc, 'tight.pdf.full'), pdfTight((b) => new Uint8Array(deflateSync(Buffer.from(b), { level: 9, memLevel: 9 }))));
// OLE compound files (Office 97–2003): the native patches, applied, must give exactly these bytes
const cfbs = new Map([
  ['word97.doc', new Uint8Array(fs.readFileSync(new URL('doc97.doc', fixtures)))],
  ['excel-ppt.xls', cfbFile([{ name: '\u0005SummaryInformation', data: summaryInfo() }, { name: 'Workbook', data: xlsWorkbook() },
    { name: 'Current User', data: pptCurrentUser() }])],
]);
const brokenCfb = cfbs.get('excel-ppt.xls').slice();
brokenCfb.fill(0xab, 512, 1024);
cfbs.set('broken-fat.xls', brokenCfb);
for (const [name, bytes] of cfbs) {
  fs.writeFileSync(path.join(doc, `${name}.cfb.in`), bytes);
  fs.writeFileSync(path.join(doc, `${name}.cfb.out`), stripDocumentMetadata(bytes.slice()));
}
// a /Length kept inside an object stream
fs.writeFileSync(path.join(doc, 'objstm-length.pdf.full'), pdfObjStmLength(zlib));
// a /Length that does not end at "endstream" is not trusted: left as it is
const wrong = Buffer.from(pdfIndirect(zlib)).toString('latin1').replace(/6 0 obj\n(\d+)/, (_, n) => `6 0 obj\n${Number(n) - 1}`);
fs.writeFileSync(path.join(doc, 'wrong-length.pdf.full'), Buffer.from(wrong, 'latin1'));

// RTF: the native RtfCleaner must give exactly these bytes, whatever the piece sizes.
const rtfDir = path.join(out, 'rtf');
fs.mkdirSync(rtfDir, { recursive: true });
const rtfs = new Map([
  ['sample', te(RTF)],
  ['bin', te(String.raw`{\rtf1{\pict\bin10 {\author}}{\author Jane}{\*\company A}\bin3x}{}\b0abc{\*\atnauthor J\}}}`)],
  ['unclosed', te(String.raw`{\rtf1{\auth`)],
  ['brace-bin', te(String.raw`{\rtf1{\bin5 }{\a}}{\author J}{\*\bin2 }}{\bin3x{}}`)],
  ['star-escape', te(String.raw`{\rtf1{\*\{x}{\'e9}{\*}{\operator\'e9 J}{\authorx keep}}`)],
]);
for (const [name, bytes] of rtfs) {
  const c = new RtfCleaner();
  fs.writeFileSync(path.join(rtfDir, `${name}.in`), bytes);
  fs.writeFileSync(path.join(rtfDir, `${name}.out`), Buffer.concat([c.push(bytes), c.finish()]));
}

// XML: the native cleanXml must give exactly these bytes. Rules, one per line: "e <element>",
// "a <attribute pattern>", "c" (drop comments).
const xmlDir = path.join(out, 'xml');
fs.mkdirSync(xmlDir, { recursive: true });
const ruleText = (r) => [...r.elems.map((e) => `e ${e}`), ...r.attrs.map((a) => `a ${a}`), ...(r.comments ? ['c'] : [])].join('\n') + '\n';
const xmls = [
  ['svg', te(SVG), SVG_RULES],
  ['scanner', te('<!DOCTYPE r [<!ENTITY e "<x>">]><r a="1" b="2"><e b="3"/><x><x>in</x><y/>tail</x><![CDATA[<x>keep</x>]]><?pi <x>?>' +
    '<r c="file:///a" d="file:///b" c=\'http://x\'/><!-- note --><z =stray a = "s" a=\'t\'/>é</r><x>never closed'), { elems: ['x'], attrs: ['a', 'e@b', 'c^file:'], comments: true }],
  ['unterminated', te('<r a="1" <x'), { elems: [], attrs: ['a'] }],
];
for (const [name, data] of Object.entries(unzipSync(docxWithPeople()))) {
  const rules = xmlRules('ooxml', name);
  if (rules) xmls.push([`docx-${name.replace(/\//g, '_')}`, data, rules]);
}
for (const [name, data] of Object.entries(unzipSync(odt()))) {
  const rules = xmlRules('odf', name);
  if (rules) xmls.push([`odt-${name.replace(/\//g, '_')}`, data, rules]);
}
for (const [name, data, rules] of xmls) {
  fs.writeFileSync(path.join(xmlDir, `${name}.in`), data);
  fs.writeFileSync(path.join(xmlDir, `${name}.rules`), ruleText(rules));
  fs.writeFileSync(path.join(xmlDir, `${name}.out`), cleanXml(data, rules));
}

// Video and audio: the native patches, applied, must give exactly these bytes.
const mediaDir = path.join(out, 'media');
fs.mkdirSync(mediaDir, { recursive: true });
const mediaIn = new Map();
const mediaFixtures = new URL('../fixtures/media/', import.meta.url);
for (const f of fs.readdirSync(mediaFixtures).filter((f) => !f.endsWith('.sh'))) mediaIn.set(f, new Uint8Array(fs.readFileSync(new URL(f, mediaFixtures))));
mediaIn.set('large-box.mp4', mp4LargeBox());
mediaIn.set('gps.mp4', withLocationTrack(mediaIn.get('video.mp4')));
mediaIn.set('insta360.mp4', withInsta360Trailer(mediaIn.get('video.mp4')));
mediaIn.set('chained.ogg', new Uint8Array(Buffer.concat([mediaIn.get('audio.ogg'), mediaIn.get('audio.opus')])));
mediaIn.set('all-tags.mp3', mp3AllTags());
mediaIn.set('v24-footer.mp3', new Uint8Array(Buffer.concat([
  id3(4, 0x10, [frame('TIT2', 'Secret plan', 4), frame('TDRC', '2025-01-01', 4), frame('TPE1', 'Jane Doe', 4)], true), FRAME])));
mediaIn.set('v22.mp3', new Uint8Array(Buffer.concat([Buffer.from('ID3\x02\x00\x00\x00\x00\x00\x15', 'latin1'),
  Buffer.from('TT2\x00\x00\x05\x00Jane', 'latin1'), Buffer.from('TYE\x00\x00\x05\x002025', 'latin1'), Buffer.alloc(1), FRAME])));
mediaIn.set('truncated.mp4', mediaIn.get('video.mp4').subarray(0, 40));
mediaIn.set('text.txt', te('just some text, not audio at all TAG'));
for (const [name, bytes] of mediaIn) {
  fs.writeFileSync(path.join(mediaDir, `${name}.in`), bytes);
  fs.writeFileSync(path.join(mediaDir, `${name}.out`), stripMediaMetadata(bytes.slice()));
}
console.log(`${cases.length} crypto vectors, ${inputs.size} strip vectors, ${pdfs.size} PDF, ${cfbs.size} compound-file, ${office.size} Office, ${rtfs.size} RTF, ` +
  `${xmls.length} XML and ${mediaIn.size} media vectors in ${out}`);
