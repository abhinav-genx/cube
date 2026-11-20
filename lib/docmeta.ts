/**
 * Removes author and organisation details from documents before they are stored, the way
 * lib/strip.ts does for photos and lib/mediameta.ts for videos and audio. Dates are kept.
 *
 * - PDF: the document-information strings (Author, Creator, Producer, Title, Subject, Keywords)
 *   are blanked in place, at the same length, so every offset in the file stays valid; XMP
 *   packets are blanked the same way. Information dictionaries inside Flate-compressed object
 *   streams (common in PDFs from recent tools), and compressed XMP streams, are decompressed,
 *   blanked, recompressed and written back at the same offset, PNG predictors and indirect
 *   lengths included; camera details in embedded JPEG photos are zeroed (pdfStreamPatches).
 * - Office (docx, xlsx, pptx and their macro variants): the author, last-modified-by, title,
 *   subject, keywords, comments and category in docProps/core.xml, company and manager in
 *   docProps/app.xml, every custom property value, the names of people who commented or tracked
 *   changes, and absolute paths that name the user's folders are emptied (cleanXml); embedded
 *   photos lose their location and camera details (lib/strip.ts); the zip is rebuilt.
 * - OpenDocument (odt, ods, odp, odg) and EPUB: the same for meta.xml, comment and tracked-change
 *   authors, and the package's .opf; embedded photos too.
 * - RTF: author, operator, company and the other \info fields, revision and comment authors and
 *   the generator are dropped as the file streams through (RtfCleaner).
 * - SVG: comments, <metadata> and editor attributes holding file paths are removed (stripSvg).
 *
 * Native code (modules/cube-native CubeDocClean) does all of these while streaming, at any size;
 * this is the reference it is checked against and the JavaScript fallback. PDFs and RTF stream here
 * too; zip documents and SVG are rebuilt in memory, so only those up to DOC_LIMIT bytes are
 * cleaned. Anything unrecognised, encrypted or malformed is returned unchanged rather than risk
 * damaging it.
 */
import { unzipSync, unzlibSync, zipSync, zlibSync, type Zippable } from 'fflate';
import { stripImageMetadata } from './strip';
import { stripMediaMetadata, zeroPatches } from './mediameta';

export const DOC_LIMIT = 50 * 1024 * 1024;

const OFFICE = /\.(docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp|odg|epub)$/i;
const OFFICE_MIME = /officedocument|ms-word\.document\.macro|ms-excel\.sheet\.macro|ms-powerpoint\.presentation\.macro|opendocument|epub\+zip/i;
const MEDIA = /\.(mp4|m4v|mov|3gp|3g2|m4a|m4b|aac|mp3|flac|wav)$/i;

/** How a file is cleaned on the way in, beyond photos (lib/strip.ts); null: stored as picked. */
export type DocumentKind = 'pdf' | 'office' | 'rtf' | 'svg' | 'media';

/** Which kind of document (or video, or audio) this is, for cleaning. */
export function documentKind(name: string, mime: string): DocumentKind | null {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (OFFICE.test(name) || OFFICE_MIME.test(mime)) return 'office';
  if (/\.rtf$/i.test(name) || /^(application|text)\/rtf$/i.test(mime)) return 'rtf';
  if (/\.svg$/i.test(name) || (mime === 'image/svg+xml' && !/\.svgz$/i.test(name))) return 'svg';   // .svgz is compressed: stored as picked
  if (MEDIA.test(name) || /^(video|audio)\//i.test(mime)) return 'media';
  return null;
}

/**
 * True for files the JavaScript fallback cleans in memory (cleanInMemory), up to DOC_LIMIT: zip
 * documents, SVG, videos and audio. PDFs and RTF stream through PdfCleaner and RtfCleaner at any
 * size; native code (modules/cube-native) cleans everything, at any size.
 */
export function isCleanableDocument(name: string, mime: string, size: number): boolean {
  const kind = documentKind(name, mime);
  return (kind === 'office' || kind === 'svg' || kind === 'media') && size <= DOC_LIMIT;
}

/** The JavaScript fallback's in-memory cleaning by kind; may return `bytes` itself (edited). */
export function cleanInMemory(kind: DocumentKind, bytes: Uint8Array): Uint8Array {
  if (kind === 'svg') return stripSvg(bytes);
  if (kind === 'media') return stripMediaMetadata(bytes);
  return stripDocumentMetadata(bytes);
}

/**
 * Returns the cleaned document: `bytes` itself, edited in place (PDF), or a new array (zip
 * documents, rebuilt; the caller should zero the original then). Unrecognised input comes back
 * unchanged.
 */
export function stripDocumentMetadata(bytes: Uint8Array): Uint8Array {
  if (startsWith(bytes, '%PDF-')) {
    stripPdf(bytes);
    return bytes;
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {   // "PK": a zip
    try {
      return stripZipDocument(bytes) ?? bytes;
    } catch {
      return bytes;   // malformed or encrypted: store as picked
    }
  }
  return bytes;
}

// ---- PDF ---------------------------------------------------------------------------------------

const PDF_KEYS = ['Author', 'Creator', 'Producer', 'Title', 'Subject', 'Keywords'];
const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isAlnum = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** XMP packets: opening tag, closing tag, and the empty opening tag that replaces the packet. */
const XMP_TAGS: [Uint8Array, Uint8Array, Uint8Array][] = [
  [ascii('<x:xmpmeta'), ascii('</x:xmpmeta>'), ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/">')],
  [ascii('<rdf:RDF'), ascii('</rdf:RDF>'), ascii('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">')],
];
/** An XMP packet longer than this is passed through as it is (they are a few KB in practice). */
export const XMP_MAX = 16 * 1024 * 1024;

const enum Mode { Normal, Name, AfterKey, HexOrDict, Hex, Literal, Tag, Capture }

/**
 * Blanks a PDF's document-information strings and XMP packets as it streams through, at the same
 * length, so offsets stay valid: every byte in gives exactly one byte out (a few are held back
 * while a tag or packet is still open). The native ports (CubeDocClean.swift / .kt) implement this
 * exact machine; tests/native checks they give the same bytes.
 *
 * - "/Author", "/Creator", "/Producer", "/Title", "/Subject" or "/Keywords" (and not a longer name
 *   such as /AuthorX), then optional whitespace, then a value:
 *   (literal) → every byte inside becomes a space, with nesting and backslash escapes followed;
 *   <hex> → each non-whitespace byte becomes '2' or '0' in turn, so the string decodes to spaces;
 *   << starts a dictionary and is left alone.
 * - <x:xmpmeta …>…</x:xmpmeta> and <rdf:RDF …>…</rdf:RDF> → an empty element of the same length.
 */
export class PdfCleaner {
  private mode = Mode.Normal;
  private name: number[] = [];
  private depth = 0;
  private escape = false;
  private hexN = 0;
  private held: number[] = [];   // a possible opening tag (Tag), or an open packet (Capture)
  private kind = 0;              // which XMP_TAGS entry is being captured
  private out = new Uint8Array(0);
  private len = 0;

  /** Feeds bytes in; returns the bytes that are final so far. */
  push(input: Uint8Array): Uint8Array {
    this.reserve(input.length);
    for (let i = 0; i < input.length; i++) this.step(input[i]);
    return this.take();
  }

  /** Ends the stream: anything still held (an unclosed tag or packet) passes through as it is. */
  finish(): Uint8Array {
    this.reserve(this.held.length);
    for (const c of this.held) this.emit(c);
    this.held = [];
    this.mode = Mode.Normal;
    return this.take();
  }

  private step(c: number): void {
    switch (this.mode) {
      case Mode.Name:
        if (isAlnum(c)) {
          if (this.name.length <= 8) this.name.push(c);   // longer than any key: never one
          this.emit(c);
          return;
        }
        this.mode = this.name.length <= 8 && PDF_KEYS.includes(String.fromCharCode(...this.name)) ? Mode.AfterKey : Mode.Normal;
        return this.step(c);
      case Mode.AfterKey:
        if (isWhite(c)) return this.emit(c);
        if (c === 0x28) {   // (
          this.mode = Mode.Literal;
          this.depth = 1;
          this.escape = false;
          return this.emit(c);
        }
        if (c === 0x3c) {   // <
          this.mode = Mode.HexOrDict;
          return this.emit(c);
        }
        this.mode = Mode.Normal;
        return this.step(c);
      case Mode.HexOrDict:
        if (c === 0x3c) {   // <<: a dictionary
          this.mode = Mode.Normal;
          return this.emit(c);
        }
        this.mode = Mode.Hex;
        this.hexN = 0;
        return this.step(c);
      case Mode.Hex:
        if (c === 0x3e) {   // >
          this.mode = Mode.Normal;
          return this.emit(c);
        }
        if (isWhite(c)) return this.emit(c);
        return this.emit(this.hexN++ % 2 === 0 ? 0x32 : 0x30);
      case Mode.Literal:
        if (this.escape) {
          this.escape = false;
          return this.emit(0x20);
        }
        if (c === 0x5c) {   // backslash: it and the next byte are blanked
          this.escape = true;
          return this.emit(0x20);
        }
        if (c === 0x28) {
          this.depth++;
          return this.emit(0x20);
        }
        if (c === 0x29) {
          this.depth--;
          if (this.depth === 0) {
            this.mode = Mode.Normal;
            return this.emit(c);
          }
          return this.emit(0x20);
        }
        return this.emit(0x20);
      case Mode.Tag: {
        this.held.push(c);
        const h = this.held;
        let prefix = false;
        for (let k = 0; k < XMP_TAGS.length; k++) {
          const open = XMP_TAGS[k][0];
          if (h.length > open.length) continue;
          let ok = true;
          for (let i = 0; i < h.length; i++) if (h[i] !== open[i]) { ok = false; break; }
          if (!ok) continue;
          if (h.length === open.length) {
            this.mode = Mode.Capture;
            this.kind = k;
            return;
          }
          prefix = true;
        }
        if (prefix) return;
        h.pop();
        for (const b of h) this.emit(b);
        this.held = [];
        this.mode = Mode.Normal;
        return this.step(c);
      }
      case Mode.Capture: {
        const h = this.held;
        h.push(c);
        const [open, close, head] = XMP_TAGS[this.kind];
        if (h.length >= open.length + close.length && endsWith(h, close)) {
          if (h.length >= head.length + close.length) {
            for (let i = 0; i < h.length; i++) h[i] = i < head.length ? head[i] : i < h.length - close.length ? 0x20 : h[i];
          }
          this.reserve(h.length);
          for (const b of h) this.emit(b);
          this.held = [];
          this.mode = Mode.Normal;
        } else if (h.length > XMP_MAX) {
          this.reserve(h.length);
          for (const b of h) this.emit(b);
          this.held = [];
          this.mode = Mode.Normal;
        }
        return;
      }
      default:
        if (c === 0x2f) {   // /
          this.mode = Mode.Name;
          this.name = [];
          return this.emit(c);
        }
        if (c === 0x3c) {   // <: maybe an XMP packet
          this.mode = Mode.Tag;
          this.held = [c];
          return;
        }
        return this.emit(c);
    }
  }

  private emit(c: number): void {
    if (this.len === this.out.length) this.reserve(1024);
    this.out[this.len++] = c;
  }

  private reserve(n: number): void {
    if (this.len + n <= this.out.length) return;
    const next = new Uint8Array(Math.max(this.len + n, this.out.length * 2));
    next.set(this.out.subarray(0, this.len));
    this.out.fill(0);
    this.out = next;
  }

  private take(): Uint8Array {
    const done = this.out.slice(0, this.len);
    this.out.fill(0, 0, this.len);
    this.len = 0;
    return done;
  }
}

function endsWith(h: number[], tail: Uint8Array): boolean {
  const at = h.length - tail.length;
  for (let i = 0; i < tail.length; i++) if (h[at + i] !== tail[i]) return false;
  return true;
}

// ---- PDF: compressed object and metadata streams -------------------------------------------------

/** Bytes that can be read at any offset (a whole file in memory, or a picked file in native code). */
export type RandomRead = { size: number; read(at: number, length: number): Uint8Array };
/** Bytes to put at an offset, replacing as many: the file keeps its length. */
export type Patch = { at: number; bytes: Uint8Array };
/** Object and XMP streams larger than this (compressed or not) are left as they are. */
export const STREAM_MAX = 16 * 1024 * 1024;

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);
const STREAM = ascii('stream');

/**
 * Finds the streams worth changing and returns same-length patches for them; every offset in the
 * file stays valid.
 * - Flate-compressed object streams (/Type /ObjStm, where recent tools put the document
 *   information dictionary) and XMP streams (/Type /Metadata) whose contents PdfCleaner would
 *   change: the cleaned contents, recompressed, then newlines up to the old end; and the /Length
 *   number, rewritten with spaces after it (where the stream's dictionary has it, or in the object
 *   an indirect /Length points to). PNG predictors (/DecodeParms /Predictor 10–15, one 8-bit colour)
 *   are undone first and the rows written back unfiltered. A stream whose cleaned form compresses
 *   larger than before, with other filters, or with other decode parameters is left alone.
 * - JPEG photos (/Filter /DCTDecode): Exif, XMP, IPTC and comment segments are zeroed where they
 *   are (the colour profile and Adobe segments stay).
 * The native ports (CubeDocClean.swift / .kt) find the same streams; their compressor's bytes
 * differ, the decompressed contents do not.
 */
export function pdfStreamPatches(src: RandomRead): Patch[] {
  const patches: Patch[] = [];
  const pending: Pending[] = [];
  const STEP = 1 << 20;
  for (let start = 0; start < src.size; start += STEP) {
    const win = src.read(start, Math.min(STEP + STREAM.length, src.size - start));
    for (let i = win.indexOf(0x73); i >= 0 && i < Math.min(STEP, win.length); i = win.indexOf(0x73, i + 1)) {
      if (i + STREAM.length > win.length) break;
      let hit = true;
      for (let k = 1; k < STREAM.length; k++) if (win[i + k] !== STREAM[k]) { hit = false; break; }
      if (hit) streamPatch(src, start + i, patches, pending, null);
    }
  }
  if (pending.length > 0) {
    const lengths = indirectLengths(src, new Set(pending.map((x) => x.ref)));
    for (const x of pending) {
      const len = lengths.get(x.ref);
      if (len) streamPatch(src, x.p, patches, null, len);
    }
  }
  return patches;
}

/** A stream whose /Length is "n g R", to look at again once that object is found. */
type Pending = { p: number; ref: string };
/** A stream length and where its digits sit in the file. */
type Length = { value: number; at: number; digits: number };

/**
 * Finds "n g obj <integer> endobj" for each wanted "n g" (the last definition wins, as in an
 * updated PDF). Lengths kept inside object streams are not found: those streams stay as they are.
 */
function indirectLengths(src: RandomRead, wanted: Set<string>): Map<string, Length> {
  const found = new Map<string, Length>();
  const STEP = 1 << 20;
  for (let start = 0; start < src.size; start += STEP) {
    // from 32 bytes before the window, so a number cut by the window's start is read whole
    const from = Math.max(0, start - 32);
    const t = latin1(src.read(from, Math.min(start + STEP + 256, src.size) - from));
    for (const m of t.matchAll(/(?<![0-9])(\d+)\s+(\d+)\s+obj\s*(\d+)\s*endobj/g)) {
      const ref = `${Number(m[1])} ${Number(m[2])}`;
      if (!wanted.has(ref)) continue;
      const at = from + m.index + m[0].slice(0, -6).trimEnd().length - m[3].length;
      found.set(ref, { value: Number(m[3]), at, digits: m[3].length });
    }
  }
  return found;
}

/** Looks at the "stream" keyword at `p`; adds patches if it starts a stream worth cleaning. */
function streamPatch(src: RandomRead, p: number, patches: Patch[], pending: Pending[] | null, given: Length | null): void {
  if (p >= 3 && latin1(src.read(p - 3, 3)) === 'end') return;   // "endstream"
  const eol = src.read(p + STREAM.length, Math.min(2, src.size - p - STREAM.length));
  const dataStart = eol[0] === 0x0d && eol[1] === 0x0a ? p + 8 : eol[0] === 0x0a ? p + 7 : -1;
  if (dataStart < 0) return;
  // the dictionary just before: "<< … >>", nested dictionaries allowed
  const back = Math.min(4096, p);
  const before = src.read(p - back, back);
  let q = before.length - 1;
  while (q >= 0 && isWhite(before[q])) q--;
  if (q < 1 || before[q] !== 0x3e || before[q - 1] !== 0x3e) return;
  let depth = 0;
  let open = -1;
  for (let k = q; k >= 1; k--) {
    if (before[k] === 0x3e && before[k - 1] === 0x3e) { depth++; k--; }
    else if (before[k] === 0x3c && before[k - 1] === 0x3c) {
      depth--;
      k--;
      if (depth === 0) { open = k; break; }
    }
  }
  if (open < 0) return;
  const dict = latin1(before.subarray(open, q + 1));
  if (/\/Filter\s*(\/DCTDecode|\[\s*\/DCTDecode\s*\])/.test(dict)) {
    if (pending) jpegPatches(src, dataStart, patches);
    return;
  }
  if (!/\/Type\s*\/(ObjStm|Metadata)(?![A-Za-z0-9])/.test(dict)) return;
  if (!/\/Filter\s*(\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dict)) return;
  let columns = 0;   // 0: no predictor
  if (/\/DecodeParms/.test(dict)) {
    const parms = /\/DecodeParms\s*(?:\[\s*)?<<([^<>]*)>>/.exec(dict);
    if (!parms) return;
    const num = (key: string, dflt: number) => {
      const m = new RegExp(`/${key}\\s+(\\d+)`).exec(parms[1]);
      return m ? Number(m[1]) : dflt;
    };
    const predictor = num('Predictor', 1);
    if (predictor >= 10 && predictor <= 15 && num('Colors', 1) === 1 && num('BitsPerComponent', 8) === 8) columns = num('Columns', 1);
    else if (predictor !== 1) return;
    if (predictor !== 1 && (columns < 1 || columns > STREAM_MAX)) return;
  }
  let len: Length;
  if (given) len = given;
  else {
    const direct = /\/Length\s+(\d+)(?!\s*\d*\s+R)(?![0-9])/.exec(dict);
    if (!direct) {
      const ref = /\/Length\s+(\d+)\s+(\d+)\s+R/.exec(dict);
      if (ref && pending) pending.push({ p, ref: `${Number(ref[1])} ${Number(ref[2])}` });
      return;
    }
    len = { value: Number(direct[1]), at: p - back + open + direct.index + direct[0].length - direct[1].length, digits: direct[1].length };
  }
  const L = len.value;
  if (L > STREAM_MAX || dataStart + L > src.size) return;
  // the length must end where "endstream" starts (after an optional end of line): a wrong length is
  // never trusted with a patch
  const after = latin1(src.read(dataStart + L, Math.min(11, src.size - dataStart - L)));
  if (!/^(\r\n|\r|\n)?endstream/.test(after)) return;
  const data = src.read(dataStart, L);
  if (data.length < 6 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) return;
  let stored: Uint8Array;
  try {
    stored = unzlibSync(data);
  } catch {
    return;   // not valid zlib: leave it
  }
  const want = ((data[L - 4] << 24) | (data[L - 3] << 16) | (data[L - 2] << 8) | data[L - 1]) >>> 0;
  if (stored.length > STREAM_MAX || adler32(stored) !== want) return;   // checksum as native code checks it
  const plain = columns ? unpredict(stored, columns) : stored;
  if (!plain) return;
  const c = new PdfCleaner();
  const head = c.push(plain);
  const tail = c.finish();
  const clean = new Uint8Array(plain.length);
  clean.set(head);
  clean.set(tail, head.length);
  const unchanged = same(plain, clean);
  stored.fill(0);
  plain.fill(0);
  if (unchanged) return;
  const rows = columns ? predictNone(clean, columns) : clean;
  const z = zlibSync(rows, { level: 9 });
  clean.fill(0);
  rows.fill(0);
  if (z.length > L) return;   // cleaned but no smaller: cannot fit, left as it is
  const bytes = new Uint8Array(L).fill(0x0a);
  bytes.set(z);
  patches.push({ at: dataStart, bytes });
  patches.push({ at: len.at, bytes: ascii(String(z.length).padEnd(len.digits, ' ')) });
}

function adler32(b: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < b.length; i++) {
    s1 = (s1 + b[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

/** PNG predictor rows (one 8-bit colour, `columns` bytes a row) back to plain bytes; null if malformed. */
export function unpredict(data: Uint8Array, columns: number): Uint8Array | null {
  const row = columns + 1;
  if (data.length % row !== 0) return null;
  const rows = data.length / row;
  const out = new Uint8Array(rows * columns);
  for (let r = 0; r < rows; r++) {
    const f = data[r * row];
    for (let x = 0; x < columns; x++) {
      const raw = data[r * row + 1 + x];
      const a = x > 0 ? out[r * columns + x - 1] : 0;
      const b = r > 0 ? out[(r - 1) * columns + x] : 0;
      const c = x > 0 && r > 0 ? out[(r - 1) * columns + x - 1] : 0;
      let v: number;
      if (f === 0) v = raw;
      else if (f === 1) v = raw + a;
      else if (f === 2) v = raw + b;
      else if (f === 3) v = raw + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else return null;
      out[r * columns + x] = v & 0xff;
    }
  }
  return out;
}

/** Plain bytes as PNG predictor rows, each with filter type 0 (none). */
export function predictNone(plain: Uint8Array, columns: number): Uint8Array {
  const rows = plain.length / columns;
  const out = new Uint8Array(rows * (columns + 1));
  for (let r = 0; r < rows; r++) out.set(plain.subarray(r * columns, (r + 1) * columns), r * (columns + 1) + 1);
  return out;
}

/** JPEG segments zeroed inside PDFs: APP1 (Exif, XMP), APP3–APP13 (IPTC…), APP15, comments. */
const blankSegment = (m: number) => m === 0xe1 || (m >= 0xe3 && m <= 0xed) || m === 0xef || m === 0xfe;

/** Zeroes the identifying segments of the JPEG at `at` (up to its image data), in place. */
function jpegPatches(src: RandomRead, at: number, patches: Patch[]): void {
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

/** Cleans a whole PDF in place: compressed streams first, then everything through PdfCleaner. */
function stripPdf(b: Uint8Array): void {
  for (const { at, bytes } of pdfStreamPatches({ size: b.length, read: (at, n) => b.subarray(at, at + n) })) b.set(bytes, at);
  const c = new PdfCleaner();
  const head = c.push(b);
  const tail = c.finish();
  b.set(head);
  b.set(tail, head.length);
  head.fill(0);
  tail.fill(0);
}

// ---- XML: Office, OpenDocument, EPUB, SVG --------------------------------------------------------

/**
 * Which parts of an XML document to empty. Names match a qualified name exactly when they have a
 * prefix ("dc:creator"), every name with that prefix when they end in ":*" ("vt:*"), and the local
 * part of any name otherwise ("author" matches "author" and "p188:author").
 * - elems: these elements keep their tags and lose everything inside them.
 * - attrs: these attributes keep their name and quotes and lose their value. "element@attribute"
 *   limits one to an element; "...^prefix" to values that start with that prefix.
 * - comments: drop XML comments.
 */
export type XmlRules = { elems: string[]; attrs: string[]; comments?: boolean };

function nameMatch(pattern: string, qname: string): boolean {
  if (pattern.endsWith(':*')) return qname.startsWith(pattern.slice(0, -1));
  if (pattern.includes(':')) return qname === pattern;
  const c = qname.indexOf(':');
  return (c < 0 ? qname : qname.slice(c + 1)) === pattern;
}

function attrMatch(pattern: string, elem: string, attr: string, value: Uint8Array): boolean {
  let p = pattern;
  let prefix: string | null = null;
  const caret = p.indexOf('^');
  if (caret >= 0) {
    prefix = p.slice(caret + 1);
    p = p.slice(0, caret);
  }
  const at = p.indexOf('@');
  if (at >= 0) {
    if (!nameMatch(p.slice(0, at), elem)) return false;
    p = p.slice(at + 1);
  }
  return nameMatch(p, attr) && (prefix === null || startsWith(value, prefix));
}

const isXmlSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

/**
 * Empties the elements and attributes `rules` names (and drops comments if asked), leaving every
 * other byte as it was. A small scanner, not a parser: tags, quoted values, comments, CDATA,
 * processing instructions and DOCTYPE are recognised; anything unterminated is copied as it is. The
 * native ports (CubeDocClean.swift / .kt) implement this exact scanner; tests/native checks they
 * give the same bytes.
 */
export function cleanXml(b: Uint8Array, rules: XmlRules): Uint8Array {
  const parts: Uint8Array[] = [];
  const n = b.length;
  let skip = 0;   // > 0 inside an element being emptied: its depth
  const copy = (from: number, to: number) => {
    if (skip === 0 && to > from) parts.push(b.subarray(from, to));
  };
  const until = (seq: string, from: number) => {
    const e = find(b, ascii(seq), from);
    return e < 0 ? n : e + seq.length;
  };
  let i = 0;
  while (i < n) {
    const lt = b.indexOf(0x3c, i);
    if (lt < 0) {
      copy(i, n);
      break;
    }
    copy(i, lt);
    if (startsWithAt(b, lt, '<!--')) {
      const end = until('-->', lt + 4);
      if (!rules.comments) copy(lt, end);
      i = end;
    } else if (startsWithAt(b, lt, '<![CDATA[')) {
      const end = until(']]>', lt + 9);
      copy(lt, end);
      i = end;
    } else if (startsWithAt(b, lt, '<?')) {
      const end = until('?>', lt + 2);
      copy(lt, end);
      i = end;
    } else if (startsWithAt(b, lt, '<!')) {   // DOCTYPE, with an internal subset in [ ]
      let k = lt + 2;
      let depth = 0;
      for (; k < n; k++) {
        if (b[k] === 0x5b) depth++;
        else if (b[k] === 0x5d) depth--;
        else if (b[k] === 0x3e && depth <= 0) break;
      }
      const end = k < n ? k + 1 : n;
      copy(lt, end);
      i = end;
    } else if (b[lt + 1] === 0x2f) {   // end tag
      const gt = b.indexOf(0x3e, lt);
      const end = gt < 0 ? n : gt + 1;
      if (skip > 0) {
        skip--;
        if (skip === 0) parts.push(b.subarray(lt, end));
      } else copy(lt, end);
      i = end;
    } else {   // start tag
      let k = lt + 1;
      while (k < n && !isXmlSpace(b[k]) && b[k] !== 0x2f && b[k] !== 0x3e) k++;
      const qname = latin1(b.subarray(lt + 1, k));
      const drop: number[] = [];   // value spans to empty: start, end, start, end…
      let end = -1;
      while (k < n) {
        const c = b[k];
        if (c === 0x3e) {
          end = k + 1;
          break;
        }
        if (isXmlSpace(c) || c === 0x2f) {
          k++;
          continue;
        }
        const ns = k;
        while (k < n && !isXmlSpace(b[k]) && b[k] !== 0x3d && b[k] !== 0x3e && b[k] !== 0x2f) k++;
        if (k === ns) k++;   // a stray '=': step over it
        const aname = latin1(b.subarray(ns, k));
        while (k < n && isXmlSpace(b[k])) k++;
        if (b[k] !== 0x3d) continue;
        k++;
        while (k < n && isXmlSpace(b[k])) k++;
        const q = b[k];
        if (q !== 0x22 && q !== 0x27) continue;
        const ve = b.indexOf(q, k + 1);
        if (ve < 0) {
          k = n;
          break;
        }
        if (skip === 0 && rules.attrs.some((p) => attrMatch(p, qname, aname, b.subarray(k + 1, ve)))) drop.push(k + 1, ve);
        k = ve + 1;
      }
      if (end < 0) {   // unterminated: the rest as it is
        copy(lt, n);
        break;
      }
      const selfClosing = b[end - 2] === 0x2f;
      if (skip > 0) {
        if (!selfClosing) skip++;
      } else {
        let from = lt;
        for (let d = 0; d < drop.length; d += 2) {
          parts.push(b.subarray(from, drop[d]));
          from = drop[d + 1];
        }
        parts.push(b.subarray(from, end));
        if (!selfClosing && rules.elems.some((p) => nameMatch(p, qname))) skip = 1;
      }
      i = end;
    }
  }
  return concat(parts);
}

/** OOXML attributes naming people: comment and tracked-change authors, co-authors, shared users. */
const OOXML_ATTRS = [
  'w:author', 'w:initials', 'w15:author', 'presenceInfo@providerId', 'presenceInfo@userId',
  'person@displayName', 'person@userId', 'person@providerId', 'cmAuthor@name', 'cmAuthor@initials',
  'author@name', 'author@initials', 'author@userId', 'author@providerId', 'header@userName',
  'fileSharing@userName', 'userInfo@name', 'absPath@url',
];
const CORE_TAGS = ['dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'cp:keywords', 'dc:description', 'cp:category'];
const ODF_META = [
  'dc:creator', 'meta:initial-creator', 'dc:title', 'dc:subject', 'dc:description', 'meta:keyword',
  'meta:user-defined', 'meta:printed-by', 'meta:generator',
];
export const SVG_RULES: XmlRules = {
  elems: ['metadata', 'i:pgf'],
  attrs: ['sodipodi:docname', 'sodipodi:docbase', 'sodipodi:version', 'inkscape:export-filename', 'inkscape:version'],
  comments: true,
};

/** A zip document's family: Office Open XML, OpenDocument or EPUB. */
export type ZipFormat = 'ooxml' | 'odf' | 'epub';

/** Which family a zip belongs to, from its part names and its "mimetype" part; null: none. */
export function zipFormat(names: string[], mimetype: Uint8Array | null): ZipFormat | null {
  if (names.includes('[Content_Types].xml')) return 'ooxml';
  if (mimetype && startsWith(mimetype, 'application/vnd.oasis.opendocument.')) return 'odf';
  if (mimetype && startsWith(mimetype, 'application/epub+zip')) return 'epub';
  return null;
}

/** The rules for one part of a zip document, or null to copy it as it is. */
export function xmlRules(format: ZipFormat, name: string): XmlRules | null {
  if (format === 'ooxml') {
    if (name === 'docProps/core.xml') return { elems: CORE_TAGS, attrs: [] };
    if (name === 'docProps/app.xml') return { elems: ['Company', 'Manager'], attrs: [] };
    if (name === 'docProps/custom.xml') return { elems: ['vt:*'], attrs: [] };
    if (name.endsWith('.rels')) return { elems: [], attrs: ['Relationship@Target^file:'] };
    if (name.endsWith('.xml') && name !== '[Content_Types].xml') return { elems: ['author'], attrs: OOXML_ATTRS };
    return null;
  }
  if (format === 'odf') {
    if (name === 'meta.xml') return { elems: ODF_META, attrs: ['template@href', 'template@title'] };
    if (name === 'content.xml' || name === 'styles.xml') return { elems: ['dc:creator', 'meta:creator-initials'], attrs: [] };
    return null;
  }
  return name.endsWith('.opf') ? { elems: ['dc:creator', 'dc:contributor', 'dc:publisher'], attrs: [] } : null;
}

/** Photos inside zip documents: cleaned like photos added on their own (lib/strip.ts). */
export const ZIP_IMAGE = /\.(jpe?g|png|heic|heif|webp|tiff?|gif)$/i;
/** Parts larger than this (uncompressed) are copied as they are. */
export const PART_MAX = 32 * 1024 * 1024;

/** One part of a zip document, cleaned; `data` itself when nothing is to change. */
export function cleanZipPart(format: ZipFormat, name: string, data: Uint8Array): Uint8Array {
  if (data.length > PART_MAX) return data;
  if (ZIP_IMAGE.test(name)) return stripImageMetadata(data.slice());
  const rules = xmlRules(format, name);
  return rules ? cleanXml(data, rules) : data;
}

function stripZipDocument(b: Uint8Array): Uint8Array | null {
  const files = unzipSync(b);
  const names = Object.keys(files);
  const format = zipFormat(names, files.mimetype ?? null);
  if (!format) return null;   // a zip, but not a document
  const out: Zippable = {};
  let changed = false;
  for (const name of names) {
    const data = files[name];
    const next = cleanZipPart(format, name, data);
    if (!same(next, data)) changed = true;
    out[name] = next;
  }
  if (!changed) return null;
  // [Content_Types].xml first, as Office writes it; "mimetype" first and stored, as OpenDocument and
  // EPUB require; everything else in its original order.
  const first = format === 'ooxml' ? '[Content_Types].xml' : 'mimetype';
  const ordered: Zippable = {};
  if (out[first]) ordered[first] = first === 'mimetype' ? [out[first] as Uint8Array, { level: 0 }] : out[first];
  for (const name of names) if (name !== first) ordered[name] = out[name];
  return zipSync(ordered, { level: 6 });
}

/** SVG without comments, <metadata> and editor attributes that hold file paths. */
export function stripSvg(bytes: Uint8Array): Uint8Array {
  return cleanXml(bytes, SVG_RULES);
}

// ---- RTF ---------------------------------------------------------------------------------------

/** Groups dropped whole: \info fields naming people, revision and comment authors, the generator. */
const RTF_DROP = new Set([
  'author', 'operator', 'title', 'subject', 'keywords', 'doccomm', 'comment', 'company', 'manager',
  'category', 'hlinkbase', 'userprops', 'revtbl', 'atnauthor', 'atnid', 'generator',
]);
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

const enum Rtf { Normal, Group, Ctrl, Skip, Bin }

/**
 * Drops the RTF groups in RTF_DROP ({\author …}, {\*\company …}, …) as the file streams through;
 * dates and everything else pass unchanged. Binary data (\binN) is passed over unread. The native
 * ports (CubeDocClean.swift / .kt) implement this exact machine; tests/native checks they give the
 * same bytes.
 */
export class RtfCleaner {
  private mode = Rtf.Normal;
  private held: number[] = [];
  private depth = 0;
  private escape = false;
  private bin = 0;
  private out: number[] = [];

  push(input: Uint8Array): Uint8Array {
    for (let i = 0; i < input.length; i++) {
      if (this.mode === Rtf.Bin) {   // binary data: passed over in one go
        const k = Math.min(this.bin, input.length - i);
        for (let j = 0; j < k; j++) this.out.push(input[i + j]);
        this.bin -= k;
        i += k - 1;
        if (this.bin === 0) this.mode = Rtf.Normal;
        continue;
      }
      this.step(input[i]);
    }
    return this.take();
  }

  finish(): Uint8Array {
    if (this.mode === Rtf.Group || this.mode === Rtf.Ctrl) for (const c of this.held) this.out.push(c);
    this.held = [];
    this.mode = Rtf.Normal;
    return this.take();
  }

  private step(c: number): void {
    switch (this.mode) {
      case Rtf.Skip:
        if (this.escape) this.escape = false;
        else if (c === 0x5c) this.escape = true;
        else if (c === 0x7b) this.depth++;
        else if (c === 0x7d && --this.depth === 0) this.mode = Rtf.Normal;
        return;
      case Rtf.Group: {   // after "{": a destination worth dropping?
        const h = this.held;
        h.push(c);
        // h[0] = '{'; then '\' word, or '\' '*' '\' word
        const star = h.length >= 3 && h[2] === 0x2a;
        const wordAt = star ? 4 : 2;
        if (h.length === 2) {
          if (c !== 0x5c) return this.release();
          return;
        }
        if (h.length === 3) {
          if (c === 0x2a || isLetter(c)) return;
          return this.flush();   // an escaped symbol such as \{ or \'
        }
        if (star && h.length === 4) {
          if (c !== 0x5c) return this.release();
          return;
        }
        if (isLetter(c) && h.length - wordAt <= 32) return;
        const word = String.fromCharCode(...h.slice(wordAt, h.length - 1));
        if (word.length > 0 && RTF_DROP.has(word)) {
          this.held = [];
          this.mode = Rtf.Skip;
          this.depth = 1;
          this.escape = false;
          return this.step(c);
        }
        // kept: "{" (and "\*") out, the control word goes on as one outside a group start, so
        // {\binN is passed over like \binN
        for (const x of h.slice(0, wordAt - 1)) this.out.push(x);
        this.held = h.slice(wordAt - 1, h.length - 1);
        this.mode = Rtf.Ctrl;
        return this.step(c);
      }
      case Rtf.Ctrl: {   // after "\" outside a group start: only \binN matters
        const h = this.held;
        h.push(c);
        if (h.length === 2) {
          if (!isLetter(c)) return this.flush();
          return;
        }
        const prev = h[h.length - 2];
        const more = isLetter(c) ? isLetter(prev) : isDigit(c) ? isLetter(prev) || isDigit(prev) || prev === 0x2d : c === 0x2d && isLetter(prev);
        if (more && h.length <= 48) return;
        const m = /^\\bin(\d+)$/.exec(String.fromCharCode(...h.slice(0, -1)));
        if (m && Number(m[1]) > 0) {
          for (const x of h.slice(0, -1)) this.out.push(x);
          this.held = [];
          this.bin = Number(m[1]);
          this.mode = Rtf.Bin;
          this.out.push(c);
          // a space ends the control word; any other byte is already the first byte of the data
          if (c !== 0x20 && --this.bin === 0) this.mode = Rtf.Normal;
          return;
        }
        return this.release();
      }
      default:
        if (c === 0x7b) {
          this.mode = Rtf.Group;
          this.held = [c];
        } else if (c === 0x5c) {
          this.mode = Rtf.Ctrl;
          this.held = [c];
        } else this.out.push(c);
    }
  }

  /** Emits all held bytes but the last, which is looked at again in normal mode. */
  private release(): void {
    const h = this.held;
    const last = h.pop()!;
    for (const x of h) this.out.push(x);
    this.held = [];
    this.mode = Rtf.Normal;
    this.step(last);
  }

  /** Emits every held byte (an escaped symbol is complete). */
  private flush(): void {
    for (const x of this.held) this.out.push(x);
    this.held = [];
    this.mode = Rtf.Normal;
  }

  private take(): Uint8Array {
    const done = Uint8Array.from(this.out);
    this.out.fill(0);
    this.out = [];
    return done;
  }
}

// ---- bytes -------------------------------------------------------------------------------------

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function startsWith(b: Uint8Array, s: string): boolean {
  return startsWithAt(b, 0, s);
}

function startsWithAt(b: Uint8Array, at: number, s: string): boolean {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function find(b: Uint8Array, sig: Uint8Array, from: number): number {
  for (let i = b.indexOf(sig[0], from); i >= 0 && i + sig.length <= b.length; i = b.indexOf(sig[0], i + 1)) {
    let ok = true;
    for (let k = 1; k < sig.length; k++) {
      if (b[i + k] !== sig[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
