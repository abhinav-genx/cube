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
 * - WAV: LIST/INFO, bext, iXML, XMP, ID3, cart and axml chunks become JUNK chunks. AVI: the same,
 *   and the camera chunks in its header (stream data, Nikon's tags).
 * - AIFF, AIFC: name, author, copyright, annotation, comment and ID3 chunks become JUNK chunks.
 * - Ogg (Vorbis, Opus, Theora, Speex, FLAC): the comment header of every stream (chained files
 *   included) is emptied (no vendor, no comments; Ogg FLAC as for FLAC) and the page checksums updated.
 * - Matroska, WebM: tags become Void elements; the title, the muxing and writing apps, track names
 *   and chapter titles are emptied; image attachments (cover art) become Void elements.
 * - Location tracks that action cameras record beside the video (GoPro GPMF, Google CAMM, DJI and
 *   Sony metadata tracks, and DJI subtitle tracks that print the position) become "free" boxes and
 *   their samples are zeroed; so are the GPS records and serial number in an Insta360 trailer.
 * - Motion-JPEG video (MP4, MOV, Matroska, AVI): each frame loses its Exif, XMP and comment segments.
 * - Video tracks lose the encoder name in their sample descriptions.
 * Anything else, or anything malformed, gives no patches: the file is stored as picked.
 */
import type { Patch, RandomRead } from './docmeta';

/** Zeros shared by every patch that blanks a region (patches never write to their bytes). */
const ZERO = new Uint8Array(1 << 20);
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const str = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
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
      insta360(src, patches);
      return patches;
    }
    if (str(head, 0, 4) === 'RIFF' || str(head, 0, 4) === 'RF64') {
      if (str(head, 8, 4) === 'WAVE' || str(head, 8, 4) === 'AVI ') riff(src, patches);
      return patches;
    }
    if (str(head, 0, 4) === 'FORM') {
      if (str(head, 8, 4) === 'AIFF' || str(head, 8, 4) === 'AIFC') aiff(src, patches);
      return patches;
    }
    if (str(head, 0, 4) === 'OggS') {
      ogg(src, patches);
      return patches;
    }
    if (u32(head, 0) === 0x1a45dfa3) {
      matroska(src, patches);
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

/**
 * JPEG segments zeroed in photos inside PDFs and in motion-JPEG video frames: APP1 (Exif, XMP),
 * APP3–APP13 (IPTC…), APP15 and comments. JFIF/AVI1 (APP0), the colour profile (APP2) and Adobe
 * (APP14) segments stay.
 */
const blankSegment = (m: number) => m === 0xe1 || (m >= 0xe3 && m <= 0xed) || m === 0xef || m === 0xfe;

/** Zeroes the identifying segments of the JPEG at `at` (up to its image data), in place. */
export function jpegPatches(src: RandomRead, at: number, patches: Patch[]): void {
  if (at + 2 > src.size) return;
  const soi = src.read(at, 2);
  if (soi[0] !== 0xff || soi[1] !== 0xd8) return;
  let p = at + 2;
  while (p + 4 <= src.size) {
    const m = src.read(p, 4);
    if (m[0] !== 0xff) return;
    const marker = m[1];
    if (marker === 0xff) {   // fill byte
      p++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return;   // image data (or the end): metadata comes before
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    const len = (m[2] << 8) | m[3];
    if (len < 2 || p + 2 + len > src.size) return;
    if (blankSegment(marker)) zeroPatches(patches, p + 4, len - 2);
    p += 2 + len;
  }
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
    else if (b.type === 'trak' && where === 'moov') {
      if (locationTrack(src, b, patches)) blank(b, patches);
      else {
        mjpegTrack(src, b, patches);
        compressorNames(src, b, patches);
        mp4(src, inner, b.at + b.size, 'trak', patches);
      }
    }
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

function flac(src: RandomRead, from: number, patches: Patch[], end = src.size): void {
  let p = from;
  for (;;) {
    if (p + 4 > end) return;
    const h = read(src, p, 4);
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const n = (h[1] << 16) | (h[2] << 8) | h[3];
    if (p + 4 + n > end) return;
    if (type === 2 || type === 4 || type === 6) {   // application, Vorbis comment, picture → padding
      patches.push({ at: p, bytes: Uint8Array.of(last | 1) });
      zeroPatches(patches, p + 4, n);
    }
    p += 4 + n;
    if (last) return;
  }
}

// ---- WAV ---------------------------------------------------------------------------------------

/** Chunks that become JUNK: broadcast, iXML, XMP, ID3, cart and axml (WAV), stream data (AVI cameras). */
const RIFF_BLANK = new Set(['bext', 'iXML', '_PMX', 'id3 ', 'ID3 ', 'cart', 'axml', 'strd']);
/** Lists that become JUNK: text tags, and Nikon's camera tags in an AVI header. */
const RIFF_BLANK_LIST = new Set(['INFO', 'ncdt']);
/** Lists looked inside: an AVI's header and its stream headers, and its frames ("rec " groups some). */
const RIFF_OPEN_LIST = new Set(['hdrl', 'strl', 'movi', 'rec ']);

function riff(src: RandomRead, patches: Patch[]): void {
  const declared = u32le(read(src, 4, 4), 0);
  const end = declared === 0xffffffff ? src.size : Math.min(src.size, 8 + declared);
  riffChunks(src, 12, end, 0, patches);
  // an AVI over 1 GB goes on in more RIFF chunks ("AVIX"), each with frames of its own
  for (let p = end + (end & 1); p + 12 <= src.size; ) {
    const h = read(src, p, 12);
    const n = u32le(h, 4);
    if (str(h, 0, 4) !== 'RIFF' || str(h, 8, 4) !== 'AVIX' || p + 8 + n > src.size) return;
    riffChunks(src, p + 12, p + 8 + n, 0, patches);
    p += 8 + n + (n & 1);
  }
}

function riffChunks(src: RandomRead, from: number, end: number, depth: number, patches: Patch[]): void {
  let p = from;
  while (p + 8 <= end) {
    const h = read(src, p, 12 <= end - p ? 12 : 8);
    const id = str(h, 0, 4);
    const n = u32le(h, 4);
    if (n === 0xffffffff || p + 8 + n > end) return;
    const list = id === 'LIST' && h.length >= 12 ? str(h, 8, 4) : '';
    if (RIFF_BLANK.has(id) || RIFF_BLANK_LIST.has(list)) {
      patches.push({ at: p, bytes: ascii('JUNK') });
      zeroPatches(patches, p + 8, n);
    } else if (RIFF_OPEN_LIST.has(list) && depth < 3) riffChunks(src, p + 12, p + 8 + n, depth + 1, patches);
    else if (depth > 0 && /^\d\d(dc|db)$/.test(id) && n >= 4) {
      const soi = read(src, p + 8, 2);
      if (soi[0] === 0xff && soi[1] === 0xd8) jpegPatches(src, p + 8, patches);   // a motion-JPEG frame
    }
    p += 8 + n + (n & 1);
  }
}

// ---- MP4 / MOV: location tracks ----------------------------------------------------------------

/**
 * Sample formats of timed-metadata tracks that carry a location: GoPro GPMF, Google's camera motion
 * metadata, DJI's metadata and debug tracks, Sony's real-time metadata.
 */
const LOCATION_FORMATS = new Set(['gpmd', 'camm', 'djmd', 'dbgi', 'rtmd']);
/** Sample tables larger than this are not read (the track is still turned into a free box). */
const TABLE_MAX = 64 * 1024 * 1024;

function child(src: RandomRead, b: Box, type: string): Box | undefined {
  return boxes(src, b.at + b.head, b.at + b.size).find((c) => c.type === type);
}

/** Text tracks (subtitles) whose samples are looked at for a printed position, as DJI drones write. */
const TEXT_FORMATS = new Set(['tx3g', 'text', 'wvtt']);
/** How DJI subtitles print the position: "GPS (8.6332, 47.4028, 21)" or "[latitude: 47.40] [longitude: 8.63]". */
const PRINTED_POSITION = /GPS\s*\(\s*-?\d|\[\s*latitude\s*:|\[\s*longitude\s*:/i;

/** A track's sample table and the format of its first sample entry. */
function sampleTable(src: RandomRead, trak: Box): { stbl: Box; format: string } | null {
  const mdia = child(src, trak, 'mdia');
  const minf = mdia && child(src, mdia, 'minf');
  const stbl = minf && child(src, minf, 'stbl');
  const stsd = stbl && child(src, stbl, 'stsd');
  if (!stbl || !stsd || stsd.size < stsd.head + 16) return null;
  return { stbl, format: str(read(src, stsd.at + stsd.head + 12, 4), 0, 4) };
}

/**
 * True (with its samples zeroed) for a track whose samples are locations: see LOCATION_FORMATS, and
 * text tracks whose first samples print a position.
 */
function locationTrack(src: RandomRead, trak: Box, patches: Patch[]): boolean {
  const t = sampleTable(src, trak);
  if (!t) return false;
  if (!LOCATION_FORMATS.has(t.format)) {
    if (!TEXT_FORMATS.has(t.format)) return false;
    const first = samples(src, t.stbl, 8);
    if (!first.some(([at, n]) => PRINTED_POSITION.test(str(read(src, at, Math.min(n, 512)), 0, 512)))) return false;
  }
  for (const [at, n] of sampleRanges(src, t.stbl)) zeroPatches(patches, at, n);
  return true;
}

/**
 * A video track's sample entries name the encoder (the 32-byte compressor name: "Lavc61 mjpeg",
 * an editor's name); it becomes empty. Only in tracks whose handler is video.
 */
function compressorNames(src: RandomRead, trak: Box, patches: Patch[]): void {
  const mdia = child(src, trak, 'mdia');
  const hdlr = mdia && child(src, mdia, 'hdlr');
  if (!mdia || !hdlr || hdlr.size < hdlr.head + 12 || str(read(src, hdlr.at + hdlr.head + 8, 4), 0, 4) !== 'vide') return;
  const minf = child(src, mdia, 'minf');
  const stbl = minf && child(src, minf, 'stbl');
  const stsd = stbl && child(src, stbl, 'stsd');
  if (!stsd || stsd.size < stsd.head + 8) return;
  for (const e of boxes(src, stsd.at + stsd.head + 8, stsd.at + stsd.size)) {
    if (e.head === 8 && e.size >= 86) zeroPatches(patches, e.at + 50, 32);
  }
}

/** Sample formats of motion-JPEG video: every frame is a JPEG that can carry Exif. */
const MJPEG_FORMATS = new Set(['jpeg', 'mjpa', 'mjpb', 'AVDJ', 'dmb1']);

/** Zeroes the Exif, XMP and comment segments of every frame of a motion-JPEG track. */
function mjpegTrack(src: RandomRead, trak: Box, patches: Patch[]): void {
  const t = sampleTable(src, trak);
  if (!t || !MJPEG_FORMATS.has(t.format)) return;
  for (const [at, n] of samples(src, t.stbl)) if (n >= 4) jpegPatches(src, at, patches);
}

function table(src: RandomRead, b: Box | undefined): Uint8Array | null {
  if (!b || b.size - b.head < 8 || b.size - b.head > TABLE_MAX) return null;
  return read(src, b.at + b.head, b.size - b.head);
}

/** Where a track's samples are in the file, adjacent samples merged; empty if the tables are odd. */
function sampleRanges(src: RandomRead, stbl: Box): [number, number][] {
  const ranges: [number, number][] = [];
  for (const [at, n] of samples(src, stbl)) {
    const last = ranges[ranges.length - 1];
    if (last && last[0] + last[1] === at) last[1] += n;
    else if (n > 0) ranges.push([at, n]);
  }
  return ranges;
}

/** Where each of a track's samples is in the file (the first `max`); empty if the tables are odd. */
function samples(src: RandomRead, stbl: Box, max = Infinity): [number, number][] {
  const kids = boxes(src, stbl.at + stbl.head, stbl.at + stbl.size);
  const find = (t: string) => kids.find((c) => c.type === t);
  const stsz = table(src, find('stsz'));
  const stsc = table(src, find('stsc'));
  const co64 = !find('stco');
  const stco = table(src, find('stco') ?? find('co64'));
  if (!stsz || !stsc || !stco || stsz.length < 12) return [];
  const uniform = u32(stsz, 4);
  const count = u32(stsz, 8);
  if (!uniform && stsz.length < 12 + count * 4) return [];
  const chunks = u32(stco, 4);
  if (stco.length < 8 + chunks * (co64 ? 8 : 4)) return [];
  const entries = u32(stsc, 4);
  if (stsc.length < 8 + entries * 12) return [];
  const list: [number, number][] = [];
  let s = 0;
  let e = 0;
  for (let c = 1; c <= chunks && s < count && s < max; c++) {
    while (e + 1 < entries && u32(stsc, 8 + (e + 1) * 12) <= c) e++;
    const perChunk = entries ? u32(stsc, 8 + e * 12 + 4) : 0;
    let at = co64 ? u32(stco, 8 + (c - 1) * 8) * 0x1_0000_0000 + u32(stco, 12 + (c - 1) * 8) : u32(stco, 8 + (c - 1) * 4);
    for (let k = 0; k < perChunk && s < count && s < max; k++, s++) {
      const n = uniform || u32(stsz, 12 + s * 4);
      if (at + n > src.size) return list;
      list.push([at, n]);
      at += n;
    }
  }
  return list;
}

// ---- Insta360 trailer --------------------------------------------------------------------------

const INSTA360_MAGIC = '8db42d694ccc418790edff439fe026bf';

/**
 * Insta360 cameras append a trailer after the video: records (each its data, then a record ID and
 * length) and 72 bytes ending in a magic number, with the trailer's length 38 bytes into the last
 * 78. The GPS record (0x700) is zeroed, and the serial number (tag 0x0a) in the camera record
 * (0x101); the motion, exposure and lens records that stitching needs stay. Record 0 is a table of
 * where the others are, used when present (as ExifTool reads it).
 */
function insta360(src: RandomRead, patches: Patch[]): void {
  if (src.size < 78) return;
  const tail = read(src, src.size - 78, 78);
  if (str(tail, 46, 32) !== INSTA360_MAGIC) return;
  const length = u32le(tail, 38);
  if (length > src.size || length < 78) return;
  const start = src.size - length;
  const records: [number, number, number][] = [];   // ID, where its data starts, its length
  let foot = src.size - 78;   // where the last record's ID and length are
  for (let k = 0; k < 4096; k++) {
    const f = read(src, foot, 6);
    const id = f[0] | (f[1] << 8);
    const len = u32le(f, 2);
    if (foot - len < start) break;
    records.push([id, foot - len, len]);
    if (id === 0) {   // the table: ID, size, offset from the trailer's start, 10 bytes each
      const table = read(src, foot - len, Math.min(len, 1 << 16));
      records.length = 0;
      for (let p = 0; p + 10 <= table.length; p += 10) {
        const rid = table[p] | (table[p + 1] << 8);
        const size = u32le(table, p + 2);
        const off = u32le(table, p + 6);
        if (rid && size && off + size < length) records.push([rid, start + off, size]);
      }
      break;
    }
    foot = foot - len - 6;
    if (foot < start) break;
  }
  for (const [id, at, len] of records) {
    if (id === 0x700) zeroPatches(patches, at, len);
    else if (id === 0x101) {
      const r = read(src, at, Math.min(len, 4096));
      for (let p = 0, i = 0; i < 4 && p + 2 <= r.length; i++) {
        const n = r[p + 1];
        if (p + 2 + n > r.length) break;
        if (r[p] === 0x0a) zeroPatches(patches, at + p + 2, n);   // serial number
        p += 2 + n;
      }
    }
  }
}

// ---- AIFF --------------------------------------------------------------------------------------

const AIFF_BLANK = new Set(['NAME', 'AUTH', '(c) ', 'ANNO', 'COMT', 'ID3 ', 'id3 ']);

function aiff(src: RandomRead, patches: Patch[]): void {
  const end = Math.min(src.size, 8 + u32(read(src, 4, 4), 0));
  let p = 12;
  while (p + 8 <= end) {
    const h = read(src, p, 8);
    const id = str(h, 0, 4);
    const n = u32(h, 4);
    if (p + 8 + n > end) return;
    if (AIFF_BLANK.has(id)) {
      patches.push({ at: p, bytes: ascii('JUNK') });
      zeroPatches(patches, p + 8, n);
    }
    p += 8 + n + (n & 1);
  }
}

// ---- Ogg ---------------------------------------------------------------------------------------

const OGG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return c;
}

/** One piece of a packet: where it is in the file and the page it is on. */
type Segment = { at: number; n: number; page: number };
type OggStream = { codec: string; packet: number; segs: Segment[]; done: boolean; headers: number };

/** The first `n` bytes of a packet (fewer if it is shorter). */
function packetHead(src: RandomRead, segs: Segment[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let q = 0;
  for (const s of segs) {
    if (q >= n) break;
    const k = Math.min(s.n, n - q);
    out.set(read(src, s.at, k), q);
    q += k;
  }
  return out.subarray(0, q);
}

/**
 * The cleaned start of a header packet (the rest of the packet becomes zeros), or null to leave it.
 * Comment headers keep their magic and get an empty vendor and no comments: Vorbis (with its framing
 * bit), Opus (zeros after the comment list are padding by RFC 7845), Theora and Speex. Ogg FLAC's
 * metadata blocks are cleaned as in a FLAC file.
 */
function oggPacket(s: OggStream, head: Uint8Array, total: number): Uint8Array | null {
  const magic = str(head, 0, 8);
  if (s.codec === 'vorbis' && magic.startsWith('\x03vorbis') && total >= 16) {
    const out = new Uint8Array(16);
    out.set(head.subarray(0, 7));
    out[15] = 1;   // framing bit
    return out;
  }
  if (s.codec === 'opus' && magic === 'OpusTags' && total >= 16) return head.slice(0, 8);
  if (s.codec === 'theora' && magic.startsWith('\x81theora') && total >= 15) return head.slice(0, 7);
  if (s.codec === 'speex' && total >= 8) return new Uint8Array(0);
  if (s.codec === 'flac' && head.length >= 4) {
    const type = head[0] & 0x7f;
    if (type !== 2 && type !== 4 && type !== 6) return null;
    return Uint8Array.of((head[0] & 0x80) | 1, head[1], head[2], head[3]);
  }
  return null;
}

function ogg(src: RandomRead, patches: Patch[]): void {
  const streams = new Map<number, OggStream>();
  const own: Patch[] = [];
  const touched = new Set<number>();
  const pageLength = new Map<number, number>();
  let p = 0;
  while (p + 27 <= src.size) {
    const h = read(src, p, 27);
    if (str(h, 0, 4) !== 'OggS' || h[4] !== 0) break;
    const flags = h[5];
    const serial = u32le(h, 14);
    const lacing = read(src, p + 27, h[26]);
    let at = p + 27 + lacing.length;
    let len = 0;
    for (const l of lacing) len += l;
    if (at + len > src.size) break;
    pageLength.set(p, at + len - p);
    let s = streams.get(serial);
    if (flags & 2) {
      s = { codec: '', packet: 0, segs: [], done: false, headers: 0 };
      streams.set(serial, s);
    }
    if (s && !s.done) {
      for (const l of lacing) {
        s.segs.push({ at, n: l, page: p });
        at += l;
        if (l === 255) continue;
        packet(src, s, own, touched);
        s.segs = [];
        s.packet++;
        if (s.done) break;
      }
    }
    p += pageLength.get(p)!;
  }
  for (const page of touched) {
    const n = pageLength.get(page)!;
    const b = read(src, page, n).slice();
    for (const x of own) if (x.at >= page && x.at < page + n) b.set(x.bytes, x.at - page);
    b.fill(0, 22, 26);
    const crc = oggCrc(b);
    b.fill(0);
    patches.push(...own.filter((x) => x.at >= page && x.at < page + n));
    patches.push({ at: page + 22, bytes: Uint8Array.of(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24) });
  }
}

/** Handles one whole packet of a stream: identifies the codec, or cleans a header packet. */
function packet(src: RandomRead, s: OggStream, own: Patch[], touched: Set<number>): void {
  const total = s.segs.reduce((n, x) => n + x.n, 0);
  const head = packetHead(src, s.segs, 16);
  if (s.packet === 0) {
    const magic = str(head, 0, 8);
    if (magic.startsWith('\x01vorbis')) s.codec = 'vorbis';
    else if (magic === 'OpusHead') s.codec = 'opus';
    else if (magic.startsWith('\x80theora')) s.codec = 'theora';
    else if (magic === 'Speex   ') s.codec = 'speex';
    else if (magic.startsWith('\x7fFLAC') && head.length >= 9) {
      s.codec = 'flac';
      s.headers = u16(head, 7) || Infinity;   // header packets after this one (0: not said)
    } else s.done = true;
    return;
  }
  if (s.codec === 'flac') {
    if (head[0] === 0xff) {   // an audio frame: no more metadata
      s.done = true;
      return;
    }
    if (head[0] & 0x80 || --s.headers <= 0) s.done = true;
  } else s.done = true;   // the comment header is the second packet
  const clean = oggPacket(s, head, total);
  if (!clean) return;
  let q = 0;
  for (const seg of s.segs) {
    const k = Math.max(0, Math.min(seg.n, clean.length - q));
    if (k > 0) own.push({ at: seg.at, bytes: clean.slice(q, q + k) });
    zeroPatches(own, seg.at + k, seg.n - k);
    q += seg.n;
    touched.add(seg.page);
  }
}

// ---- Matroska, WebM ----------------------------------------------------------------------------

const EBML = { Header: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab,
  SeekPosition: 0x53ac, Info: 0x1549a966, Title: 0x7ba9, MuxingApp: 0x4d80, WritingApp: 0x5741, Tags: 0x1254c367,
  Attachments: 0x1941a469, AttachedFile: 0x61a7, FileMimeType: 0x4660, Crc32: 0xbf, Tracks: 0x1654ae6b, TrackEntry: 0xae,
  CodecID: 0x86, CodecPrivate: 0x63a2, Name: 0x536e, TrackNumber: 0xd7, Chapters: 0x1043a770, EditionEntry: 0x45b9,
  ChapterAtom: 0xb6, ChapterDisplay: 0x80, ChapString: 0x85, Cluster: 0x1f43b675, SimpleBlock: 0xa3, BlockGroup: 0xa0,
  Block: 0xa1 };
/** Elements that can appear inside a cluster, to find where a cluster of unknown size ends. */
const CLUSTER_CHILDREN = new Set([0xe7, 0xa7, 0xab, 0x5854, 0xa3, 0xa0, 0xaf, 0xec, 0xbf]);

/** An element: where it starts, its ID, where its data starts and ends (end -1: unknown size). */
type El = { at: number; id: number; data: number; end: number };

function element(src: RandomRead, at: number, limit: number): El | null {
  const h = read(src, at, Math.min(12, limit - at));
  if (h.length < 2) return null;
  const idLen = Math.clz32(h[0]) - 23;   // 1 to 4: the first set bit gives the width
  if (idLen < 1 || idLen > 4 || h.length < idLen + 1) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + h[i];
  const sizeLen = Math.clz32(h[idLen]) - 23;
  if (sizeLen < 1 || sizeLen > 8 || h.length < idLen + sizeLen) return null;
  let size = h[idLen] & (0xff >> sizeLen);
  let unknown = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    size = size * 256 + h[idLen + i];
    if (h[idLen + i] !== 0xff) unknown = false;
  }
  const data = at + idLen + sizeLen;
  if (unknown) return { at, id, data, end: -1 };
  if (data + size > limit) return null;
  return { at, id, data, end: data + size };
}

function children(src: RandomRead, from: number, to: number): El[] {
  const list: El[] = [];
  for (let p = from; p < to; ) {
    const e = element(src, p, to);
    if (!e || e.end < 0) break;
    list.push(e);
    p = e.end;
  }
  return list;
}

/** Turns an element into a Void element of the same length, its contents zeroed. */
function voidElement(e: El, patches: Patch[]): void {
  const t = e.end - e.at;
  if (t < 2) return;
  let head: Uint8Array;
  if (t - 2 <= 126) head = Uint8Array.of(0xec, 0x80 | (t - 2));
  else {
    head = new Uint8Array(9);
    head[0] = 0xec;
    head[1] = 0x01;   // an 8-byte size
    for (let i = 8, v = t - 9; i >= 2; i--, v = Math.floor(v / 256)) head[i] = v % 256;
  }
  patches.push({ at: e.at, bytes: head });
  zeroPatches(patches, e.at + head.length, t - head.length);
}

/** An element's string, without the zeros it may be padded with. */
function text(src: RandomRead, e: El): string {
  return str(read(src, e.data, Math.min(64, e.end - e.data)), 0, 64).replace(/\0+$/, '');
}

/** Empties every chapter title (ChapString) under Chapters, nested chapters included. */
function chapterTitles(src: RandomRead, e: El, depth: number, patches: Patch[]): void {
  if (depth > 16) return;
  for (const k of children(src, e.data, e.end)) {
    if (k.id === EBML.ChapString) zeroPatches(patches, k.data, k.end - k.data);
    else if (k.id === EBML.EditionEntry || k.id === EBML.ChapterAtom || k.id === EBML.ChapterDisplay) chapterTitles(src, k, depth + 1, patches);
  }
}

/**
 * Walks every cluster (those of unknown size too: one ends where an element that cannot be in a
 * cluster starts) and cleans the frames of motion-JPEG tracks. Laced blocks (several frames in one)
 * are not used for video and are left alone.
 */
function mjpegClusters(src: RandomRead, from: number, to: number, tracks: Set<number>, patches: Patch[]): void {
  const frame = (b: El) => {
    const h = read(src, b.data, Math.min(12, b.end - b.data));
    const w = h.length > 0 ? Math.clz32(h[0]) - 23 : 0;   // the track number's width
    if (w < 1 || w > 8 || h.length < w + 3) return;
    let track = h[0] & (0xff >> w);
    for (let i = 1; i < w; i++) track = track * 256 + h[i];
    if (!tracks.has(track) || h[w + 2] & 0x06) return;   // another track, or laced
    if (b.data + w + 3 + 4 <= b.end) jpegPatches(src, b.data + w + 3, patches);
  };
  for (let p = from; p < to; ) {
    const e = element(src, p, to);
    if (!e) return;
    if (e.id !== EBML.Cluster) {
      if (e.end < 0) return;
      p = e.end;
      continue;
    }
    const end = e.end < 0 ? to : e.end;
    let q = e.data;
    while (q < end) {
      const k = element(src, q, end);
      if (!k || k.end < 0 || (e.end < 0 && !CLUSTER_CHILDREN.has(k.id))) break;
      if (k.id === EBML.SimpleBlock) frame(k);
      else if (k.id === EBML.BlockGroup) for (const b of children(src, k.data, k.end)) if (b.id === EBML.Block) frame(b);
      q = k.end;
    }
    p = e.end < 0 ? q : e.end;
    if (e.end < 0 && q >= end) return;
  }
}

function uint(src: RandomRead, e: El): number {
  const b = read(src, e.data, Math.min(8, e.end - e.data));
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function matroska(src: RandomRead, patches: Patch[]): void {
  const header = element(src, 0, src.size);
  if (!header || header.id !== EBML.Header || header.end < 0) return;
  const docType = children(src, header.data, header.end).find((e) => e.id === EBML.DocType);
  const type = docType ? str(read(src, docType.data, Math.min(16, docType.end - docType.data)), 0, docType.end - docType.data).replace(/\0+$/, '') : '';
  if (type !== 'matroska' && type !== 'webm') return;
  const seg = element(src, header.end, src.size);
  if (!seg || seg.id !== EBML.Segment) return;
  const segEnd = seg.end < 0 ? src.size : seg.end;
  const seen = new Set<number>();
  const queue: number[] = [];
  const mjpeg = new Set<number>();   // track numbers of motion-JPEG video
  // the segment's children one after another, as far as their sizes are known (a live recording's
  // clusters may not say), then whatever the seek heads point to
  for (let p = seg.data; p < segEnd; ) {
    const e = element(src, p, segEnd);
    if (!e || e.end < 0) break;
    queue.push(e.at);
    p = e.end;
  }
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (seen.has(at)) continue;
    seen.add(at);
    const e = element(src, at, segEnd);
    if (!e || e.end < 0) continue;
    if (e.id === EBML.SeekHead) {
      for (const seek of children(src, e.data, e.end)) {
        if (seek.id !== EBML.Seek) continue;
        const kids = children(src, seek.data, seek.end);
        const sid = kids.find((k) => k.id === EBML.SeekID);
        const pos = kids.find((k) => k.id === EBML.SeekPosition);
        if (!sid || !pos) continue;
        const target = uint(src, sid);
        if (target === EBML.Info || target === EBML.Tags || target === EBML.Attachments || target === EBML.SeekHead || target === EBML.Tracks || target === EBML.Chapters) queue.push(seg.data + uint(src, pos));
      }
    } else if (e.id === EBML.Info) {
      for (const k of children(src, e.data, e.end)) {
        if (k.id === EBML.Title || k.id === EBML.MuxingApp || k.id === EBML.WritingApp) zeroPatches(patches, k.data, k.end - k.data);   // an empty string
        else if (k.id === EBML.Crc32) voidElement(k, patches);
      }
    } else if (e.id === EBML.Tracks) {
      for (const t of children(src, e.data, e.end)) {
        if (t.id !== EBML.TrackEntry) continue;
        codecPrivate(src, t, patches);
        const kids = children(src, t.data, t.end);
        for (const k of kids) if (k.id === EBML.Name) zeroPatches(patches, k.data, k.end - k.data);   // an empty name
        const idEl = kids.find((k) => k.id === EBML.CodecID);
        const num = kids.find((k) => k.id === EBML.TrackNumber);
        if (idEl && num && text(src, idEl) === 'V_MJPEG') mjpeg.add(uint(src, num));
      }
    } else if (e.id === EBML.Chapters) chapterTitles(src, e, 0, patches);
    else if (e.id === EBML.Tags) voidElement(e, patches);
    else if (e.id === EBML.Attachments) {
      const kids = children(src, e.data, e.end);
      const files = kids.filter((k) => k.id === EBML.AttachedFile);
      const images = files.filter((f) => {
        const mime = children(src, f.data, f.end).find((k) => k.id === EBML.FileMimeType);
        return mime && str(read(src, mime.data, Math.min(6, mime.end - mime.data)), 0, 6) === 'image/';
      });
      if (images.length > 0 && images.length === files.length) voidElement(e, patches);
      else if (images.length > 0) {
        for (const f of images) voidElement(f, patches);
        for (const k of kids) if (k.id === EBML.Crc32) voidElement(k, patches);
      }
    }
  }
  if (mjpeg.size > 0) mjpegClusters(src, seg.data, segEnd, mjpeg, patches);
}

/**
 * A track's codec setup, where Matroska keeps what Ogg and FLAC files keep in their headers: the
 * Vorbis or Theora comment header (the second of three Xiph-laced packets) is emptied, and FLAC's
 * metadata blocks are cleaned as in a FLAC file.
 */
function codecPrivate(src: RandomRead, track: El, patches: Patch[]): void {
  const kids = children(src, track.data, track.end);
  const idEl = kids.find((k) => k.id === EBML.CodecID);
  const cp = kids.find((k) => k.id === EBML.CodecPrivate);
  if (!idEl || !cp) return;
  const codec = str(read(src, idEl.data, Math.min(32, idEl.end - idEl.data)), 0, 32).replace(/\0+$/, '');
  const n = cp.end - cp.data;
  if (codec === 'A_FLAC') {
    if (n >= 4 && str(read(src, cp.data, 4), 0, 4) === 'fLaC') flac(src, cp.data + 4, patches, cp.end);
    return;
  }
  if (codec !== 'A_VORBIS' && codec !== 'V_THEORA') return;
  const head = read(src, cp.data, Math.min(n, 64));
  if (head[0] !== 2) return;   // three packets
  const sizes: number[] = [];
  let q = 1;
  for (let k = 0; k < 2; k++) {
    let size = 0;
    for (;;) {
      if (q >= head.length) return;
      size += head[q];
      if (head[q++] !== 255) break;
    }
    sizes.push(size);
  }
  const at = cp.data + q + sizes[0];
  if (at + sizes[1] > cp.end) return;
  const s: OggStream = { codec: codec === 'A_VORBIS' ? 'vorbis' : 'theora', packet: 1, segs: [], done: true, headers: 0 };
  const clean = oggPacket(s, read(src, at, Math.min(16, sizes[1])), sizes[1]);
  if (!clean) return;
  patches.push({ at, bytes: clean.slice() });
  zeroPatches(patches, at + clean.length, sizes[1] - clean.length);
}
