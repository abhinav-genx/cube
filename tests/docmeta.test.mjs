import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { DOC_LIMIT, documentKind, isCleanableDocument, PdfCleaner, stripDocumentMetadata } from '../lib/docmeta.ts';

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
