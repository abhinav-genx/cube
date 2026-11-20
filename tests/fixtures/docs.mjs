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
