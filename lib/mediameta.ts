/**
 * Removes identifying details from videos and audio before they are stored, the way lib/strip.ts
 * does for photos: location, device make and model, software, names, titles, comments and cover
 * art. Dates are kept where the format makes that easy (MP4/MOV creation dates, ID3 date frames).
 *
 * Everything is edited in place, at the same length, so nothing that follows moves and every
 * offset in the file (MP4 sample tables point into the file by absolute offset) stays valid.
 * mediaPatches only reads box, frame and chunk headers (never sample data) and returns the
 * patches; native code (modules/cube-native CubeMediaClean) finds the same patches while reading
 * the picked file in place and applies them as it streams.
 *
 * - MP4, MOV, M4A, 3GP: inside moov (and each trak), user-data and metadata items other than the
 *   creation date are turned into "free" boxes, which every player skips, with their contents
 *   zeroed; so are XMP boxes. That removes the location (©xyz, ISO 6709 keys), make, model,
 *   software, title, artist, comments and cover art.
 * - MP3 (and other MPEG audio): ID3v2 frames other than dates become padding; ID3v1, Enhanced
 *   ID3v1 ("TAG+") and APEv2 tags are emptied.
 * - FLAC: Vorbis comments, pictures and application blocks become padding.
 * - WAV: LIST/INFO, bext, iXML, XMP, ID3, cart and axml chunks become JUNK chunks.
 * Anything else, or anything malformed, gives no patches: the file is stored as picked.
 */
import type { Patch, RandomRead } from './docmeta';

/** Zeros shared by every patch that blanks a region (patches never write to their bytes). */
const ZERO = new Uint8Array(1 << 20);
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const str = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const syncsafe = (b: Uint8Array, at: number) => ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);

/** Patches that zero `n` bytes at `at` (all sharing one block of zeros). */
export function zeroPatches(patches: Patch[], at: number, n: number): void {
  while (n > 0) {
    const k = Math.min(n, ZERO.length);
    patches.push({ at, bytes: ZERO.subarray(0, k) });
    at += k;
    n -= k;
  }
}

/** Reads exactly `n` bytes at `at`, or throws (the file is shorter than its headers say). */
function read(src: RandomRead, at: number, n: number): Uint8Array {
  if (at < 0 || n < 0 || at + n > src.size) throw new RangeError('past the end');
  return src.read(at, n);
}

/** Same-length patches that remove identifying details from a video or audio file (see above). */
export function mediaPatches(src: RandomRead): Patch[] {
  const patches: Patch[] = [];
  try {
    if (src.size < 12) return [];
    const head = read(src, 0, 12);
    if (isMp4(head)) {
      mp4(src, 0, src.size, 'top', patches);
      return patches;
    }
    if (str(head, 0, 4) === 'RIFF' || str(head, 0, 4) === 'RF64') {
      if (str(head, 8, 4) === 'WAVE') riff(src, patches);
      return patches;
    }
    let at = 0;
    if (str(head, 0, 3) === 'ID3' && head[3] >= 2 && head[3] <= 4) at = id3v2(src, head, patches);
    if (at + 4 <= src.size && str(read(src, at, 4), 0, 4) === 'fLaC') {
      flac(src, at + 4, patches);
      return patches;
    }
    // tags at the end only for MPEG audio: an ID3v2 tag at the start, or a frame sync
    if (at > 0 || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) endTags(src, patches);
    return patches;
  } catch {
    return [];   // malformed: store as picked
  }
}

/** Applies mediaPatches to a whole file in memory (the JavaScript fallback); returns `bytes`. */
export function stripMediaMetadata(bytes: Uint8Array): Uint8Array {
  for (const { at, bytes: p } of mediaPatches({ size: bytes.length, read: (at, n) => bytes.subarray(at, at + n) })) bytes.set(p, at);
  return bytes;
}

// ---- MP4 / MOV ---------------------------------------------------------------------------------

const TOP_TYPES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']);
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
/** User-data boxes that stay: the creation date, chapters and track-selection or hint details. */
const KEEP_UDTA = new Set(['©day', 'chpl', 'tsel', 'hnti', 'hinf']);
/** Metadata keys that stay: dates and what players need to play slow motion at the right speed. */
const KEEP_KEY = /creationdate|capture\.fps|full-frame-rate-playback-intent/i;

function isMp4(head: Uint8Array): boolean {
  const size = u32(head, 0);
  return TOP_TYPES.has(str(head, 4, 4)) && (size === 0 || size === 1 || size >= 8);
}

type Box = { at: number; size: number; type: string; head: number };

function boxes(src: RandomRead, from: number, to: number): Box[] {
  const list: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const h = read(src, at, Math.min(16, to - at));
    let size = u32(h, 0);
    const type = str(h, 4, 4);
    let head = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = u32(h, 8) * 0x1_0000_0000 + u32(h, 12);
      head = 16;
    } else if (size === 0) size = to - at;
    if (size < head || at + size > to) break;
    list.push({ at, size, type, head });
    at += size;
  }
  return list;
}

function blank(b: Box, patches: Patch[]): void {
  patches.push({ at: b.at + 4, bytes: ascii('free') });
  zeroPatches(patches, b.at + b.head, b.size - b.head);
}

function isXmpUuid(src: RandomRead, b: Box): boolean {
  if (b.type !== 'uuid' || b.size < b.head + 16) return false;
  return Array.from(read(src, b.at + b.head, 16), (x) => x.toString(16).padStart(2, '0')).join('') === XMP_UUID;
}

type Where = 'top' | 'moov' | 'trak' | 'udta';

function mp4(src: RandomRead, from: number, to: number, where: Where, patches: Patch[]): void {
  for (const b of boxes(src, from, to)) {
    const inner = b.at + b.head;
    if (isXmpUuid(src, b)) blank(b, patches);
    else if (b.type === 'meta') meta(src, b, patches);
    else if (where === 'top') {
      if (b.type === 'moov') mp4(src, inner, b.at + b.size, 'moov', patches);
    } else if (where === 'udta') {
      if (!KEEP_UDTA.has(b.type)) blank(b, patches);
    } else if (b.type === 'udta') mp4(src, inner, b.at + b.size, 'udta', patches);
    else if (b.type === 'trak' && where === 'moov') mp4(src, inner, b.at + b.size, 'trak', patches);
  }
}

/** A metadata box: QuickTime's (children right away) or ISO's (version and flags first). */
function meta(src: RandomRead, b: Box, patches: Patch[]): void {
  let inner = b.at + b.head;
  const end = b.at + b.size;
  if (inner + 8 > end) return;
  if (str(read(src, inner, 8), 4, 4) !== 'hdlr') inner += 4;
  const children = boxes(src, inner, end);
  let keys: string[] | null = null;
  for (const c of children) if (c.type === 'keys') keys = readKeys(src, c);
  for (const c of children) {
    if (c.type === 'ilst') {
      for (const item of boxes(src, c.at + c.head, c.at + c.size)) {
        const index = u32(read(src, item.at + 4, 4), 0);
        const name = keys && index >= 1 && index <= keys.length ? keys[index - 1] : item.type;
        if (name !== '©day' && !KEEP_KEY.test(name)) blank(item, patches);
      }
    } else if (c.type === 'xml ' || c.type === 'XMP_' || isXmpUuid(src, c)) blank(c, patches);
  }
}

/** QuickTime metadata key names, in order (item types in ilst are 1-based indexes into them). */
function readKeys(src: RandomRead, b: Box): string[] | null {
  const n = b.size - b.head;
  if (n < 8 || n > 1 << 20) return null;
  const k = read(src, b.at + b.head, n);
  const count = u32(k, 4);
  const keys: string[] = [];
  let p = 8;
  for (let i = 0; i < count; i++) {
    if (p + 8 > k.length) return null;
    const size = u32(k, p);
    if (size < 8 || p + size > k.length) return null;
    keys.push(str(k, p + 8, size - 8));
    p += size;
  }
  return keys;
}

// ---- MP3: ID3v2, ID3v1, Enhanced ID3v1, APEv2 ----------------------------------------------------

const ID3_DATES = new Set(['TDRC', 'TYER', 'TDAT', 'TIME', 'TDOR', 'TORY', 'TDRL', 'TYE', 'TDA', 'TIM', 'TOR']);
/** Tags larger than this are zeroed whole rather than read to keep their dates. */
const ID3_MAX = 64 * 1024 * 1024;

/** Keeps only date frames (moved to the front), padding after them; returns where the tag ends. */
function id3v2(src: RandomRead, head: Uint8Array, patches: Patch[]): number {
  const ver = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  const footer = ver === 4 && flags & 0x10 ? 10 : 0;
  if (10 + size + footer > src.size) throw new RangeError('tag past the end');
  const plain = !(flags & 0x80) && !(flags & 0x40);   // unsynchronised, extended header (v2.2: compressed)
  if (plain && size <= ID3_MAX) {
    const tag = read(src, 10, size);
    const body = new Uint8Array(size);
    let q = 0;
    let p = 0;
    while (p < size && tag[p] !== 0) {
      const hl = ver === 2 ? 6 : 10;
      if (p + hl > size) break;
      const id = str(tag, p, ver === 2 ? 3 : 4);
      const n = ver === 2 ? (tag[p + 3] << 16) | (tag[p + 4] << 8) | tag[p + 5] : ver === 4 ? syncsafe(tag, p + 4) : u32(tag, p + 4);
      if (p + hl + n > size) break;
      if (ID3_DATES.has(id)) {
        body.set(tag.subarray(p, p + hl + n), q);
        q += hl + n;
      }
      p += hl + n;
    }
    patches.push({ at: 10, bytes: body });
  } else zeroPatches(patches, 10, size);
  const clean = Uint8Array.of(flags & ~0xc0);
  patches.push({ at: 5, bytes: clean });
  if (footer) patches.push({ at: 10 + size + 5, bytes: clean });
  return 10 + size + footer;
}

function endTags(src: RandomRead, patches: Patch[]): void {
  let end = src.size;
  if (end >= 128 && str(read(src, end - 128, 3), 0, 3) === 'TAG') {
    const at = end - 128;
    zeroPatches(patches, at + 3, 90);         // title, artist, album; the year (4 bytes) stays
    zeroPatches(patches, at + 97, 30);        // comment (and track number)
    patches.push({ at: at + 127, bytes: Uint8Array.of(0xff) });   // no genre
    end = at;
    if (end >= 227 && str(read(src, end - 227, 4), 0, 4) === 'TAG+') {
      zeroPatches(patches, end - 227 + 4, 223);
      end -= 227;
    }
  }
  if (end >= 32) {
    const f = read(src, end - 32, 32);
    if (str(f, 0, 8) === 'APETAGEX') {
      const size = u32le(f, 12);   // items and footer
      const hasHeader = (u32le(f, 20) & 0x80000000) !== 0;
      const items = end - size;
      if (size >= 32 && items - (hasHeader ? 32 : 0) >= 0) {
        zeroPatches(patches, items, size - 32);
        zeroPatches(patches, end - 32 + 16, 4);   // item count 0
        if (hasHeader) zeroPatches(patches, items - 32 + 16, 4);
      }
    }
  }
}

// ---- FLAC --------------------------------------------------------------------------------------

function flac(src: RandomRead, from: number, patches: Patch[]): void {
  let p = from;
  for (;;) {
    const h = read(src, p, 4);
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const n = (h[1] << 16) | (h[2] << 8) | h[3];
    if (p + 4 + n > src.size) return;
    if (type === 2 || type === 4 || type === 6) {   // application, Vorbis comment, picture → padding
      patches.push({ at: p, bytes: Uint8Array.of(last | 1) });
      zeroPatches(patches, p + 4, n);
    }
    p += 4 + n;
    if (last) return;
  }
}

// ---- WAV ---------------------------------------------------------------------------------------

const RIFF_BLANK = new Set(['bext', 'iXML', '_PMX', 'id3 ', 'ID3 ', 'cart', 'axml']);

function riff(src: RandomRead, patches: Patch[]): void {
  const declared = u32le(read(src, 4, 4), 0);
  const end = declared === 0xffffffff ? src.size : Math.min(src.size, 8 + declared);
  let p = 12;
  while (p + 8 <= end) {
    const h = read(src, p, 12 <= end - p ? 12 : 8);
    const id = str(h, 0, 4);
    const n = u32le(h, 4);
    if (n === 0xffffffff || p + 8 + n > end) return;
    if (RIFF_BLANK.has(id) || (id === 'LIST' && h.length >= 12 && str(h, 8, 4) === 'INFO')) {
      patches.push({ at: p, bytes: ascii('JUNK') });
      zeroPatches(patches, p + 8, n);
    }
    p += 8 + n + (n & 1);
  }
}
