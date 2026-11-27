// Documents for tests/docmeta.test.mjs and the native checks (tests/native/make-vectors.mjs):
// each carries names, paths or photo details that cleaning must remove.
import fs from 'node:fs';
import { strToU8, zipSync } from 'fflate';

export const photo = new Uint8Array(fs.readFileSync(new URL('./photo.jpg', import.meta.url)));

/** PNG "Up" predictor rows, `columns` bytes each (the last row padded with spaces). */
export function predictUp(s, columns) {
  const plain = Buffer.from(s.padEnd(Math.ceil(s.length / columns) * columns, ' '), 'latin1');
  const rows = plain.length / columns;
  const out = Buffer.alloc(rows * (columns + 1));
  for (let r = 0; r < rows; r++) {
    out[r * (columns + 1)] = 2;
    for (let x = 0; x < columns; x++) out[r * (columns + 1) + 1 + x] = (plain[r * columns + x] - (r > 0 ? plain[(r - 1) * columns + x] : 0)) & 0xff;
  }
  return out;
}

/** A docx with comments, tracked changes, co-authors, a template path and a photo with GPS. */
export function docxWithPeople() {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'docProps/core.xml': strToU8('<cp:coreProperties><dc:creator>Jane Doe</dc:creator><dcterms:created>2025-01-01T12:00:00Z</dcterms:created></cp:coreProperties>'),
    'word/document.xml': strToU8('<w:document><w:body><w:ins w:id="1" w:author="Jane Doe" w:date="2025-01-02T00:00:00Z"><w:r><w:t>Added text</w:t></w:r></w:ins>' +
      "<w:del w:author='Bob Smith' w:id='2'><w:r><w:delText>gone</w:delText></w:r></w:del></w:body></w:document>"),
    'word/comments.xml': strToU8('<w:comments><w:comment w:id="0" w:author="Jane Doe" w:date="2025-01-03T00:00:00Z" w:initials="JD"><w:p><w:r><w:t>Check this</w:t></w:r></w:p></w:comment></w:comments>'),
    'word/people.xml': strToU8('<w15:people><w15:person w15:author="Jane Doe"><w15:presenceInfo w15:providerId="AD" w15:userId="jane@acme.example"/></w15:person></w15:people>'),
    'word/_rels/settings.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" ' +
      'Target="file:///C:\\Users\\jdoe\\AppData\\Roaming\\Microsoft\\Templates\\Normal.dotm" TargetMode="External"/>' +
      '<Relationship Id="rId2" Type="hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>'),
    'word/media/image1.jpeg': photo,
  });
}

/** An OpenDocument text file: mimetype first and stored, meta.xml, an annotation, a photo. */
export function odt() {
  return zipSync({
    mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
    'META-INF/manifest.xml': strToU8('<manifest:manifest/>'),
    'meta.xml': strToU8('<office:document-meta><office:meta><meta:initial-creator>Jane Doe</meta:initial-creator><dc:creator>Jane Doe</dc:creator>' +
      '<meta:creation-date>2025-01-01T12:00:00</meta:creation-date><dc:title>Secret plan</dc:title><meta:generator>LibreOffice/7.6$MacOSX_AARCH64</meta:generator>' +
      '<meta:user-defined meta:name="Client">Acme</meta:user-defined><meta:template xlink:href="file:///Users/jdoe/Templates/t.ott" xlink:title="Jane template"/></office:meta></office:document-meta>'),
    'content.xml': strToU8('<office:document-content><office:body><text:p>Body<office:annotation><dc:creator>Jane Doe</dc:creator><dc:date>2025-01-02T00:00:00</dc:date>' +
      '<meta:creator-initials>JD</meta:creator-initials><text:p>note</text:p></office:annotation></text:p>' +
      '<text:tracked-changes><text:changed-region><text:insertion><office:change-info><dc:creator>Bob Smith</dc:creator></office:change-info></text:insertion></text:changed-region></text:tracked-changes></office:body></office:document-content>'),
    'Pictures/photo.jpg': photo,
  });
}

/** A zip written with zip64 records (sizes and offsets in extra fields), as some tools always do. */
export function zip64(entries) {
  const parts = [];
  const central = [];
  let at = 0;
  for (const [name, data] of Object.entries(entries)) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const extra = Buffer.alloc(20);
    extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4); extra.writeBigUInt64LE(BigInt(data.length), 12);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(45, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(0xffffffff, 18); local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(n.length, 26); local.writeUInt16LE(extra.length, 28);
    const cextra = Buffer.alloc(28);
    cextra.writeUInt16LE(1, 0); cextra.writeUInt16LE(24, 2);
    cextra.writeBigUInt64LE(BigInt(data.length), 4); cextra.writeBigUInt64LE(BigInt(data.length), 12); cextra.writeBigUInt64LE(BigInt(at), 20);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(45, 4); c.writeUInt16LE(45, 6); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(0xffffffff, 20); c.writeUInt32LE(0xffffffff, 24); c.writeUInt16LE(n.length, 28); c.writeUInt16LE(cextra.length, 30);
    c.writeUInt32LE(0xffffffff, 42);
    central.push(c, n, cextra);
    parts.push(local, n, extra, Buffer.from(data));
    at += local.length + n.length + extra.length + data.length;
  }
  const cd = Buffer.concat(central);
  const count = Object.keys(entries).length;
  const e64 = Buffer.alloc(56);
  e64.writeUInt32LE(0x06064b50, 0); e64.writeBigUInt64LE(44n, 4); e64.writeUInt16LE(45, 12); e64.writeUInt16LE(45, 14);
  e64.writeBigUInt64LE(BigInt(count), 24); e64.writeBigUInt64LE(BigInt(count), 32);
  e64.writeBigUInt64LE(BigInt(cd.length), 40); e64.writeBigUInt64LE(BigInt(at), 48);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(at + cd.length), 8); loc.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, e64, loc, end]));
}

function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export const RTF = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\*\generator Riched20 10.0.19041}{\info{\title Secret plan}{\author Jane Doe}` +
  String.raw`{\operator Jane}{\creatim\yr2025\mo1\dy1\hr12\min0}{\*\company Acme Corp}{\doccomm about \{braces\} here}}` +
  String.raw`{\*\revtbl {Unknown;}{Jane Doe;}}\f0 Hello {\b world}\par{\*\atnid JD}{\*\atnauthor Jane Doe}\chatn{\*\annotation hi}` +
  String.raw`{\pict\pngblip\bin4 {}\}} done \{\author not a group\}}`;
export const RTF_CLEAN = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\info{\creatim\yr2025\mo1\dy1\hr12\min0}}\f0 Hello {\b world}\par\chatn{\*\annotation hi}` +
  String.raw`{\pict\pngblip\bin4 {}\}} done \{\author not a group\}}`;

export const SVG = '<?xml version="1.0"?>\n<!-- Generator: Adobe Illustrator 27.0, SVG Export Plug-In -->\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" sodipodi:docname="plan.svg" inkscape:export-filename="/Users/jdoe/plan.png" ' +
  'inkscape:version="1.3 (0e150ed, 2023-07-21)" width="10"><metadata><rdf:RDF><cc:Work><dc:creator><cc:Agent><dc:title>Jane Doe</dc:title>' +
  '</cc:Agent></dc:creator></cc:Work></rdf:RDF></metadata><title>Floor plan</title><rect width="5" height="5"/><text>a &lt; b</text></svg>';

export const xlsxPeople = () => zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  'xl/workbook.xml': strToU8('<workbook><fileSharing userName="Jane Doe"/><mc:AlternateContent><mc:Choice><x15ac:absPath url="C:\\Users\\jdoe\\Documents\\"/></mc:Choice></mc:AlternateContent></workbook>'),
  'xl/comments1.xml': strToU8('<comments><authors><author>Jane Doe</author><author>tc={1234}</author></authors><commentList/></comments>'),
  'xl/persons/person.xml': strToU8('<personList><person displayName="Jane Doe" id="{1}" userId="jane@acme.example" providerId="AD"/></personList>'),
  'xl/tables/table1.xml': strToU8('<table id="1" name="Table1" displayName="Table1" ref="A1:B2"/>'),
  'xl/media/image1.jpeg': photo,
});

export const pptxPeople = () => zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  'ppt/commentAuthors.xml': strToU8('<p:cmAuthorLst><p:cmAuthor id="1" name="Jane Doe" initials="JD" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>'),
  'ppt/authors.xml': strToU8('<p188:authorLst><p188:author id="{4}" name="Jane Doe" initials="JD" userId="jane@acme.example" providerId="AD"/></p188:authorLst>'),
  'ppt/slides/slide1.xml': strToU8('<p:sld><p:cSld name="Title slide"/></p:sld>'),
});

export const epub = () => zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
  'OEBPS/content.opf': strToU8('<package><metadata><dc:title>My Book</dc:title><dc:creator id="a">Jane Doe</dc:creator><dc:contributor>Bob</dc:contributor>' +
    '<dc:publisher>Acme</dc:publisher><dc:date>2025-01-01</dc:date></metadata></package>'),
  'OEBPS/images/photo.jpg': photo,
});

const latin = (s) => Buffer.from(s, 'latin1');

/** A PDF whose object stream uses a PNG predictor (rows of 7 bytes, "Up" filter). */
export function pdfPredictor(deflate) {
  const body = deflate(predictUp('4 0 <</Author(Jane Doe)/Producer(Acme PDF)/CreationDate(D:20250101120000Z)>>', 7));
  return new Uint8Array(Buffer.concat([
    latin(`%PDF-1.5\n5 0 obj <</Type/ObjStm/N 1/First 4/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 7>>/Length ${body.length}>>stream\n`),
    body, latin('\nendstream endobj\n'),
  ]));
}

/** A PDF whose object stream has an indirect /Length (6 0 R, defined after the stream). */
export function pdfIndirect(deflate) {
  const body = deflate(latin('4 0 <</Author(Jane Doe)/Title(Secret plan)>>' + ' '.repeat(200)));
  return new Uint8Array(Buffer.concat([
    latin('%PDF-1.5\n5 0 obj <</Type/ObjStm/N 1/First 4/Filter/FlateDecode/Length 6 0 R>>stream\n'),
    body, latin(`\nendstream endobj\n6 0 obj\n${body.length}\nendobj\n`),
  ]));
}

/** A PDF with the fixture photo (Exif with GPS and camera details) as a DCTDecode image. */
export function pdfJpeg() {
  return new Uint8Array(Buffer.concat([
    latin(`%PDF-1.4\n7 0 obj <</Type/XObject/Subtype/Image/Width 8/Height 8/Filter/DCTDecode/Length ${photo.length}>>stream\n`),
    photo, latin('\nendstream endobj\n'),
  ]));
}

const INFO = '4 0 <</Author(Jane Doe)/Producer(Acme PDF)/CreationDate(D:20250101120000Z)>>' + ' '.repeat(120);
const XMP = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description dc:creator="Jane Doe" xmp:CreatorTool="Acme Writer"/></rdf:RDF></x:xmpmeta>' + ' '.repeat(300) + '<?xpacket end="w"?>';

/** A PDF with one stream: `dict` (without /Length) and `data` already encoded for its filters. */
function pdfStream(dict, data) {
  return new Uint8Array(Buffer.concat([
    latin(`%PDF-1.5\n5 0 obj <<${dict}/Length ${data.length}>>stream\n`), Buffer.from(data), latin('\nendstream endobj\n'),
  ]));
}

/** An object stream with the document information, LZW-encoded (`early`: /EarlyChange). */
export const pdfLzw = (encode, early = 1) => pdfStream(`/Type/ObjStm/N 1/First 4/Filter/LZWDecode${early === 1 ? '' : `/DecodeParms<</EarlyChange ${early}>>`}`,
  encode(latin(INFO), ['LZWDecode'], early));
/** An XMP stream, Flate-compressed and then ASCII85-encoded. */
export const pdfA85 = (encode) => pdfStream('/Type/Metadata/Subtype/XML/Filter[/ASCII85Decode/FlateDecode]', encode(latin(XMP), ['ASCII85Decode', 'FlateDecode']));
/** An object stream, run-length and then hex encoded. */
export const pdfHexRl = (encode) => pdfStream('/Type/ObjStm/N 1/First 4/Filter[/ASCIIHexDecode/RunLengthDecode]', encode(latin(INFO), ['ASCIIHexDecode', 'RunLengthDecode']));

/**
 * An XMP stream whose /Length (7 0 R) is kept inside a compressed object stream, as PDF 1.5 writers
 * do: the length cannot be rewritten, so the cleaned stream keeps it.
 */
export function pdfObjStmLength(deflate) {
  const xmp = deflate(latin(XMP));
  const objs = `<</Author(Jane Doe)>> ${xmp.length}`;
  const second = objs.indexOf(String(xmp.length));
  const head = `4 0 7 ${second} `;
  const stm = deflate(latin(head + objs));
  return new Uint8Array(Buffer.concat([
    latin(`%PDF-1.5\n3 0 obj <</Type/ObjStm/N 2/First ${head.length}/Filter/FlateDecode/Length ${stm.length}>>stream\n`), stm,
    latin('\nendstream endobj\n8 0 obj <</Type/Metadata/Subtype/XML/Filter/FlateDecode/Length 7 0 R>>stream\n'), xmp,
    latin('\nendstream endobj\n'),
  ]));
}

/**
 * A minimal OLE compound file (version 3, 512-byte sectors): streams under 4096 bytes go in the
 * mini stream, larger ones in sectors of their own, as Office writes them. The directory is a
 * simple chain (every entry the right sibling of the one before).
 */
export function cfbFile(streams) {
  const S = 512;
  const sectors = (n) => Math.ceil(n / S);
  const small = streams.filter((s) => s.data.length < 4096);
  const large = streams.filter((s) => s.data.length >= 4096);
  const mini = Buffer.concat(small.map((s) => Buffer.concat([s.data, Buffer.alloc((64 - (s.data.length % 64)) % 64)])));
  const miniSectors = mini.length / 64;
  const dirN = sectors((streams.length + 1) * 128);
  const miniFatN = sectors(miniSectors * 4) || 0;
  const miniN = sectors(mini.length);
  const largeN = large.reduce((n, s) => n + sectors(s.data.length), 0);
  let fatN = 1;
  while (fatN * (S / 4) < fatN + dirN + miniFatN + miniN + largeN) fatN++;
  const total = fatN + dirN + miniFatN + miniN + largeN;
  const fat = new Uint32Array(fatN * (S / 4)).fill(0xffffffff);
  let next = 0;
  const run = (n) => {
    const start = next;
    for (let i = 0; i < n; i++) fat[next + i] = i + 1 < n ? next + i + 1 : 0xfffffffe;
    next += n;
    return n ? start : 0xfffffffe;
  };
  for (let i = 0; i < fatN; i++) fat[next++] = 0xfffffffd;
  const dirStart = run(dirN);
  const miniFatStart = run(miniFatN);
  const miniStart = run(miniN);
  const largeStarts = large.map((s) => run(sectors(s.data.length)));
  if (next !== total) throw new Error('layout');
  const miniFat = new Uint32Array(miniFatN * (S / 4)).fill(0xffffffff);
  const smallStarts = [];
  let m = 0;
  for (const s of small) {
    const n = Math.ceil(s.data.length / 64) || 1;
    smallStarts.push(m);
    for (let i = 0; i < n; i++) miniFat[m + i] = i + 1 < n ? m + i + 1 : 0xfffffffe;
    m += n;
  }
  const entry = (name, type, start, size, right, child) => {
    const e = Buffer.alloc(128);
    e.write(name, 0, 'utf16le');
    e.writeUInt16LE((name.length + 1) * 2, 0x40);
    e[0x42] = type;
    e[0x43] = 1;   // black
    e.writeInt32LE(-1, 0x44);
    e.writeInt32LE(right, 0x48);
    e.writeInt32LE(child, 0x4c);
    e.writeUInt32LE(start >>> 0, 0x74);
    e.writeUInt32LE(size, 0x78);
    return e;
  };
  const ordered = [...small, ...large];
  const starts = [...smallStarts, ...largeStarts];
  const dir = Buffer.alloc(dirN * S);
  entry('Root Entry', 5, miniN ? miniStart : 0xfffffffe, mini.length, -1, ordered.length ? 1 : -1).copy(dir, 0);
  ordered.forEach((s, i) => entry(s.name, 2, starts[i], s.data.length, i + 1 < ordered.length ? i + 2 : -1, -1).copy(dir, (i + 1) * 128));
  const h = Buffer.alloc(S);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(h);
  h.writeUInt16LE(0x3e, 0x18);
  h.writeUInt16LE(3, 0x1a);
  h.writeUInt16LE(0xfffe, 0x1c);
  h.writeUInt16LE(9, 0x1e);
  h.writeUInt16LE(6, 0x20);
  h.writeUInt32LE(fatN, 0x2c);
  h.writeUInt32LE(dirStart, 0x30);
  h.writeUInt32LE(4096, 0x38);
  h.writeUInt32LE(miniFatN ? miniFatStart : 0xfffffffe, 0x3c);
  h.writeUInt32LE(miniFatN, 0x40);
  h.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i++) h.writeUInt32LE(i < fatN ? i : 0xffffffff, 0x4c + i * 4);
  const pad = (b, n) => Buffer.concat([b, Buffer.alloc(n * S - b.length)]);
  return new Uint8Array(Buffer.concat([h, Buffer.from(fat.buffer), dir, Buffer.from(miniFat.buffer), pad(mini, miniN),
    ...large.map((s) => pad(s.data, sectors(s.data.length)))]));
}

/** A SummaryInformation property set with an author, a title and a creation date. */
export function summaryInfo() {
  const str = (s) => {
    const b = Buffer.alloc(8 + Math.ceil((s.length + 1) / 4) * 4);
    b.writeUInt32LE(0x1e);
    b.writeUInt32LE(s.length + 1, 4);
    b.write(s, 8, 'latin1');
    return b;
  };
  const date = Buffer.alloc(12);
  date.writeUInt32LE(0x40);
  date.writeBigUInt64LE(133800000000000000n, 4);
  const props = [[2, str('Secret plan')], [4, str('Jane Doe')], [8, str('Jane Doe')], [12, date]];
  let off = 8 + props.length * 8;
  const index = Buffer.alloc(props.length * 8);
  props.forEach(([id, v], i) => {
    index.writeUInt32LE(id, i * 8);
    index.writeUInt32LE(off, i * 8 + 4);
    off += v.length;
  });
  const section = Buffer.concat([Buffer.alloc(8), index, ...props.map((p) => p[1])]);
  section.writeUInt32LE(section.length, 0);
  section.writeUInt32LE(props.length, 4);
  const head = Buffer.alloc(48);
  head.writeUInt16LE(0xfffe, 0);
  head.writeUInt32LE(1, 24);
  Buffer.from('e0859ff2f94f6810ab9108002b27b3d9', 'hex').copy(head, 28);
  head.writeUInt32LE(48, 44);
  return Buffer.concat([head, section]);
}

/** An Excel 97 workbook stream: BOF, a WriteAccess record naming the user (padded to 112 bytes), EOF; over 4096 bytes. */
export function xlsWorkbook() {
  const rec = (type, data) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type);
    h.writeUInt16LE(data.length, 2);
    return Buffer.concat([h, data]);
  };
  const name = Buffer.concat([Buffer.from([8, 0, 0]), Buffer.from('Jane Doe', 'latin1')]);
  const write = Buffer.concat([name, Buffer.alloc(112 - name.length, 0x20)]);
  const filler = rec(0x00e2, Buffer.alloc(0));   // InterfaceEnd, repeated to pass 4096 bytes
  return Buffer.concat([rec(0x0809, Buffer.alloc(16)), rec(0x005c, write), ...Array(1100).fill(filler), rec(0x000a, Buffer.alloc(0))]);
}

/** PowerPoint's "Current User" stream for the user "Jane Doe". */
export function pptCurrentUser() {
  const name = 'Jane Doe';
  const b = Buffer.alloc(28 + name.length + 4 + name.length * 2);
  b.writeUInt16LE(0, 0);
  b.writeUInt16LE(0x0ff6, 2);
  b.writeUInt32LE(b.length - 8, 4);
  b.writeUInt32LE(0x14, 8);
  b.writeUInt32LE(0xe391c05f, 12);
  b.writeUInt16LE(name.length, 20);
  b.writeUInt16LE(0x3f4, 22);
  b.write(name, 28, 'latin1');
  b.writeUInt32LE(8, 28 + name.length);
  b.write(name, 32 + name.length, 'utf16le');
  return b;
}

/** A JPEG XL container with Exif (the fixture photo's), XMP, JUMBF and Brotli-boxed Exif, and a stand-in codestream. */
export function jxl() {
  const box = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(data.length + 8);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, data]);
  };
  const p = Buffer.from(photo);
  const exifAt = p.indexOf(Buffer.from('Exif\0\0', 'latin1'));
  const len = p.readUInt16BE(exifAt - 2);
  const tiff = p.subarray(exifAt + 6, exifAt - 2 + len);
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description dc:creator="Jane Doe"/></rdf:RDF></x:xmpmeta>';
  return new Uint8Array(Buffer.concat([
    Buffer.from([0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
    box('ftyp', Buffer.from('jxl \0\0\0\0jxl ', 'latin1')),
    box('Exif', Buffer.concat([Buffer.alloc(4), tiff])),
    box('xml ', Buffer.from(xmp, 'latin1')),
    box('jumb', Buffer.from('c2pa claim: author Jane Doe, device CubeTestModel', 'latin1')),
    box('brob', Buffer.concat([Buffer.from('Exif', 'latin1'), Buffer.from('brotli bytes CubeTestMake')])),
    box('jxlc', Buffer.from([0xff, 0x0a, 0xfa, 0x7f, 0x01, 0x90, 0x08])),
  ]));
}

/** An object stream encoded as ASCII85 over Flate with a PNG predictor on the Flate filter (/DecodeParms [null <<…>>]). */
export function pdfParmsArray(encode) {
  const rows = predictUp(INFO, 7);
  return pdfStream('/Type/ObjStm/N 1/First 4/Filter[/ASCII85Decode/FlateDecode]/DecodeParms[null<</Predictor 12/Columns 7>>]',
    encode(rows, ['ASCII85Decode', 'FlateDecode']));
}

/**
 * An object stream whose objects are indented with long runs of spaces and compressed tightly by
 * `deflate` (zlib's best): once its author is blanked, Cube's compressor cannot fit it in the same
 * length, so the shorter form is used (white space squeezed, offsets rewritten).
 */
export function pdfTight(deflate) {
  let seed = 3;
  const word = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8).toString(36).slice(0, 6);
  const objs = [`<</Author(Jane Doe)/Producer(Acme PDF)/CreationDate(D:20250101120000Z)>>`];
  for (let i = 0; i < 40; i++) objs.push(`<<\n        /Type /Annot\n        /Contents (${word()} ${word()})\n        /NM (${word()})\n      >>`);
  let header = '';
  let off = 0;
  objs.forEach((o, i) => {
    header += `${10 + i} ${off} `;
    off += o.length + 1;
  });
  const body = objs.join('\n') + '\n';
  const data = deflate(latin(header + body));
  return pdfStream(`/Type/ObjStm/N ${objs.length}/First ${header.length}/Filter/FlateDecode`, data);
}
