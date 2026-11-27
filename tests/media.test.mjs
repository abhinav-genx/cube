import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { mediaPatches, stripMediaMetadata } from '../lib/mediameta.ts';
import { frame, id3, FRAME, GPS_SAMPLES, INSV_MOTION, mp3AllTags, mp4LargeBox, withInsta360Trailer, withLocationTrack } from './fixtures/media.mjs';

// Fixtures from tests/fixtures/media/make.sh (ffmpeg) and apple.mov (written by AVFoundation with
// QuickTime metadata keys, as an iPhone does). Each carries a location, a device or person and a title.
const dir = new URL('./fixtures/media/', import.meta.url);
const load = (f) => new Uint8Array(fs.readFileSync(new URL(f, dir)));
const text = (b) => Buffer.from(b).toString('latin1');
const SECRETS = ['Jane', 'Secret', 'Acme', 'iPhone', '48.8584', 'Main Street', 'Lavf', '17.4'];

for (const [file, kept] of [
  ['apple.mov', ['com.apple.quicktime.creationdate', '2025-01-01T12:00:00+0100']],
  ['video.mov', ['com.apple.quicktime.creationdate', '2025-01-01T12:00:00+0100']],
  ['video.mp4', ['©day']],
  ['audio.m4a', ['©day', '2025-01-01']],
  ['audio.mp3', ['TYER', '2025']],
  ['audio.flac', []],
  ['audio.wav', []],
  ['audio.aiff', ['COMM', 'SSND']],
  ['audio.ogg', ['\x01vorbis', '\x03vorbis']],
  ['audio.opus', ['OpusHead', 'OpusTags']],
  ['audio.oga', ['\x7fFLAC']],
  ['video.mkv', ['font.ttf', 'font/ttf']],
  ['video.webm', ['webm']],
  ['video-mjpeg.mov', ['jpeg']],
  ['video-mjpeg.mkv', ['V_MJPEG']],
  ['video-dji.mp4', ['avc1']],
  ['video.avi', ['movi']],
]) {
  test(`${file}: location, device, names and titles removed in place; dates and sound kept`, () => {
    const input = load(file);
    assert.ok(SECRETS.some((s) => text(input).includes(s)), 'fixture carries details');
    const out = stripMediaMetadata(input.slice());
    assert.equal(out.length, input.length, 'same length: every offset stays valid');
    for (const s of SECRETS) assert.ok(!text(out).includes(s), `${s} left`);
    for (const s of kept) assert.ok(text(out).includes(s), `${s} kept`);
    // only header and metadata bytes changed: the rest of the file is identical
    let changed = 0;
    for (let i = 0; i < input.length; i++) if (input[i] !== out[i]) changed++;
    assert.ok(changed > 0 && changed < input.length / 2, `${changed} bytes changed`);
    assert.deepEqual(stripMediaMetadata(out.slice()), out, 'cleaning again changes nothing');
  });
}

test('MP4: metadata items become free boxes; the movie header and sample tables are untouched', () => {
  const input = load('video.mp4');
  const out = stripMediaMetadata(input.slice());
  const box = (b, type) => text(b).indexOf(type);
  assert.equal(box(out, 'mvhd'), box(input, 'mvhd'));
  assert.equal(box(out, 'stco'), box(input, 'stco'));
  assert.ok(text(out).includes('free'), 'items turned into free boxes');
  assert.ok(!text(out).includes('©xyz') && !text(out).includes('©nam') && !text(out).includes('©ART'));
});

test('MP4: a 64-bit box size keeps its size field', () => {
  const input = mp4LargeBox();
  const ftyp = { length: 16 };
  const out = stripMediaMetadata(input.slice());
  const at = ftyp.length + 16;
  assert.equal(text(out.subarray(at + 4, at + 8)), 'free');
  assert.deepEqual(out.subarray(at + 8, at + 16), input.subarray(at + 8, at + 16), '64-bit size kept');
  assert.ok(!text(out).includes('48.8584'));
});

test('MP3: ID3v2.4 dates stay at the front, everything else becomes padding; the footer flags match', () => {
  const tag = id3(4, 0x10, [frame('TIT2', 'Secret plan', 4), frame('TDRC', '2025-01-01', 4), frame('TPE1', 'Jane Doe', 4), frame('APIC', 'x'.repeat(50), 4)], true);
  const input = new Uint8Array(Buffer.concat([tag, FRAME]));
  const out = stripMediaMetadata(input.slice());
  assert.equal(out.length, input.length);
  assert.equal(text(out.subarray(10, 14)), 'TDRC', 'the date frame moved to the front');
  assert.ok(text(out).includes('2025-01-01') && !text(out).includes('Secret') && !text(out).includes('Jane'));
  assert.deepEqual(out.subarray(tag.length - 10, tag.length - 7), input.subarray(tag.length - 10, tag.length - 7), 'footer kept');
  assert.equal(out[tag.length - 5], out[5], 'footer flags match the header');
  assert.deepEqual(out.subarray(tag.length), input.subarray(tag.length), 'audio untouched');
});

test('MP3: an unsynchronised ID3v2 tag is zeroed whole; ID3v1, TAG+ and APEv2 tags are emptied', () => {
  const input = mp3AllTags();
  const out = stripMediaMetadata(input.slice());
  assert.equal(out.length, input.length);
  for (const s of ['Secret', 'Jane', 'Acme', 'comment']) assert.ok(!text(out).includes(s), `${s} left`);
  assert.equal(out[5] & 0xc0, 0, 'unsynchronisation flag cleared');
  const end = out.length;
  assert.equal(text(out.subarray(end - 128 + 93, end - 128 + 97)), '2025', 'ID3v1 year kept');
  assert.equal(out[end - 1], 0xff, 'no genre');
  const footer = end - 128 - 227 - 32;
  assert.equal(text(out.subarray(footer, footer + 8)), 'APETAGEX');
  assert.equal(new DataView(out.buffer, out.byteOffset).getUint32(footer + 16, true), 0, 'APE item count 0');
  assert.ok(out.subarray(footer - 23, footer).every((x) => x === 0), 'APE items zeroed');
});

test('WAV and FLAC: metadata chunks become JUNK and metadata blocks padding', () => {
  const wav = stripMediaMetadata(load('audio.wav'));
  assert.ok(text(wav).includes('JUNK') && text(wav).includes('fmt ') && text(wav).includes('data'));
  assert.ok(!text(wav).includes('LIST') && !text(wav).includes('bext'));
  const flac = stripMediaMetadata(load('audio.flac'));
  const types = [];
  for (let p = 4; ; ) {
    types.push(flac[p] & 0x7f);
    const n = (flac[p + 1] << 16) | (flac[p + 2] << 8) | flac[p + 3];
    if (flac[p] & 0x80) break;
    p += 4 + n;
  }
  assert.equal(types[0], 0, 'STREAMINFO first, untouched');
  assert.ok(!types.includes(4) && !types.includes(6), `no comments or pictures left: ${types}`);
});

test('anything malformed or unknown gives no patches', () => {
  const read = (b) => ({ size: b.length, read: (at, n) => b.subarray(at, at + n) });
  const mov = load('video.mp4');
  assert.deepEqual(mediaPatches(read(mov.subarray(0, 40))), [], 'truncated inside moov');
  const tag = id3(3, 0, [frame('TIT2', 'Secret plan')]);
  assert.deepEqual(mediaPatches(read(new Uint8Array(tag.subarray(0, 15)))), [], 'tag longer than the file');
  assert.deepEqual(mediaPatches(read(new TextEncoder().encode('just some text, not audio at all TAG'))), []);
  assert.deepEqual(mediaPatches(read(new Uint8Array(0))), []);
});

test('Ogg: comment headers emptied and every page checksum still right', () => {
  const crc = (b) => {
    let c = 0;
    for (const x of b) {
      c ^= x << 24;
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    }
    return c >>> 0;
  };
  const chained = new Uint8Array(Buffer.concat([load('audio.ogg'), load('audio.opus')]));
  for (const f of ['audio.ogg', 'audio.opus', 'audio.oga', chained]) {
    const out = stripMediaMetadata(typeof f === 'string' ? load(f) : f.slice());
    if (typeof f !== 'string') {
      const t = text(out);
      assert.ok(!t.includes('Jane') && !t.includes('Lavf'), 'both parts of a chained file cleaned');
    }
    let pages = 0;
    for (let p = 0; p + 27 <= out.length; pages++) {
      assert.equal(text(out.subarray(p, p + 4)), 'OggS', `${f}: a page at ${p}`);
      let n = 27 + out[p + 26];
      for (let i = 0; i < out[p + 26]; i++) n += out[p + 27 + i];
      const page = out.slice(p, p + n);
      const want = new DataView(page.buffer).getUint32(22, true);
      page.fill(0, 22, 26);
      assert.equal(crc(page), want, `${f}: page ${pages} checksum`);
      p += n;
    }
    assert.ok(pages > 2);
  }
  const opus = text(stripMediaMetadata(load('audio.opus')));
  const tags = opus.indexOf('OpusTags');
  assert.equal(opus.slice(tags + 8, tags + 16), '\0'.repeat(8), 'no vendor, no comments');
});

test('Matroska: tags become Void elements, the cover attachment goes and the font stays', () => {
  const input = load('video.mkv');
  const out = stripMediaMetadata(input.slice());
  const t = text(out);
  assert.ok(text(input).includes('cover.png') && !t.includes('cover.png'), 'cover gone');
  assert.ok(t.includes('font.ttf'), 'font kept: subtitles need it');
  // the Tags ID now appears only as a seek head entry's SeekID (53 AB 84), never as an element
  const tags = [...t.matchAll(/\x12\x54\xc3\x67/g)].map((m) => m.index);
  assert.ok(tags.every((at) => t.slice(at - 3, at) === '\x53\xab\x84'), 'no Tags element left');
  assert.ok(!t.includes('Lavf') && !t.includes('Lavc'), 'muxing and writing apps and the Vorbis vendor emptied');
});

test('MP4: an action camera location track becomes a free box and its samples are zeroed', () => {
  const input = withLocationTrack(load('video.mp4'));
  const out = stripMediaMetadata(input.slice());
  assert.equal(out.length, input.length);
  for (const s of GPS_SAMPLES) assert.ok(text(input).includes(s) && !text(out).includes(s.slice(5, 13)), 'GPS sample zeroed');
  assert.ok(!text(out).includes('gpmd') && !text(out).includes('GoPro MET'), 'track gone');
  // the video and audio tracks are kept: at most the video encoder's name (32 bytes) changed
  const traks = (b) => [...text(b).matchAll(/trak/g)].map((m) => m.index);
  const kept = traks(out);
  assert.equal(kept.length, traks(input).length - 1);
  for (const at of kept) {
    const size = new DataView(out.buffer, out.byteOffset).getUint32(at - 4);
    let diff = 0;
    for (let i = at - 4; i < at - 4 + size; i++) if (out[i] !== input[i]) diff++;
    assert.ok(diff <= 32, `${diff} bytes of a kept track changed`);
  }
  assert.deepEqual(stripMediaMetadata(out.slice()), out, 'cleaning again changes nothing');
});

test('Matroska: track names and chapter titles emptied', () => {
  const input = load('video.mkv');
  for (const s of ['Jane Doe camera', 'Acme microphone', 'Jane Doe at Main Street']) assert.ok(text(input).includes(s), `fixture has ${s}`);
  const out = text(stripMediaMetadata(input.slice()));
  for (const s of ['Jane', 'Acme', 'Main Street']) assert.ok(!out.includes(s), `${s} left`);
});

test('motion JPEG: every frame loses its comment and Exif segments, nothing else changes', () => {
  for (const f of ['video-mjpeg.mov', 'video-mjpeg.mkv', 'video.avi']) {
    const input = load(f);
    const frames = (b) => [...text(b).matchAll(/\xff\xd8\xff/g)].length;
    assert.ok(frames(input) >= 5, `${f}: frames`);
    const out = stripMediaMetadata(input.slice());
    assert.equal(frames(out), frames(input), 'every frame still starts the same');
    assert.ok(text(input).includes('Lavc') && !text(out).includes('Lavc'), `${f}: the comment in each frame zeroed`);
    let changed = 0;
    for (let i = 0; i < input.length; i++) if (input[i] !== out[i]) changed++;
    assert.ok(changed < input.length / 20, `${f}: ${changed} bytes changed`);
  }
});

test('MP4: a subtitle track printing the position (DJI) is removed; ordinary subtitles stay', () => {
  const input = load('video-dji.mp4');
  assert.ok(text(input).includes('GPS (8.6332'));
  const out = stripMediaMetadata(input.slice());
  assert.ok(!text(out).includes('GPS (') && !text(out).includes('tx3g'), 'track gone');
  // the same file with ordinary words in the subtitle keeps its track
  const plain = Buffer.from(input);
  const at = plain.indexOf('GPS (8.6332');
  plain.write('Hello there', at, 'latin1');
  assert.ok(text(stripMediaMetadata(new Uint8Array(plain))).includes('tx3g'), 'ordinary subtitles kept');
});

test('MP4: an Insta360 trailer loses its GPS fixes and serial number; motion data stays', () => {
  const input = withInsta360Trailer(load('video.mp4'));
  const out = stripMediaMetadata(input.slice());
  assert.equal(out.length, input.length);
  const t = text(out);
  assert.ok(!t.includes('IXSE1234567CUBE'), 'serial number gone');
  assert.ok(t.includes('Insta360 X3') && t.includes(INSV_MOTION.toString('latin1')), 'model and motion data kept');
  assert.ok(t.endsWith('8db42d694ccc418790edff439fe026bf'), 'trailer still recognisable');
  const fix = Buffer.alloc(8);
  fix.writeDoubleLE(48.8584);
  assert.ok(Buffer.from(input).includes(fix) && !Buffer.from(out).includes(fix), 'GPS fixes zeroed');
});

test('MP4: video tracks lose the encoder name in their sample description', () => {
  const input = load('video-mjpeg.mov');
  const out = stripMediaMetadata(input.slice());
  const stsd = text(out).indexOf('stsd');
  assert.ok(stsd > 0 && !text(out).slice(stsd, stsd + 200).includes('Lavc'));
});
