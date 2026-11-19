// A small but real PDF 1.5 as recent tools write them: the document information dictionary lives
// inside a Flate-compressed object stream, the XMP metadata stream is compressed too, and the
// cross-reference table is an xref stream. Apple's PDF parser reads it (tests/native, readpdf).
import { deflateSync } from 'node:zlib';

const AUTHOR = 'Jane Doe';

export function pdf15({ author = AUTHOR } = {}) {
  const parts = [];
  const offsets = {};
  let at = 0;
  const put = (b) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    parts.push(buf);
    at += buf.length;
  };
  const obj = (n, body) => {
    offsets[n] = at;
    put(`${n} 0 obj\n`);
    put(body);
    put('\nendobj\n');
  };
  const stream = (dict, data) => Buffer.concat([Buffer.from(`<<${dict}/Length ${data.length}>>stream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);

  put('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<</Type/Catalog/Pages 2 0 R/Metadata 6 0 R>>');
  obj(2, '<</Type/Pages/Kids[3 0 R]/Count 1>>');
  obj(3, '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>');
  const info = `<</Author(${author})/Creator(Acme Writer)/Producer(Acme PDF 1.0)/Title(Secret plan)/CreationDate(D:20250101120000Z)>>`;
  const head = '4 0 ';
  obj(5, stream(`/Type/ObjStm/N 1/First ${head.length}/Filter/FlateDecode`, deflateSync(Buffer.from(head + info, 'latin1'))));
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>${author}</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  obj(6, stream('/Type/Metadata/Subtype/XML/Filter/FlateDecode', deflateSync(Buffer.from(xmp, 'latin1'))));

  // xref stream, W [1 4 2]: type, offset (or object stream number), generation (or index)
  const rows = [];
  const row = (t, a, b) => {
    const r = Buffer.alloc(7);
    r[0] = t;
    r.writeUInt32BE(a, 1);
    r.writeUInt16BE(b, 5);
    rows.push(r);
  };
  offsets[7] = at;
  row(0, 0, 65535);
  for (const n of [1, 2, 3]) row(1, offsets[n], 0);
  row(2, 5, 0);   // object 4: inside object stream 5, index 0
  for (const n of [5, 6]) row(1, offsets[n], 0);
  row(1, offsets[7], 0);
  const xref = Buffer.concat(rows);
  put('7 0 obj\n');
  put(stream('/Type/XRef/Size 8/W[1 4 2]/Root 1 0 R/Info 4 0 R', xref));
  put('\nendobj\n');
  put(`startxref\n${offsets[7]}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}
