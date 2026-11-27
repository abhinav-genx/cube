// Small synthetic video and audio files for tests/media.test.mjs and the native checks
// (tests/native/make-vectors.mjs), for cases the ffmpeg fixtures in media/ do not cover.

/** An MPEG audio frame header and a little data: enough for the tags around it to be looked at. */
export const FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(200, 0x55)]);
const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

export function id3(ver, flags, frames, footer = false) {
  const body = Buffer.concat(frames);
  const head = Buffer.concat([Buffer.from('ID3'), Buffer.from([ver, 0, flags]), syncsafe(body.length)]);
  const foot = footer ? Buffer.concat([Buffer.from('3DI'), Buffer.from([ver, 0, flags]), syncsafe(body.length)]) : Buffer.alloc(0);
  return Buffer.concat([head, body, foot]);
}
export function frame(id, value, ver = 3) {
  const data = Buffer.concat([Buffer.from([0]), Buffer.from(value, 'latin1')]);
  return Buffer.concat([Buffer.from(id), ver === 4 ? syncsafe(data.length) : Buffer.from([0, 0, 0, data.length]), Buffer.from([0, 0]), data]);
}

/** An MP4 whose ©xyz (location) box uses a 64-bit size. */
export function mp4LargeBox() {
  const be32 = (n) => Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const xyz = Buffer.concat([be32(1), Buffer.from('©xyz', 'latin1'), be32(0), be32(28), Buffer.from('+48.8584+002.2945/')]);
  xyz.writeUInt32BE(xyz.length, 12);
  const udta = Buffer.concat([be32(8 + xyz.length), Buffer.from('udta'), xyz]);
  const moov = Buffer.concat([be32(8 + udta.length), Buffer.from('moov'), udta]);
  const ftyp = Buffer.concat([be32(16), Buffer.from('ftypisom'), be32(512)]);
  const input = new Uint8Array(Buffer.concat([ftyp, moov]));
  return input;
}

/** MPEG audio with an unsynchronised ID3v2.3 tag, then APEv2, Enhanced ID3v1 and ID3v1 tags. */
export function mp3AllTags() {
  const tag = id3(3, 0x80, [frame('TIT2', 'Secret plan'), frame('TYER', '2025')]);
  const ape = (() => {
    const item = Buffer.concat([Buffer.from([8, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('Artist\0Jane Doe')]);
    const f = (isHeader) => {
      const b = Buffer.alloc(32);
      b.write('APETAGEX');
      b.writeUInt32LE(2000, 8);
      b.writeUInt32LE(item.length + 32, 12);
      b.writeUInt32LE(1, 16);
      b.writeUInt32LE((0x80000000 | (isHeader ? 0x20000000 : 0)) >>> 0, 20);
      return b;
    };
    return Buffer.concat([f(true), item, f(false)]);
  })();
  const plus = Buffer.concat([Buffer.from('TAG+'), Buffer.from('Secret plan, part two'.padEnd(223, '\0'))]);
  const v1 = Buffer.alloc(128);
  v1.write('TAG');
  v1.write('Secret plan', 3);
  v1.write('Jane Doe', 33);
  v1.write('Acme', 63);
  v1.write('2025', 93);
  v1.write('a comment', 97);
  v1[127] = 12;
  const input = new Uint8Array(Buffer.concat([tag, FRAME, ape, plus, v1]));
  return input;
}

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(body.length + 8);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
const u32s = (...v) => {
  const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4));
  return b;
};

/** The GPS samples withLocationTrack adds, one a second, as a GoPro writes them (simplified). */
export const GPS_SAMPLES = ['GPS5 +48.8584 +002.2945 Jane camera', 'GPS5 +48.8585 +002.2946', 'GPS5 +48.8586 +002.2947'];

/**
 * An MP4 (one with moov last, as ffmpeg writes it) with a GoPro-style GPMF location track added:
 * a trak whose sample entry is 'gpmd', its samples in an mdat after moov, one sample a chunk.
 */
export function withLocationTrack(mp4) {
  const src = Buffer.from(mp4);
  let at = 0;
  let moov = -1;
  while (at + 8 <= src.length) {
    const size = src.readUInt32BE(at);
    if (src.toString('latin1', at + 4, at + 8) === 'moov') moov = at;
    at += size;
  }
  if (moov < 0 || moov + src.readUInt32BE(moov) !== src.length) throw new Error('moov must be last');
  const samples = GPS_SAMPLES.map((s) => Buffer.from(s, 'latin1'));
  const build = (offsets) => {
    const stbl = box('stbl',
      box('stsd', u32s(0, 1), box('gpmd', Buffer.alloc(6), Buffer.from([0, 1]))),
      box('stts', u32s(0, 1, samples.length, 1000)),
      box('stsc', u32s(0, 1, 1, 1, 1)),
      box('stsz', u32s(0, 0, samples.length, ...samples.map((s) => s.length))),
      box('stco', u32s(0, samples.length, ...offsets)));
    const matrix = u32s(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
    return box('trak',
      box('tkhd', u32s(7, 0, 0, 3, 0, 3000, 0, 0), Buffer.alloc(8), matrix, u32s(0, 0)),
      box('mdia',
        box('mdhd', u32s(0, 0, 0, 1000, 3000), Buffer.from([0x55, 0xc4, 0, 0])),
        box('hdlr', u32s(0, 0), Buffer.from('meta'), Buffer.alloc(12), Buffer.from('GoPro MET\0')),
        box('minf', box('nmhd', u32s(0)), box('dinf', box('dref', u32s(0, 1), box('url ', u32s(1)))), stbl)));
  };
  const trakLen = build(samples.map(() => 0)).length;
  const moovLen = src.length - moov + trakLen;
  let p = moov + moovLen + 8;
  const offsets = samples.map((s) => {
    const o = p;
    p += s.length;
    return o;
  });
  const head = Buffer.alloc(4);
  head.writeUInt32BE(moovLen);
  return new Uint8Array(Buffer.concat([src.subarray(0, moov), head, src.subarray(moov + 4), build(offsets), box('mdat', ...samples)]));
}

/** An Insta360 GPS fix as the trailer stores it (53 bytes): time, status 'A', latitude, 'N', longitude, 'E', speed, track, altitude. */
function insvFix(lat, lon) {
  const b = Buffer.alloc(53);
  b.writeUInt32LE(1735732800, 0);
  b.write('A', 10, 'latin1');
  b.writeDoubleLE(lat, 11);
  b.write('N', 19, 'latin1');
  b.writeDoubleLE(lon, 20);
  b.write('E', 28, 'latin1');
  b.writeDoubleLE(1.5, 29);
  b.writeDoubleLE(90, 37);
  b.writeDoubleLE(35, 45);
  return b;
}

/** Motion data an Insta360 trailer keeps for stabilising (record 0x300): must stay. */
export const INSV_MOTION = Buffer.from('MOTION-DATA-KEEP'.repeat(4), 'latin1');

/**
 * An MP4 with an Insta360 trailer after its boxes: camera details (record 0x101: serial number,
 * model), motion data (0x300) and GPS fixes (0x700), each record its data then its ID and length,
 * and the 78-byte end with the trailer's length and the magic number (as ExifTool reads it).
 */
export function withInsta360Trailer(mp4) {
  const tag = (t, s) => Buffer.concat([Buffer.from([t, s.length]), Buffer.from(s, 'latin1')]);
  const records = [
    [0x101, Buffer.concat([tag(0x0a, 'IXSE1234567CUBE'), tag(0x12, 'Insta360 X3'), tag(0x1a, 'v1.0.04')])],
    [0x300, INSV_MOTION],
    [0x700, Buffer.concat([insvFix(48.8584, 2.2945), insvFix(48.8585, 2.2946)])],
  ];
  const foot = (id, len) => {
    const b = Buffer.alloc(6);
    b.writeUInt16LE(id);
    b.writeUInt32LE(len, 2);
    return b;
  };
  const parts = [];
  records.forEach(([id, data], i) => {
    parts.push(data);
    if (i + 1 < records.length) parts.push(foot(id, data.length));
  });
  const [lastId, lastData] = records[records.length - 1];
  const end = Buffer.alloc(78);
  foot(lastId, lastData.length).copy(end, 0);
  end.writeUInt32LE(3, 42);
  end.write('8db42d694ccc418790edff439fe026bf', 46, 'latin1');
  const trailer = Buffer.concat([...parts, end]);
  trailer.writeUInt32LE(trailer.length, trailer.length - 78 + 38);
  return new Uint8Array(Buffer.concat([Buffer.from(mp4), trailer]));
}
