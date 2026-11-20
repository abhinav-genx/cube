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
