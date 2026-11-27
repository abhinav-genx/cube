import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { stripImageMetadata } from '../lib/strip.ts';
import { jxl } from './fixtures/docs.mjs';

// Fixtures come from tests/fixtures/images.swift (Apple ImageIO): a 64x48 gradient tagged with
// GPS, camera make/model, software, lens, body serial number, owner name, a comment,
// orientation 6 and a capture date. photo.webp is photo.jpg through `cwebp -metadata all`.
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const has = (bytes, s) => Buffer.from(bytes).includes(s);
const SECRETS = ['CubeTest', 'CUBESERIAL'];

/** Tags of IFD0 and the Exif IFD of the first TIFF block in the file (minimal independent reader). */
function tiffTags(bytes) {
  const buf = Buffer.from(bytes);
  let base = -1;
  for (const sig of [Buffer.from('II*\0'), Buffer.from('MM\0*')]) {
    const i = buf.indexOf(sig);
    if (i >= 0 && (base < 0 || i < base)) base = i;
  }
  if (base < 0) return null;
  const le = buf[base] === 0x49;
  const u16 = (o) => (le ? buf.readUInt16LE(base + o) : buf.readUInt16BE(base + o));
  const u32 = (o) => (le ? buf.readUInt32LE(base + o) : buf.readUInt32BE(base + o));
  const ifd = (off) => {
    const out = new Map();
    for (let k = 0; k < u16(off); k++) {
      const at = off + 2 + 12 * k;
      out.set(u16(at), { type: u16(at + 2), count: u32(at + 4), value: u16(at + 2) === 3 ? u16(at + 8) : u32(at + 8) });
    }
    return out;
  };
  const main = ifd(u32(4));
  const exif = main.has(0x8769) ? ifd(main.get(0x8769).value) : new Map();
  return { main, exif };
}

for (const name of ['photo.jpg', 'photo.heic', 'photo.png', 'photo.webp']) {
  test(`${name}: GPS and camera details removed, orientation and date kept`, () => {
    const before = fixture(name);
    for (const s of SECRETS) assert.ok(has(before, s), `fixture should contain ${s}`);
    const t0 = tiffTags(before);
    assert.ok(t0.main.has(0x8825), 'fixture should have a GPS IFD');

    const after = stripImageMetadata(before.slice());
    for (const s of SECRETS) assert.ok(!has(after, s), `${s} left in ${name}`);
    const t = tiffTags(after);
    assert.ok(!t.main.has(0x8825), 'GPS pointer left');
    for (const tag of [0x010f, 0x0110, 0x0131]) assert.ok(!t.main.has(tag), `IFD0 tag ${tag.toString(16)} left`);
    for (const tag of [0x9286, 0xa430, 0xa431, 0xa433, 0xa434]) assert.ok(!t.exif.has(tag), `Exif tag ${tag.toString(16)} left`);
    assert.equal(t.main.get(0x0112)?.value, 6, 'orientation lost');
    assert.ok(t.exif.has(0x9003), 'capture date lost');
    assert.ok(!has(after, 'exif:GPS') && !has(after, 'GPSLatitude'), 'GPS left in XMP');

    if (name !== 'photo.png') assert.equal(after.length, before.length, 'in-place formats keep their size');
  });
}

test('stripping twice changes nothing more', () => {
  for (const name of ['photo.jpg', 'photo.heic', 'photo.png', 'photo.webp']) {
    const once = stripImageMetadata(fixture(name));
    const twice = stripImageMetadata(once.slice());
    assert.deepEqual(twice, once, name);
  }
});

test('JPEG: XMP and IPTC segments become empty comments; image data untouched', () => {
  const jpg = fixture('photo.jpg');
  const seg = (marker, body) => {
    const b = Buffer.concat([Buffer.from([0xff, marker, 0, 0]), body]);
    b.writeUInt16BE(body.length + 2, 2);
    return b;
  };
  const xmp = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="48,51.5N" tiff:Model="CubeTestPhone"/></rdf:RDF></x:xmpmeta>'));
  const iptc = seg(0xed, Buffer.from('Photoshop 3.0\x008BIM\x04\x04\0\0\0\0\0\x10\x1c\x02\x5a\0\x0cCubeTestCity'));
  const input = new Uint8Array(Buffer.concat([jpg.subarray(0, 2), xmp, iptc, jpg.subarray(2)]));
  const sos = Buffer.from(input).indexOf(Buffer.from([0xff, 0xda]));
  const tail = input.slice(sos);

  const out = stripImageMetadata(input);
  assert.equal(out, input, 'edited in place');
  for (const s of [...SECRETS, 'GPSLatitude', 'Photoshop']) assert.ok(!has(out, s), `${s} left`);
  assert.equal(out[2 + 1], 0xfe, 'XMP segment is now a comment');
  assert.equal(out[2 + xmp.length + 1], 0xfe, 'IPTC segment is now a comment');
  assert.deepEqual(out.slice(sos), tail, 'compressed image data unchanged');
});

test('JPEG: an embedded second image (iPhone HDR / multi-picture) is scrubbed too', () => {
  const jpg = fixture('photo.jpg');
  const input = new Uint8Array(Buffer.concat([jpg, jpg]));   // second image after the first EOI
  const out = stripImageMetadata(input);
  for (const s of SECRETS) assert.ok(!has(out, s), `${s} left`);
  assert.equal(out.length, input.length);
});

test('HEIC: XMP packet is blanked to the same length, still well-formed', () => {
  const heic = fixture('photo.heic');
  const open = Buffer.from(heic).indexOf('<x:xmpmeta');
  const close = Buffer.from(heic).indexOf('</x:xmpmeta>') + '</x:xmpmeta>'.length;
  const out = stripImageMetadata(heic.slice());
  const packet = Buffer.from(out.subarray(open, close)).toString('latin1');
  assert.match(packet, /^<x:xmpmeta xmlns:x="adobe:ns:meta\/"> *<\/x:xmpmeta>$/);
});

test('PNG: chunk CRCs stay valid and pixel data is unchanged', () => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunks = (bytes) => {
    const b = Buffer.from(bytes);
    const out = [];
    for (let i = 8; i < b.length; ) {
      const len = b.readUInt32BE(i);
      out.push({ type: b.toString('latin1', i + 4, i + 8), data: b.subarray(i + 8, i + 8 + len), ok: b.readUInt32BE(i + 8 + len) === crc(b.subarray(i + 4, i + 8 + len)) });
      i += 12 + len;
    }
    return out;
  };
  const before = chunks(fixture('photo.png'));
  const after = chunks(stripImageMetadata(fixture('photo.png')));
  assert.ok(after.every((c) => c.ok), 'a CRC is wrong');
  assert.ok(!after.some((c) => ['tEXt', 'zTXt', 'iTXt', 'tIME'].includes(c.type)));
  const idat = (cs) => Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data));
  assert.deepEqual(idat(after), idat(before));
  assert.equal(after.at(-1).type, 'IEND');
});

test('non-images and broken metadata are left alone', () => {
  const pdf = new Uint8Array(Buffer.from('%PDF-1.7 Exif\0\0MM\0*\0\0\0\x08 CubeTestMake'));
  assert.deepEqual(stripImageMetadata(pdf.slice()), pdf, 'unknown formats unchanged');

  // A JPEG whose Exif block claims an IFD far outside the segment: nothing is edited.
  const jpg = fixture('photo.jpg');
  const bad = jpg.slice();
  const tiff = Buffer.from(bad).indexOf('Exif\0\0') + 6;
  const le = bad[tiff] === 0x49;
  const view = new DataView(bad.buffer);
  view.setUint32(tiff + 4, 0x7fffffff, le);
  const segEnd = tiff - 6 + new DataView(bad.buffer).getUint16(tiff - 8) - 2;   // end of that APP1
  const before = bad.slice(tiff, segEnd);
  const out = stripImageMetadata(bad);
  assert.deepEqual(out.slice(tiff, segEnd), before, 'broken Exif block untouched');
  assert.ok(has(out, 'CubeTestMake'));

  assert.equal(stripImageMetadata(new Uint8Array(0)).length, 0);
  assert.deepEqual(stripImageMetadata(Uint8Array.of(0xff, 0xd8, 0xff)), Uint8Array.of(0xff, 0xd8, 0xff));
});

test('JPEG XL: Exif scrubbed in place, JUMBF and Brotli-boxed Exif become free boxes, the codestream untouched', () => {
  const before = jxl();
  const after = stripImageMetadata(before.slice());
  assert.equal(after.length, before.length);
  for (const s of [...SECRETS, 'Jane Doe']) assert.ok(!has(after, s), `${s} left`);
  const t = tiffTags(after);
  assert.ok(!t.main.has(0x8825), 'GPS pointer left');
  assert.equal(t.main.get(0x0112)?.value, 6, 'orientation kept');
  assert.ok(t.exif.has(0x9003), 'capture date kept');
  const types = [];
  for (let i = 0; i + 8 <= after.length; ) {
    const size = Buffer.from(after).readUInt32BE(i);
    types.push(Buffer.from(after.subarray(i + 4, i + 8)).toString('latin1'));
    i += size;
  }
  assert.deepEqual(types, ['JXL ', 'ftyp', 'Exif', 'xml ', 'free', 'free', 'jxlc']);
  assert.deepEqual(after.subarray(after.length - 7), before.subarray(before.length - 7), 'codestream untouched');
  assert.ok(has(after, '<x:xmpmeta xmlns:x="adobe:ns:meta/">'), 'XMP blanked, still well-formed');
  const bare = Uint8Array.of(0xff, 0x0a, 0xfa, 0x7f, 0x01, 0x90, 0x08, 0, 0, 0, 0, 0, 0);
  assert.deepEqual(stripImageMetadata(bare.slice()), bare, 'a bare codestream has nothing to remove');
});
