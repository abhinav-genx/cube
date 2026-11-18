/**
 * Removes location and camera details from an image before it is stored.
 *
 * Lossless: pixels are never decoded or re-encoded. The metadata blocks are edited where they sit,
 * so nothing that follows them moves and offsets elsewhere in the file (HEIC item locations,
 * JPEG multi-picture offsets) stay valid. Removed:
 *   - the whole GPS block, overwritten with zeros;
 *   - camera, lens and software names, serial numbers, owner name, maker notes, comments,
 *     unique image IDs;
 *   - XMP and IPTC/Photoshop blocks, which can repeat any of the above.
 * Kept: orientation (so the photo is not shown sideways), size, colour profile and dates.
 *
 * Handles JPEG (including the extra images inside iPhone HDR JPEGs), PNG, WebP, HEIC/HEIF/AVIF,
 * GIF and TIFF. Other files are returned unchanged.
 *
 * Returns `bytes` itself, edited in place, except for PNG, which is rebuilt into a new array
 * (the caller should zero the original then).
 */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array {
  const b = bytes;
  if (b.length < 12) return b;
  if (b[0] === 0xff && b[1] === 0xd8) {
    stripJpeg(b);
    scanAll(b);
    return b;
  }
  if (startsWith(b, 0, PNG_SIG)) return stripPng(b);
  if (startsWith(b, 0, ascii('RIFF')) && startsWith(b, 8, ascii('WEBP'))) {
    stripWebp(b);
    scanAll(b);
    return b;
  }
  const isHeif = startsWith(b, 4, ascii('ftyp'));
  const isGif = startsWith(b, 0, ascii('GIF8'));
  const isTiff = isTiffHeader(b, 0);
  if (isHeif || isGif || isTiff) {
    if (isTiff) scrubTiff(b, 0, b.length);
    scanAll(b);
  }
  return b;
}

// ---------------------------------------------------------------------------------------------
// Containers

/** JPEG: scrub the Exif APP1 in place; XMP, extended XMP and IPTC segments become empty comments. */
function stripJpeg(b: Uint8Array): void {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return;
    const m = b[i + 1];
    if (m === 0xff) {
      i += 1;   // fill byte
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;   // markers without a length
      continue;
    }
    if (m === 0xda || m === 0xd9) return;   // image data starts / file ends
    const len = (b[i + 2] << 8) | b[i + 3];
    const data = i + 4;
    const end = i + 2 + len;
    if (len < 2 || end > b.length) return;
    if (m === 0xe1 && startsWith(b, data, EXIF_ID)) {
      scrubTiff(b, data + EXIF_ID.length, end);
    } else if ((m === 0xe1 && (startsWith(b, data, XMP_ID) || startsWith(b, data, XMP_EXT_ID))) || m === 0xed) {
      b[i + 1] = 0xfe;   // COM: a comment segment, ignored by decoders
      b.fill(0, data, end);
    }
    i = end;
  }
}

/** PNG: drop text and time chunks (they hold XMP, "Raw profile" Exif dumps, comments); scrub eXIf. */
function stripPng(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const end = i + 12 + len;
    if (end > b.length) break;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === 'eXIf') {
      const chunk = b.slice(i, end);
      scrubTiff(chunk, 8, 8 + len);
      writeU32be(chunk, 8 + len, crc32(chunk, 4, 8 + len));
      parts.push(chunk);
    } else if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt' && type !== 'tIME') {
      parts.push(b.subarray(i, end));
    }
    i = end;
    if (type === 'IEND') break;
  }
  if (i < b.length) parts.push(b.subarray(i));   // anything after IEND, untouched
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** WebP: scrub the EXIF chunk in place (XMP is blanked by scanAll). Chunk sizes do not change. */
function stripWebp(b: Uint8Array): void {
  let i = 12;
  while (i + 8 <= b.length) {
    const len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    const data = i + 8;
    const end = data + len;
    if (len < 0 || end > b.length) return;
    if (startsWith(b, i, ascii('EXIF'))) {
      scrubTiff(b, startsWith(b, data, EXIF_ID) ? data + EXIF_ID.length : data, end);
    }
    i = end + (len & 1);
  }
}

/**
 * Any container: finds embedded Exif/TIFF blocks and XMP packets and scrubs them. This is what
 * covers HEIC (Exif and XMP are items inside the file) and the secondary images of iPhone JPEGs.
 * A TIFF block is only edited if its whole structure checks out, so a chance match inside
 * compressed image data is left alone.
 */
function scanAll(b: Uint8Array): void {
  for (let i = b.indexOf(0x45); i >= 0 && i + 14 <= b.length; i = b.indexOf(0x45, i + 1)) {
    if (startsWith(b, i, EXIF_ID) && isTiffHeader(b, i + 6)) scrubTiff(b, i + 6, b.length);
  }
  // Exif stored without the "Exif\0\0" prefix (allowed in HEIF): a TIFF header whose first IFD
  // starts right after it, as virtually every writer does.
  for (const sig of [TIFF_LE_8, TIFF_BE_8]) {
    for (let i = b.indexOf(sig[0]); i >= 0 && i + 8 <= b.length; i = b.indexOf(sig[0], i + 1)) {
      if (startsWith(b, i, sig)) scrubTiff(b, i, b.length);
    }
  }
  blankXml(b, XMPMETA_OPEN, XMPMETA_CLOSE, ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/">'));
  blankXml(b, RDF_OPEN, RDF_CLOSE, ascii('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'));
}

/** Blanks every XMP packet in place (same length, still well-formed); for documents too. */
export function blankXmpPackets(b: Uint8Array): void {
  blankXml(b, XMPMETA_OPEN, XMPMETA_CLOSE, ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/">'));
  blankXml(b, RDF_OPEN, RDF_CLOSE, ascii('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'));
}

/** Replaces each <open ...>…</close> span with an empty element of the same length (spaces inside). */
function blankXml(b: Uint8Array, open: Uint8Array, close: Uint8Array, head: Uint8Array): void {
  let from = 0;
  for (;;) {
    const s = find(b, open, from);
    if (s < 0) return;
    const c = find(b, close, s + open.length);
    if (c < 0) return;
    const end = c + close.length;
    if (end - s >= head.length + close.length) {
      b.set(head, s);
      b.fill(0x20, s + head.length, c);
    }
    from = end;
  }
}

// ---------------------------------------------------------------------------------------------
// TIFF / Exif

const GPS_IFD = 0x8825;
const EXIF_IFD = 0x8769;

/** IFD0/IFD1 tags removed: names, software, free text, embedded XMP/IPTC/Photoshop blocks. */
const DROP_MAIN = new Set([
  0x010e, // ImageDescription
  0x010f, // Make
  0x0110, // Model
  0x0131, // Software
  0x013b, // Artist
  0x013c, // HostComputer
  0x02bc, // XMP packet
  0x8298, // Copyright
  0x83bb, // IPTC
  0x8649, // Photoshop resources
  0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f, // Windows XP title/comment/author/keywords/subject
  GPS_IFD,
]);

/** Exif sub-IFD tags removed: maker notes, comments, IDs, serial numbers, lens details. */
const DROP_EXIF = new Set([
  0x927c, // MakerNote
  0x9286, // UserComment
  0xa420, // ImageUniqueID
  0xa430, // CameraOwnerName
  0xa431, // BodySerialNumber
  0xa432, // LensSpecification
  0xa433, // LensMake
  0xa434, // LensModel
  0xa435, // LensSerialNumber
  GPS_IFD,
]);

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
const MAX_ENTRIES = 1000;

/**
 * Scrubs the TIFF structure in b[base, end). Validates every IFD it is going to edit first and
 * does nothing if the structure is broken. Removed entries are compacted out of their IFD and
 * their values (and the whole GPS IFD) are overwritten with zeros.
 */
function scrubTiff(b: Uint8Array, base: number, end: number): void {
  if (!isTiffHeader(b, base) || end - base < 8) return;
  const le = b[base] === 0x49;
  const size = end - base;
  const u16 = (o: number) => (le ? b[base + o] | (b[base + o + 1] << 8) : (b[base + o] << 8) | b[base + o + 1]);
  const u32 = (o: number) =>
    le
      ? (b[base + o] | (b[base + o + 1] << 8) | (b[base + o + 2] << 16) | (b[base + o + 3] << 24)) >>> 0
      : ((b[base + o] << 24) | (b[base + o + 1] << 16) | (b[base + o + 2] << 8) | b[base + o + 3]) >>> 0;
  const w16 = (o: number, v: number) => {
    b[base + o + (le ? 0 : 1)] = v & 0xff;
    b[base + o + (le ? 1 : 0)] = (v >> 8) & 0xff;
  };

  type Entry = { at: number; tag: number; type: number; count: number; value: number };
  /** Reads and validates an IFD; null if it does not fit or has impossible entries. */
  const read = (off: number): Entry[] | null => {
    if (off < 8 || off + 2 > size) return null;
    const n = u16(off);
    if (n === 0 || n > MAX_ENTRIES || off + 2 + 12 * n + 4 > size) return null;
    const out: Entry[] = [];
    for (let k = 0; k < n; k++) {
      const at = off + 2 + 12 * k;
      const type = u16(at + 2);
      if (type < 1 || type > 13) return null;
      out.push({ at, tag: u16(at), type, count: u32(at + 4), value: u32(at + 8) });
    }
    return out;
  };
  /** Zeros an entry's out-of-line value, if it has one and it lies inside the block. */
  const zeroValue = (e: Entry) => {
    const len = e.count * TYPE_SIZE[e.type];
    if (len > 4 && e.value >= 8 && e.value + len <= size) b.fill(0, base + e.value, base + e.value + len);
  };

  const seen = new Set<number>();
  const wipe = (off: number) => {
    const entries = read(off);
    if (!entries || seen.has(off)) return;
    seen.add(off);
    for (const e of entries) zeroValue(e);
    b.fill(0, base + off, base + off + 2 + 12 * entries.length + 4);
  };
  const scrub = (off: number, drop: Set<number>, main: boolean) => {
    const entries = read(off);
    if (!entries || seen.has(off)) return;
    seen.add(off);
    const kept: Entry[] = [];
    for (const e of entries) {
      if (e.tag === GPS_IFD) wipe(e.value);
      if (main && e.tag === EXIF_IFD) scrub(e.value, DROP_EXIF, false);
      if (drop.has(e.tag)) zeroValue(e);
      else kept.push(e);
    }
    const n = entries.length;
    const nextAt = off + 2 + 12 * n;
    const next = u32(nextAt);
    if (kept.length < n) {
      // Compact: kept entries move up (they stay in tag order), then the next-IFD pointer.
      const saved = kept.map((e) => b.slice(base + e.at, base + e.at + 12));
      saved.forEach((raw, k) => b.set(raw, base + off + 2 + 12 * k));
      w16(off, kept.length);
      const newNext = off + 2 + 12 * kept.length;
      b.set(b.slice(base + nextAt, base + nextAt + 4), base + newNext);
      b.fill(0, base + newNext + 4, base + nextAt + 4);
    }
    if (main && next) scrub(next, DROP_MAIN, true);   // IFD1 (thumbnail) and any further IFDs
  };
  scrub(u32(4), DROP_MAIN, true);
}

// ---------------------------------------------------------------------------------------------
// Bytes

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const EXIF_ID = Uint8Array.of(0x45, 0x78, 0x69, 0x66, 0, 0);   // "Exif\0\0"
const XMP_ID = ascii('http://ns.adobe.com/xap/1.0/\0');
const XMP_EXT_ID = ascii('http://ns.adobe.com/xmp/extension/\0');
const TIFF_LE_8 = Uint8Array.of(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0);
const TIFF_BE_8 = Uint8Array.of(0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8);
const XMPMETA_OPEN = ascii('<x:xmpmeta');
const XMPMETA_CLOSE = ascii('</x:xmpmeta>');
const RDF_OPEN = ascii('<rdf:RDF');
const RDF_CLOSE = ascii('</rdf:RDF>');

function isTiffHeader(b: Uint8Array, i: number): boolean {
  return (
    i + 8 <= b.length &&
    ((b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0) ||
      (b[i] === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0 && b[i + 3] === 0x2a))
  );
}

function startsWith(b: Uint8Array, at: number, sig: Uint8Array): boolean {
  if (at < 0 || at + sig.length > b.length) return false;
  for (let k = 0; k < sig.length; k++) if (b[at + k] !== sig[k]) return false;
  return true;
}

function find(b: Uint8Array, sig: Uint8Array, from: number): number {
  for (let i = b.indexOf(sig[0], from); i >= 0; i = b.indexOf(sig[0], i + 1)) {
    if (startsWith(b, i, sig)) return i;
  }
  return -1;
}

function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function writeU32be(b: Uint8Array, i: number, v: number): void {
  b[i] = v >>> 24;
  b[i + 1] = (v >>> 16) & 0xff;
  b[i + 2] = (v >>> 8) & 0xff;
  b[i + 3] = v & 0xff;
}

let crcTable: Uint32Array | null = null;
function crc32(b: Uint8Array, from: number, to: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
