import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { mediaPatches, stripMediaMetadata } from '../lib/mediameta.ts';
import { frame, id3, FRAME, mp3AllTags, mp4LargeBox } from './fixtures/media.mjs';

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
