import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import fs from 'node:fs';
import { cleanXml, DOC_LIMIT, documentKind, isCleanableDocument, PdfCleaner, RtfCleaner, stripDocumentMetadata, stripSvg } from '../lib/docmeta.ts';
import { stripImageMetadata } from '../lib/strip.ts';
import { docxWithPeople, odt, photo, predictUp, RTF, RTF_CLEAN, zip64 } from './fixtures/docs.mjs';

const enc = (s) => new TextEncoder().encode(s);
const text = (b) => Buffer.from(b).toString('latin1');

/** A small but structurally real PDF: an info dictionary with literal and hex strings, and XMP. */
function pdf() {
  return enc(
    '%PDF-1.4\n' +
      '1 0 obj << /Type /Catalog /Pages 2 0 R /Metadata 4 0 R >> endobj\n' +
      '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n' +
      '3 0 obj << /Author (Jane \\(J.\\) Doe (Acme)) /Creator (Word for Acme) /Producer <4163 6D65> ' +
      '/Title (Secret plan) /CreationDate (D:20250101120000Z) /AuthorX (keep) >> endobj\n' +
      '4 0 obj << /Type /Metadata /Subtype /XML /Length 120 >> stream\n' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description dc:creator="Jane Doe" pdf:Producer="Acme"/></rdf:RDF></x:xmpmeta>\n' +
      'endstream endobj\n' +
      'trailer << /Root 1 0 R /Info 3 0 R >>\n%%EOF\n',
  );
}

test('PDF: author, creator, producer and title are blanked in place; dates and other keys stay', () => {
  const input = pdf();
  const out = stripDocumentMetadata(input.slice());
  assert.equal(out.length, input.length, 'same length: every offset in the file stays valid');
  const t = text(out);
  for (const s of ['Jane', 'Acme', 'Secret plan', 'Word for', '4163']) assert.ok(!t.includes(s), `${s} left`);
  assert.ok(t.includes('/Author ('), 'the key and its string remain, empty');
  assert.ok(t.includes('(D:20250101120000Z)'), 'creation date kept');
  assert.ok(t.includes('/AuthorX (keep)'), 'a different key that only starts the same is untouched');
  assert.match(t, /<x:xmpmeta xmlns:x="adobe:ns:meta\/"> +<\/x:xmpmeta>/, 'XMP blanked, still well-formed');
  assert.ok(t.includes('/Producer <2020 2020>'), 'hex string decodes to spaces');
  // everything outside the blanked strings is byte-identical
  const keep = (b) => text(b).replace(/\((?:[^()\\]|\\.|\([^()]*\))*\)/g, '()').replace(/<[0-9A-Fa-f ]+>/g, '<>');
  assert.equal(keep(out).replace(/<x:xmpmeta[\s\S]*<\/x:xmpmeta>/, ''), keep(input).replace(/<x:xmpmeta[\s\S]*<\/x:xmpmeta>/, ''));
});

/** A minimal docx: content types, core and app properties, a custom property, and the document body. */
function docx() {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'docProps/core.xml': strToU8(
      '<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:creator>Jane Doe</dc:creator>' +
        '<cp:lastModifiedBy>Jane</cp:lastModifiedBy><dc:title>Secret plan</dc:title>' +
        '<dcterms:created>2025-01-01T12:00:00Z</dcterms:created></cp:coreProperties>',
    ),
    'docProps/app.xml': strToU8('<Properties><Company>Acme Corp</Company><Manager>Bob</Manager><Pages>3</Pages></Properties>'),
    'docProps/custom.xml': strToU8('<Properties><property name="Client"><vt:lpwstr>Big Client Ltd</vt:lpwstr></property></Properties>'),
    'word/document.xml': strToU8('<w:document><w:body>The actual text</w:body></w:document>'),
  });
}

test('Office: author, company and custom values are emptied; the document itself is untouched', () => {
  const out = stripDocumentMetadata(docx());
  const files = unzipSync(out);
  const core = strFromU8(files['docProps/core.xml']);
  assert.ok(core.includes('<dc:creator></dc:creator>') && core.includes('<cp:lastModifiedBy></cp:lastModifiedBy>'));
  assert.ok(core.includes('<dc:title></dc:title>'));
  assert.ok(core.includes('2025-01-01T12:00:00Z'), 'dates kept');
  const app = strFromU8(files['docProps/app.xml']);
  assert.ok(app.includes('<Company></Company>') && app.includes('<Manager></Manager>') && app.includes('<Pages>3</Pages>'));
  assert.ok(!strFromU8(files['docProps/custom.xml']).includes('Big Client'));
  assert.equal(strFromU8(files['word/document.xml']), '<w:document><w:body>The actual text</w:body></w:document>');
  assert.equal(Object.keys(files)[0], '[Content_Types].xml', 'content types stay first');
});

test('other zips, encrypted or broken files, and plain files come back unchanged', () => {
  const plainZip = zipSync({ 'a.txt': strToU8('hello') });
  assert.equal(stripDocumentMetadata(plainZip), plainZip, 'a zip that is not an Office document');
  const broken = enc('PK\x03\x04 not really a zip');
  assert.equal(stripDocumentMetadata(broken), broken);
  const txt = enc('just text /Author (me)');
  assert.deepEqual(stripDocumentMetadata(txt.slice()), txt, 'only PDFs are scanned for PDF keys');
});

test('which documents get cleaned', () => {
  assert.equal(documentKind('a.pdf', 'application/octet-stream'), 'pdf');
  assert.equal(documentKind('x', 'application/pdf'), 'pdf');
  assert.equal(documentKind('report.DOCX', 'application/octet-stream'), 'office');
  assert.equal(documentKind('x', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'office');
  assert.equal(documentKind('notes.txt', 'text/plain'), null);
  assert.equal(documentKind('notes.odt', ''), 'office');
  assert.equal(documentKind('book', 'application/epub+zip'), 'office');
  assert.equal(documentKind('letter.rtf', ''), 'rtf');
  assert.equal(documentKind('x', 'text/rtf'), 'rtf');
  assert.equal(documentKind('logo.svg', ''), 'svg');
  assert.equal(documentKind('x', 'image/svg+xml'), 'svg');
  assert.equal(documentKind('IMG_0001.MOV', ''), 'media');
  assert.equal(documentKind('x', 'video/mp4'), 'media');
  assert.equal(documentKind('memo', 'audio/x-m4a'), 'media');
  assert.equal(documentKind('photo.jpg', 'image/jpeg'), null, 'photos: lib/strip.ts');
  // the JavaScript fallback rebuilds Office files in memory, so only up to DOC_LIMIT
  assert.ok(isCleanableDocument('report.docx', 'application/octet-stream', 1000));
  assert.ok(!isCleanableDocument('report.docx', 'application/octet-stream', DOC_LIMIT + 1));
  assert.ok(!isCleanableDocument('a.pdf', 'application/pdf', 1000), 'PDFs stream instead');
});

/** Runs the cleaner over `input` fed in pieces of the given sizes (cycled). */
function cleanInPieces(input, sizes) {
  const c = new PdfCleaner();
  const parts = [];
  for (let at = 0, k = 0; at < input.length; k++) {
    const n = sizes[k % sizes.length];
    parts.push(c.push(input.subarray(at, at + n)));
    at += n;
  }
  parts.push(c.finish());
  return new Uint8Array(Buffer.concat(parts));
}

test('PDF streaming: the same bytes whatever the piece sizes, every split point included', () => {
  const input = pdf();
  const whole = stripDocumentMetadata(input.slice());
  for (let cut = 0; cut <= input.length; cut++) {
    const c = new PdfCleaner();
    const out = Buffer.concat([c.push(input.subarray(0, cut)), c.push(input.subarray(cut)), c.finish()]);
    assert.deepEqual(new Uint8Array(out), whole, `split at ${cut}`);
  }
  for (const sizes of [[1], [2, 3], [7], [64]]) assert.deepEqual(cleanInPieces(input, sizes), whole, `pieces ${sizes}`);
});

test('PDF streaming: escapes, nesting, dictionaries, unclosed packets and lookalikes', () => {
  const cases = [
    [String.raw`/Title (a\\) b)`, '/Title (   ) b)'],      // an escaped backslash, then the string ends
    [String.raw`/Title (a\) b) x`, '/Title (     ) x'],     // an escaped parenthesis does not end it
    ['/Title (a (b) c) x', '/Title (       ) x'],       // nested parentheses
    ['/Author<</Author (x)>>', '/Author<</Author ( )>>'], // << is a dictionary, the inner key still counts
    ['/Author <41 4>', '/Author <20 2>'],
    ['/Authors (x) /Author\n(y)', '/Authors (x) /Author\n( )'],
    ['<x:xmpmeta>never closed', '<x:xmpmeta>never closed'],
    ['<x:xmpmet', '<x:xmpmet'],
    ['<<x:xmpmeta a="b">hello</x:xmpmeta>', '<<x:xmpmeta a="b">hello</x:xmpmeta>'],   // too short for the empty tag
    ['/Keywords9 (k)', '/Keywords9 (k)'],
  ];
  for (const [inp, want] of cases) {
    const input = enc(inp);
    for (const sizes of [[input.length], [1], [3]]) {
      assert.equal(text(cleanInPieces(input, sizes)), want, `${inp} in pieces of ${sizes}`);
    }
  }
  const packet = enc('%PDF <x:xmpmeta xmlns:x="adobe:ns:meta/" a="1"><rdf:RDF>Jane Doe</rdf:RDF></x:xmpmeta> end');
  const out = text(cleanInPieces(packet, [5]));
  assert.equal(out.length, packet.length);
  assert.match(out, /^%PDF <x:xmpmeta xmlns:x="adobe:ns:meta\/"> +<\/x:xmpmeta> end$/);
});

// ---- compressed object and XMP streams ---------------------------------------------------------
import { inflateSync } from 'node:zlib';
import { pdf15 } from './fixtures/pdf15.mjs';

/** Every Flate stream's decompressed contents, by the dictionary before it. */
function streams(b) {
  const t = text(b);
  const out = [];
  for (const m of t.matchAll(/<<([^]*?)\/Length (\d+) *>>stream\n/g)) {
    const data = b.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[2]));
    if (/FlateDecode/.test(m[1])) out.push({ dict: m[1], plain: inflateSync(data).toString('latin1') });
  }
  return out;
}

test('PDF 1.5: the information dictionary inside a compressed object stream is blanked', () => {
  const input = pdf15();
  assert.ok(!text(input).includes('Jane'), 'only compressed: the plain-text cleaner alone cannot see it');
  const out = stripDocumentMetadata(input.slice());
  assert.equal(out.length, input.length, 'same length: every offset stays valid');
  const [objstm, xmp] = streams(out);
  assert.match(objstm.dict, /ObjStm/);
  assert.match(objstm.plain, /^4 0 <<\/Author\( +\)\/Creator\( +\)\/Producer\( +\)\/Title\( +\)\/CreationDate\(D:20250101120000Z\)>>$/);
  assert.match(xmp.dict, /Metadata/);
  assert.ok(!xmp.plain.includes('Jane') && xmp.plain.includes('<x:xmpmeta xmlns:x="adobe:ns:meta/">'), 'XMP blanked');
  // outside the two streams and their /Length numbers, nothing moved
  const strip = (b) => text(b).replace(/\/Length \d+ *>>stream\n[^]*?endstream/g, '');
  assert.equal(strip(out), strip(input));
  assert.deepEqual(stripDocumentMetadata(out.slice()), out, 'cleaning again changes nothing');
});

test('PDF 1.5: streams with other filters are left alone', () => {
  const body = deflateRaw('4 0 <</Author(Jane Doe)>>');
  for (const dict of ['/Type/ObjStm/Filter[/ASCIIHexDecode/FlateDecode]', '/Type/ObjStm/Filter/FlateDecode/DecodeParms<</Predictor 2/Columns 4>>',
    '/Type/ObjStm/Filter/FlateDecode/DecodeParms<</Predictor 12/Colors 3/Columns 4>>']) {
    const input = enc(`%PDF-1.5\n5 0 obj <<${dict}/Length ${body.length}>>stream\n`);
    const pdf = new Uint8Array(Buffer.concat([input, body, enc('\nendstream endobj\n')]));
    assert.deepEqual(stripDocumentMetadata(pdf.slice()), pdf, dict);
  }
});

test('PDF 1.5: PNG predictors are undone, the stream cleaned and written back unfiltered', () => {
  const info = '4 0 <</Author(Jane Doe)/Producer(Acme PDF)/CreationDate(D:20250101120000Z)>>';
  const body = deflateRaw(predictUp(info, 7).toString('latin1'));
  const head = enc(`%PDF-1.5\n5 0 obj <</Type/ObjStm/N 1/First 4/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 7>>/Length ${body.length}>>stream\n`);
  const pdf = new Uint8Array(Buffer.concat([head, body, enc('\nendstream endobj\n')]));
  const out = stripDocumentMetadata(pdf.slice());
  assert.equal(out.length, pdf.length);
  const [s] = streams(out, /DecodeParms<<\/Predictor 12\/Columns 7>>/);
  const raw = Buffer.from(s.plain, 'latin1');
  for (let r = 0; r < raw.length; r += 8) assert.equal(raw[r], 0, 'every row unfiltered');
  const plain = Array.from(raw).filter((_, i) => i % 8 !== 0).map((c) => String.fromCharCode(c)).join('');
  assert.match(plain, /^4 0 <<\/Author\( +\)\/Producer\( +\)\/CreationDate\(D:20250101120000Z\)>> *$/);
});

test('PDF 1.5: an indirect /Length is followed, and the length object rewritten', () => {
  const body = deflateRaw('4 0 <</Author(Jane Doe)/Title(Secret plan)>>' + ' '.repeat(200));
  const head = enc('%PDF-1.5\n5 0 obj <</Type/ObjStm/N 1/First 4/Filter/FlateDecode/Length 6 0 R>>stream\n');
  const tail = enc(`\nendstream endobj\n6 0 obj\n${body.length}\nendobj\n`);
  const pdf = new Uint8Array(Buffer.concat([head, body, tail]));
  const out = stripDocumentMetadata(pdf.slice());
  assert.equal(out.length, pdf.length);
  const t = text(out);
  const n = Number(/6 0 obj\n(\d+) *\nendobj/.exec(t)[1]);
  assert.ok(n < body.length, 'the length object now holds the shorter length');
  const data = out.subarray(head.length, head.length + n);
  assert.match(inflate(data), /^4 0 <<\/Author\( +\)\/Title\( +\)>> +$/);
  const missing = new Uint8Array(Buffer.concat([head, body, enc('\nendstream endobj\n')]));
  assert.deepEqual(stripDocumentMetadata(missing.slice()), missing, 'a length object that is not there: left alone');
});

test('PDF: camera details in embedded JPEG photos are zeroed in place', () => {
  const jpg = new Uint8Array(fs.readFileSync(new URL('./fixtures/photo.jpg', import.meta.url)));
  const head = enc(`%PDF-1.4\n7 0 obj <</Type/XObject/Subtype/Image/Width 8/Height 8/Filter/DCTDecode/Length ${jpg.length}>>stream\n`);
  const pdf = new Uint8Array(Buffer.concat([head, jpg, enc('\nendstream endobj\n')]));
  const out = stripDocumentMetadata(pdf.slice());
  assert.equal(out.length, pdf.length);
  const img = out.subarray(head.length, head.length + jpg.length);
  const segs = jpegSegments(img);
  const app1 = segs.filter((s) => s.marker === 0xe1);
  assert.ok(jpegSegments(jpg).some((s) => s.marker === 0xe1 && s.body.startsWith('Exif')), 'fixture has Exif');
  assert.ok(app1.length > 0 && app1.every((s) => /^\0+$/.test(s.body)), 'Exif segments zeroed');
  assert.ok(!text(img).includes('CubeTest'));
  const scan = (b) => Buffer.from(b).indexOf(Buffer.from([0xff, 0xda]));
  assert.deepEqual(img.subarray(scan(img)), jpg.subarray(scan(jpg)), 'image data untouched');
});

function jpegSegments(b) {
  const out = [];
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff && b[p + 1] !== 0xda) {
    const len = (b[p + 2] << 8) | b[p + 3];
    out.push({ marker: b[p + 1], body: Buffer.from(b.subarray(p + 4, p + 2 + len)).toString('latin1') });
    p += 2 + len;
  }
  return out;
}

function inflate(b) {
  return inflateSync(Buffer.from(b)).toString('latin1');
}

// ---- Office people, photos; OpenDocument; EPUB; zip64 ----------------------------------------------



test('Office: comment and tracked-change authors, co-authors, template paths and photos are cleaned', () => {
  const files = unzipSync(stripDocumentMetadata(docxWithPeople()));
  const doc = strFromU8(files['word/document.xml']);
  assert.ok(doc.includes('<w:ins w:id="1" w:author="" w:date="2025-01-02T00:00:00Z">'), 'author emptied, date kept');
  assert.ok(doc.includes("<w:del w:author='' w:id='2'>") && doc.includes('Added text') && doc.includes('gone'), 'text untouched');
  const comments = strFromU8(files['word/comments.xml']);
  assert.ok(comments.includes('w:author="" w:date="2025-01-03T00:00:00Z" w:initials=""') && comments.includes('Check this'));
  const people = strFromU8(files['word/people.xml']);
  assert.ok(!people.includes('Jane') && !people.includes('jane@'), people);
  const rels = strFromU8(files['word/_rels/settings.xml.rels']);
  assert.ok(!rels.includes('jdoe') && rels.includes('Target=""') && rels.includes('Target="https://example.com/"'), rels);
  assert.deepEqual(files['word/media/image1.jpeg'], stripImageMetadata(photo.slice()), 'photo cleaned like any photo');
  assert.ok(!text(files['word/media/image1.jpeg']).includes('CubeTest'));
});

test('Office: Excel and PowerPoint people, and Excel tables keep their names', () => {
  const xlsx = unzipSync(stripDocumentMetadata(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8('<workbook><fileSharing userName="Jane Doe"/><mc:AlternateContent><mc:Choice><x15ac:absPath url="C:\\Users\\jdoe\\Documents\\"/></mc:Choice></mc:AlternateContent></workbook>'),
    'xl/comments1.xml': strToU8('<comments><authors><author>Jane Doe</author><author>tc={1234}</author></authors><commentList/></comments>'),
    'xl/persons/person.xml': strToU8('<personList><person displayName="Jane Doe" id="{1}" userId="jane@acme.example" providerId="AD"/></personList>'),
    'xl/revisions/revisionHeaders.xml': strToU8('<headers><header guid="{2}" dateTime="2025-01-01T00:00:00" userName="Jane Doe"/></headers>'),
    'xl/revisions/userNames.xml': strToU8('<users><userInfo guid="{3}" name="Jane Doe" id="1" dateTime="2025-01-01T00:00:00"/></users>'),
    'xl/tables/table1.xml': strToU8('<table id="1" name="Table1" displayName="Table1" ref="A1:B2"/>'),
  })));
  const all = Object.entries(xlsx).map(([k, v]) => `${k}: ${strFromU8(v)}`).join('\n');
  assert.ok(!all.includes('Jane') && !all.includes('jdoe') && !all.includes('jane@'), all);
  assert.ok(strFromU8(xlsx['xl/tables/table1.xml']).includes('displayName="Table1"'), 'a table keeps its name');
  assert.ok(strFromU8(xlsx['xl/revisions/revisionHeaders.xml']).includes('dateTime="2025-01-01T00:00:00"'), 'dates kept');
  const pptx = unzipSync(stripDocumentMetadata(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'ppt/commentAuthors.xml': strToU8('<p:cmAuthorLst><p:cmAuthor id="1" name="Jane Doe" initials="JD" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>'),
    'ppt/authors.xml': strToU8('<p188:authorLst><p188:author id="{4}" name="Jane Doe" initials="JD" userId="jane@acme.example" providerId="AD"/></p188:authorLst>'),
    'ppt/slides/slide1.xml': strToU8('<p:sld><p:cSld name="Title slide"/></p:sld>'),
  })));
  const p = Object.entries(pptx).map(([k, v]) => `${k}: ${strFromU8(v)}`).join('\n');
  assert.ok(!p.includes('Jane') && !p.includes('JD') && !p.includes('jane@'), p);
  assert.ok(p.includes('name="Title slide"'), 'other names stay');
});

test('OpenDocument: meta.xml, comment and tracked-change authors and photos are cleaned; mimetype stays first and stored', () => {
  const out = stripDocumentMetadata(odt());
  assert.equal(Buffer.from(out.subarray(30, 38)).toString('latin1'), 'mimetype', 'mimetype is the first entry');
  assert.equal(out[8] | (out[9] << 8), 0, 'stored, not compressed');
  const files = unzipSync(out);
  const all = Object.entries(files).filter(([k]) => k.endsWith('.xml')).map(([, v]) => strFromU8(v)).join('\n');
  for (const s of ['Jane', 'Bob', 'JD', 'Secret', 'LibreOffice', 'Acme', 'jdoe']) assert.ok(!all.includes(s), `${s} left`);
  assert.ok(all.includes('<meta:creation-date>2025-01-01T12:00:00</meta:creation-date>') && all.includes('<dc:date>2025-01-02T00:00:00</dc:date>'), 'dates kept');
  assert.ok(all.includes('<text:p>note</text:p>') && all.includes('Body'), 'text kept');
  assert.deepEqual(files['Pictures/photo.jpg'], stripImageMetadata(photo.slice()));
});

test('EPUB: creators, contributors and publisher in the package are emptied', () => {
  const out = stripDocumentMetadata(zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8('<package><metadata><dc:title>My Book</dc:title><dc:creator id="a">Jane Doe</dc:creator><dc:contributor>Bob</dc:contributor>' +
      '<dc:publisher>Acme</dc:publisher><dc:date>2025-01-01</dc:date></metadata></package>'),
  }));
  const opf = strFromU8(unzipSync(out)['OEBPS/content.opf']);
  assert.ok(opf.includes('<dc:creator id="a"></dc:creator>') && !opf.includes('Bob') && !opf.includes('Acme'), opf);
  assert.ok(opf.includes('<dc:title>My Book</dc:title>') && opf.includes('<dc:date>2025-01-01</dc:date>'), 'title and date stay');
  assert.equal(Buffer.from(out.subarray(30, 38)).toString('latin1'), 'mimetype');
});

test('Office: zip64 files are read and cleaned too', () => {
  const input = zip64({
    '[Content_Types].xml': strToU8('<Types/>'),
    'docProps/core.xml': strToU8('<cp:coreProperties><dc:creator>Jane Doe</dc:creator></cp:coreProperties>'),
    'word/document.xml': strToU8('<w:document>Text</w:document>'),
  });
  assert.equal(strFromU8(unzipSync(input)['docProps/core.xml']).includes('Jane'), true, 'fixture readable');
  const files = unzipSync(stripDocumentMetadata(input));
  assert.equal(strFromU8(files['docProps/core.xml']), '<cp:coreProperties><dc:creator></dc:creator></cp:coreProperties>');
  assert.equal(strFromU8(files['word/document.xml']), '<w:document>Text</w:document>');
});

// ---- RTF and SVG -----------------------------------------------------------------------------------

function rtfInPieces(input, size) {
  const c = new RtfCleaner();
  const parts = [];
  for (let at = 0; at < input.length; at += size) parts.push(c.push(input.subarray(at, at + size)));
  parts.push(c.finish());
  return Buffer.concat(parts).toString('latin1');
}

test('RTF: author, operator, title, company, comments, revision and comment authors and the generator are dropped', () => {
  const input = enc(RTF);
  for (const size of [1, 2, 3, 7, 64, input.length]) assert.equal(rtfInPieces(input, size), RTF_CLEAN, `pieces of ${size}`);
  const big = enc(String.raw`{\rtf1{\pict\bin10 {\author}}{\author Jane}}`);
  assert.equal(rtfInPieces(big, 5), String.raw`{\rtf1{\pict\bin10 {\author}}}`, 'binary data is passed over, not read');
  const unclosed = enc(String.raw`{\rtf1{\auth`);
  assert.equal(rtfInPieces(unclosed, 3), String.raw`{\rtf1{\auth`, 'an unfinished group passes as it is');
});

test('SVG: comments, metadata and editor file paths are removed; the drawing stays', () => {
  const svg = '<?xml version="1.0"?>\n<!-- Generator: Adobe Illustrator 27.0, SVG Export Plug-In -->\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" sodipodi:docname="plan.svg" inkscape:export-filename="/Users/jdoe/plan.png" ' +
    'inkscape:version="1.3 (0e150ed, 2023-07-21)" width="10"><metadata><rdf:RDF><cc:Work><dc:creator><cc:Agent><dc:title>Jane Doe</dc:title>' +
    '</cc:Agent></dc:creator></cc:Work></rdf:RDF></metadata><title>Floor plan</title><rect width="5" height="5"/><text>a &lt; b</text></svg>';
  const out = strFromU8(stripSvg(strToU8(svg)));
  for (const s of ['Illustrator', 'jdoe', 'Jane', '0e150ed', 'plan.svg']) assert.ok(!out.includes(s), `${s} left`);
  assert.ok(out.includes('version="1.1"') && out.includes('<metadata></metadata>') && out.includes('<rect width="5" height="5"/>'));
  assert.ok(out.includes('<title>Floor plan</title>') && out.includes('<text>a &lt; b</text>'), 'content stays');
});

test('XML scanner: CDATA, processing instructions, DOCTYPE, nesting and unterminated input', () => {
  const rules = { elems: ['x'], attrs: ['a', 'e@b', 'c^file:'], comments: true };
  const run = (s) => strFromU8(cleanXml(strToU8(s), rules));
  assert.equal(run('<!DOCTYPE r [<!ENTITY e "<x>">]><r a="1" b="2"><e b="3"/><x><x>in</x><y/>tail</x><![CDATA[<x>keep</x>]]><?pi <x>?></r>'),
    '<!DOCTYPE r [<!ENTITY e "<x>">]><r a="" b="2"><e b=""/><x></x><![CDATA[<x>keep</x>]]><?pi <x>?></r>');
  assert.equal(run('<r c="file:///a" d="file:///b" c=\'http://x\'/>'), '<r c="" d="file:///b" c=\'http://x\'/>');
  assert.equal(run('<r><!-- note -->t</r>'), '<r>t</r>');
  assert.equal(run('<r a="1"><x>never closed'), '<r a=""><x>');
  assert.equal(run('<r a="1" <x'), '<r a="1" <x', 'an unterminated tag is copied as it is');
});
function deflateRaw(s) {
  return new Uint8Array(zlibSyncNode(Buffer.from(s, 'latin1')));
}
import { deflateSync as zlibSyncNode } from 'node:zlib';
