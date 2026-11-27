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
import { jpegPatches, stripMediaMetadata, zeroPatches } from './mediameta';

export const DOC_LIMIT = 50 * 1024 * 1024;

const OFFICE = /\.(docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp|odg|epub|doc|dot|xls|xlt|ppt|pot|pps|vsd|pub)$/i;
const OFFICE_MIME = /officedocument|ms-word\.document\.macro|ms-excel\.sheet\.macro|ms-powerpoint\.presentation\.macro|opendocument|epub\+zip|^application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.visio|x-mspublisher)$/i;
const MEDIA = /\.(mp4|m4v|mov|3gp|3g2|m4a|m4b|aac|mp3|flac|wav|aiff?|aifc|ogg|oga|ogv|opus|spx|mkv|mka|mk3d|webm|avi)$/i;

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
  if (isCfb(bytes)) {   // Office 97–2003, or an encrypted Office file
    for (const { at, bytes: p } of cfbPatches({ size: bytes.length, read: (at, n) => bytes.subarray(at, at + n) })) bytes.set(p, at);
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
 * - Compressed object streams (/Type /ObjStm, where recent tools put the document information
 *   dictionary) and XMP streams (/Type /Metadata) whose contents PdfCleaner would change: the
 *   cleaned contents, encoded again with the same filters (Flate, LZW, ASCII85, ASCIIHex and
 *   run-length, alone or chained), then newlines up to the old end; and the /Length number,
 *   rewritten with spaces after it (where the stream's dictionary has it, or in the object an
 *   indirect /Length points to; a length kept inside an object stream stays, the newlines then
 *   inside the stream). PNG predictors (/DecodeParms /Predictor 10–15, one 8-bit colour, on the last
 *   filter) are undone first and the rows written back unfiltered. The cleaned contents are
 *   shortened first (see compact: blanked strings emptied, white space squeezed); a stream that
 *   still does not fit, with other filters, or with other decode parameters is left alone.
 * - JPEG photos (/Filter /DCTDecode): Exif, XMP, IPTC and comment segments are zeroed where they
 *   are (the colour profile and Adobe segments stay).
 * The native ports (CubeDocClean.swift / .kt) find the same streams; their compressor's bytes
 * differ, the decompressed contents do not.
 */
export function pdfStreamPatches(src: RandomRead): Patch[] {
  const patches: Patch[] = [];
  const pending: Pending[] = [];
  const ints = new Map<string, number>();
  const STEP = 1 << 20;
  for (let start = 0; start < src.size; start += STEP) {
    const win = src.read(start, Math.min(STEP + STREAM.length, src.size - start));
    for (let i = win.indexOf(0x73); i >= 0 && i < Math.min(STEP, win.length); i = win.indexOf(0x73, i + 1)) {
      if (i + STREAM.length > win.length) break;
      let hit = true;
      for (let k = 1; k < STREAM.length; k++) if (win[i + k] !== STREAM[k]) { hit = false; break; }
      if (hit) streamPatch(src, start + i, patches, pending, null, ints);
    }
  }
  if (pending.length > 0) {
    const lengths = indirectLengths(src, new Set(pending.map((x) => x.ref)));
    for (const x of pending) {
      const value = ints.get(x.ref);
      const len = lengths.get(x.ref) ?? (value !== undefined ? { value, at: -1, digits: 0 } : undefined);
      if (len) streamPatch(src, x.p, patches, null, len, null);
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
 * updated PDF). Lengths kept inside object streams come from objStmIntegers instead.
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
function streamPatch(src: RandomRead, p: number, patches: Patch[], pending: Pending[] | null, given: Length | null, ints: Map<string, number> | null): void {
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
  const chain = filterChain(dict);
  if (!chain) return;
  const parms = decodeParms(dict, chain);
  if (!parms) return;
  const { columns, early } = parms;
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
  const stored = decodeChain(src.read(dataStart, L), chain, early);
  if (!stored) return;
  const plain = columns ? unpredict(stored, columns) : stored;
  if (!plain) return;
  if (ints && /\/Type\s*\/ObjStm/.test(dict)) objStmIntegers(dict, plain, ints);
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
  // The blanked strings and runs of white space are shortened first (an object stream's offsets
  // rewritten to match), so the result fits even where Cube's compressor does worse than the one that
  // wrote the file, and comes out the same whichever compressor runs (JavaScript's or the platform's).
  const short = compact(clean, dict, columns);
  const body = short ?? clean;
  const rows = columns ? predictNone(body, columns) : body;
  const z = encodeChain(rows, chain, early);
  if (rows !== body) rows.fill(0);
  short?.fill(0);
  clean.fill(0);
  if (z.length > L) return;   // cannot fit: left as it is
  const bytes = new Uint8Array(L).fill(0x0a);
  bytes.set(z);
  patches.push({ at: dataStart, bytes });
  // a length kept inside an object stream stays: the newlines after the data are then inside the
  // stream, where every decoder stops at the end of its data
  if (len.at >= 0) patches.push({ at: len.at, bytes: ascii(String(z.length).padEnd(len.digits, ' ')) });
}

/**
 * The stream's decode parameters, one dictionary (or null) per filter: a PNG predictor (10–15, one
 * 8-bit colour) is allowed on the last filter only, when it is Flate or LZW; /EarlyChange 0 or 1 on
 * LZW (the same for every LZW filter). Null for anything else.
 */
function decodeParms(dict: string, chain: Filter[]): { columns: number; early: number } | null {
  if (!/\/DecodeParms/.test(dict)) return { columns: 0, early: 1 };
  let entries: (string | null)[];
  const one = /\/DecodeParms\s*<<([^<>]*)>>/.exec(dict);
  const list = /\/DecodeParms\s*\[((?:\s*(?:null|<<[^<>]*>>))*)\s*\]/.exec(dict);
  if (one) {
    if (chain.length !== 1) return null;
    entries = [one[1]];
  } else if (list) {
    entries = [...list[1].matchAll(/null|<<([^<>]*)>>/g)].map((m) => (m[0] === 'null' ? null : m[1]));
    if (entries.length !== chain.length) return null;
  } else return null;
  let columns = 0;
  let early = -1;
  for (let i = 0; i < chain.length; i++) {
    const e = entries[i];
    if (e === null || e.trim() === '') continue;
    if (chain[i] !== 'FlateDecode' && chain[i] !== 'LZWDecode') return null;
    const num = (key: string, dflt: number) => {
      const m = new RegExp(`/${key}\\s+(\\d+)`).exec(e);
      return m ? Number(m[1]) : dflt;
    };
    if (chain[i] === 'LZWDecode') {
      const ec = num('EarlyChange', 1);
      if (ec > 1 || (early >= 0 && ec !== early)) return null;
      early = ec;
    }
    const predictor = num('Predictor', 1);
    if (predictor === 1) continue;
    if (i !== chain.length - 1 || predictor < 10 || predictor > 15 || num('Colors', 1) !== 1 || num('BitsPerComponent', 8) !== 8) return null;
    columns = num('Columns', 1);
    if (columns < 1 || columns > STREAM_MAX) return null;
  }
  return { columns, early: early < 0 ? 1 : early };
}

/**
 * A shorter form of cleaned stream contents, or null (no shorter). XMP: runs of white space become one space.
 * Object streams: in each object, a blanked string (only spaces, or hex for spaces) becomes empty
 * and runs of white space outside strings become one space; the offsets at the start are rewritten
 * (padded with spaces to the same /First). Padded with spaces to whole predictor rows.
 */
export function compact(clean: Uint8Array, dict: string, columns: number): Uint8Array | null {
  let out: Uint8Array;
  if (/\/Type\s*\/Metadata/.test(dict)) out = squeeze(clean, false);
  else {
    const n = /\/N\s+(\d+)/.exec(dict);
    const first = /\/First\s+(\d+)/.exec(dict);
    if (!n || !first) return null;
    const F = Number(first[1]);
    if (F > clean.length) return null;
    const nums = latin1(clean.subarray(0, F)).trim().split(/\s+/).map(Number);
    const count = Number(n[1]);
    if (nums.length < 2 * count || nums.some((x) => !Number.isInteger(x) || x < 0)) return null;
    const parts: Uint8Array[] = [];
    let header = '';
    let at = 0;
    for (let i = 0; i < count; i++) {
      const from = F + nums[2 * i + 1];
      const to = i + 1 < count ? F + nums[2 * i + 3] : clean.length;
      if (from > to || to > clean.length) return null;
      const obj = squeeze(clean.subarray(from, to), true);
      header += `${nums[2 * i]} ${at} `;
      parts.push(obj);
      at += obj.length;
    }
    if (header.length > F) return null;
    out = concat([ascii(header.padEnd(F, ' ')), ...parts]);
  }
  if (columns && out.length % columns) out = concat([out, new Uint8Array(columns - (out.length % columns)).fill(0x20)]);
  return out.length < clean.length ? out : null;
}

/**
 * Runs of white space become one space; with `pdf`, outside strings only (comments are copied as
 * they are), and strings that are only spaces, or hex strings of only "20", become empty.
 */
function squeeze(b: Uint8Array, pdf: boolean): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  let space = false;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (isWhite(c) && c !== 0x00) {
      if (!space) out[n++] = 0x20;
      space = true;
      continue;
    }
    space = false;
    if (pdf && c === 0x25) {   // %: a comment, to the end of the line
      while (i < b.length && b[i] !== 0x0a && b[i] !== 0x0d) out[n++] = b[i++];
      i--;
      continue;
    }
    if (pdf && c === 0x28) {   // (: a literal string
      let depth = 1;
      let j = i + 1;
      let blank = true;
      for (; j < b.length && depth > 0; j++) {
        if (b[j] === 0x5c) { blank = false; j++; continue; }
        if (b[j] === 0x28) depth++;
        else if (b[j] === 0x29) depth--;
        if (depth > 0 && b[j] !== 0x20) blank = false;
      }
      if (blank && depth === 0) {
        out[n++] = 0x28;
        out[n++] = 0x29;
      } else {
        out.set(b.subarray(i, j), n);
        n += j - i;
      }
      i = j - 1;
      continue;
    }
    if (pdf && c === 0x3c && b[i + 1] !== 0x3c) {   // <: a hex string (<< is a dictionary)
      const j = b.indexOf(0x3e, i + 1);
      if (j < 0) {
        out.set(b.subarray(i), n);
        n += b.length - i;
        break;
      }
      const hex = latin1(b.subarray(i + 1, j)).replace(/\s+/g, '');
      if (hex.length > 0 && /^(20)+$/.test(hex)) {
        out[n++] = 0x3c;
        out[n++] = 0x3e;
      } else {
        out.set(b.subarray(i, j + 1), n);
        n += j + 1 - i;
      }
      i = j;
      continue;
    }
    if (pdf && c === 0x3c) {   // <<
      out[n++] = 0x3c;
      out[n++] = 0x3c;
      i++;
      continue;
    }
    out[n++] = c;
  }
  return out.slice(0, n);
}

/** "n 0" → value for each object of an object stream that is just an integer (a stream length). */
function objStmIntegers(dict: string, plain: Uint8Array, ints: Map<string, number>): void {
  const n = /\/N\s+(\d+)/.exec(dict);
  const first = /\/First\s+(\d+)/.exec(dict);
  if (!n || !first || Number(first[1]) > plain.length || Number(n[1]) > 1_000_000) return;
  const nums = latin1(plain.subarray(0, Number(first[1]))).trim().split(/\s+/).map(Number);
  const count = Math.min(Number(n[1]), Math.floor(nums.length / 2));
  for (let i = 0; i < count; i++) {
    const from = Number(first[1]) + nums[2 * i + 1];
    const to = i + 1 < count ? Number(first[1]) + nums[2 * i + 3] : plain.length;
    if (!(from >= 0 && to <= plain.length && from <= to) || to - from > 32) continue;
    const m = /^\s*(\d+)\s*$/.exec(latin1(plain.subarray(from, to)));
    if (m) ints.set(`${nums[2 * i]} 0`, Number(m[1]));
  }
}

// ---- PDF stream filters ------------------------------------------------------------------------

export type Filter = 'FlateDecode' | 'LZWDecode' | 'ASCII85Decode' | 'ASCIIHexDecode' | 'RunLengthDecode';
const FILTERS = new Set<string>(['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode']);

/** The stream's filters, in decoding order; null without one, or with one Cube cannot redo. */
function filterChain(dict: string): Filter[] | null {
  const m = /\/Filter\s*(?:\/([A-Za-z0-9]+)|\[([^\]]*)\])/.exec(dict);
  if (!m) return null;
  const names = m[1] ? [m[1]] : (m[2].match(/\/[A-Za-z0-9]+/g) ?? []).map((x) => x.slice(1));
  if (names.length === 0 || names.length > 4 || !names.every((x) => FILTERS.has(x))) return null;
  return names as Filter[];
}

/** A stream's data through its filters; null if any of them finds it malformed. */
export function decodeChain(data: Uint8Array, chain: Filter[], early = 1): Uint8Array | null {
  let b: Uint8Array | null = data;
  for (const f of chain) {
    try {
      b = f === 'FlateDecode' ? flateDecode(b) : f === 'LZWDecode' ? lzwDecode(b, early) : f === 'ASCII85Decode' ? a85Decode(b)
        : f === 'ASCIIHexDecode' ? hexDecode(b) : rlDecode(b);
    } catch {
      return null;
    }
    if (!b || b.length > STREAM_MAX) return null;
  }
  return b;
}

/** Plain bytes encoded for the same filters (the last filter first). */
export function encodeChain(plain: Uint8Array, chain: Filter[], early = 1): Uint8Array {
  let b = plain;
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    b = f === 'FlateDecode' ? zlibSync(b, { level: 9 }) : f === 'LZWDecode' ? lzwEncode(b, early) : f === 'ASCII85Decode' ? a85Encode(b)
      : f === 'ASCIIHexDecode' ? hexEncode(b) : rlEncode(b);
  }
  return b;
}

function flateDecode(data: Uint8Array): Uint8Array | null {
  const L = data.length;
  if (L < 6 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) return null;
  const out = unzlibSync(data);
  const want = ((data[L - 4] << 24) | (data[L - 3] << 16) | (data[L - 2] << 8) | data[L - 1]) >>> 0;
  if (out.length > STREAM_MAX || adler32(out) !== want) return null;   // checksum as native code checks it
  return out;
}

/**
 * Growable output. Decoders stop past STREAM_MAX (they throw, and decodeChain gives null); encoders
 * have no limit (`max` Infinity): an output larger than the stream simply does not fit.
 */
class Out {
  b: Uint8Array;
  n = 0;
  constructor(size: number, private max = STREAM_MAX) {
    this.b = new Uint8Array(Math.max(64, size));
  }
  room(k: number): void {
    if (this.n + k <= this.b.length) return;
    if (this.n + k > this.max) throw new RangeError('too large');
    const next = new Uint8Array(Math.max(this.b.length * 2, this.n + k));
    next.set(this.b.subarray(0, this.n));
    this.b.fill(0);
    this.b = next;
  }
  push(x: number): void {
    this.room(1);
    this.b[this.n++] = x;
  }
  done(): Uint8Array {
    return this.b.subarray(0, this.n);
  }
}

const hexValue = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);

function hexDecode(b: Uint8Array): Uint8Array | null {
  const out = new Out(b.length / 2 + 1);
  let hi = -1;
  for (const c of b) {
    if (c === 0x3e) break;   // ">": the end
    if (isWhite(c)) continue;
    const v = hexValue(c);
    if (v < 0) return null;
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return out.done();
}

function hexEncode(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length * 2 + 1);
  const d = '0123456789ABCDEF';
  for (let i = 0; i < b.length; i++) {
    out[2 * i] = d.charCodeAt(b[i] >> 4);
    out[2 * i + 1] = d.charCodeAt(b[i] & 15);
  }
  out[b.length * 2] = 0x3e;
  return out;
}

function a85Decode(b: Uint8Array): Uint8Array | null {
  const out = new Out(b.length);
  let i = 0;
  while (i < b.length && isWhite(b[i])) i++;
  if (b[i] === 0x3c && b[i + 1] === 0x7e) i += 2;   // "<~"
  const group: number[] = [];
  for (; i < b.length; i++) {
    const c = b[i];
    if (isWhite(c)) continue;
    if (c === 0x7e) break;   // "~>": the end
    if (c === 0x7a && group.length === 0) {   // "z": four zeros
      for (let k = 0; k < 4; k++) out.push(0);
      continue;
    }
    if (c < 0x21 || c > 0x75) return null;
    group.push(c - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (const x of group) v = v * 85 + x;
      if (v > 0xffffffff) return null;
      out.push(v >>> 24);
      out.push((v >>> 16) & 0xff);
      out.push((v >>> 8) & 0xff);
      out.push(v & 0xff);
      group.length = 0;
    }
  }
  if (group.length === 1) return null;
  if (group.length > 1) {
    const k = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const x of group) v = v * 85 + x;
    if (v > 0xffffffff) return null;
    for (let j = 0; j < k - 1; j++) out.push((v >>> (24 - 8 * j)) & 0xff);
  }
  return out.done();
}

function a85Encode(b: Uint8Array): Uint8Array {
  const out = new Out(Math.ceil(b.length / 4) * 5 + 2, Infinity);
  for (let i = 0; i < b.length; i += 4) {
    const n = Math.min(4, b.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? b[i + k] : 0);
    if (n === 4 && v === 0) {
      out.push(0x7a);
      continue;
    }
    const c = new Array<number>(5);
    for (let k = 4; k >= 0; k--) {
      c[k] = (v % 85) + 0x21;
      v = Math.floor(v / 85);
    }
    for (let k = 0; k < n + 1; k++) out.push(c[k]);
  }
  out.push(0x7e);
  out.push(0x3e);
  return out.done();
}

function rlDecode(b: Uint8Array): Uint8Array | null {
  const out = new Out(b.length * 2);
  let i = 0;
  while (i < b.length) {
    const n = b[i++];
    if (n === 128) break;
    if (n < 128) {
      if (i + n + 1 > b.length) return null;
      out.room(n + 1);
      out.b.set(b.subarray(i, i + n + 1), out.n);
      out.n += n + 1;
      i += n + 1;
    } else {
      if (i >= b.length) return null;
      out.room(257 - n);
      out.b.fill(b[i], out.n, out.n + 257 - n);
      out.n += 257 - n;
      i++;
    }
  }
  return out.done();
}

function rlEncode(b: Uint8Array): Uint8Array {
  const out = new Out(b.length + b.length / 64 + 2, Infinity);
  let i = 0;
  while (i < b.length) {
    let r = 1;
    while (i + r < b.length && r < 128 && b[i + r] === b[i]) r++;
    if (r >= 2) {
      out.push(257 - r);
      out.push(b[i]);
      i += r;
      continue;
    }
    let j = i + 1;
    while (j < b.length && j - i < 128 && !(j + 1 < b.length && b[j] === b[j + 1])) j++;
    out.push(j - i - 1);
    for (let k = i; k < j; k++) out.push(b[k]);
    i = j;
  }
  out.push(128);
  return out.done();
}

/** LZW as PDF uses it: 9- to 12-bit codes, 256 clears the table, 257 ends; `early` is /EarlyChange. */
function lzwDecode(b: Uint8Array, early: number): Uint8Array | null {
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Int32Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
    first[i] = i;
  }
  const out = new Out(b.length * 3);
  const emit = (code: number) => {
    const n = length[code];
    out.room(n);
    for (let k = out.n + n - 1, c = code; k >= out.n; k--, c = prefix[c]) out.b[k] = suffix[c];
    out.n += n;
  };
  let width = 9;
  let next = 258;
  let prev = -1;
  const bits = b.length * 8;
  for (let bit = 0; bit + width <= bits; ) {
    let code = 0;
    for (let k = 0; k < width; k++, bit++) code = (code << 1) | ((b[bit >> 3] >> (7 - (bit & 7))) & 1);
    if (code === 256) {
      width = 9;
      next = 258;
      prev = -1;
      continue;
    }
    if (code === 257) break;
    if (prev < 0) {
      if (code > 255) return null;
      emit(code);
      prev = code;
      continue;
    }
    if (code > next || (code === next && next >= 4096)) return null;
    const head = code < next ? first[code] : first[prev];
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = head;
      length[next] = length[prev] + 1;
      first[next] = first[prev];
      next++;
    }
    emit(code);
    prev = code;
    if (next + early >= 1 << width && width < 12) width++;
  }
  return out.done();
}

function lzwEncode(b: Uint8Array, early: number): Uint8Array {
  const out = new Out(b.length + 16, Infinity);
  let acc = 0;
  let accBits = 0;
  let width = 9;
  let decoderNext = 258;   // the decoder's table size, which decides the code width
  let fresh = true;        // the next code is the first after a clear (the decoder adds nothing)
  const put = (code: number) => {
    acc = (acc << width) | code;
    accBits += width;
    while (accBits >= 8) {
      out.push((acc >>> (accBits - 8)) & 0xff);
      accBits -= 8;
    }
    acc &= (1 << accBits) - 1;
    if (code === 256) {
      width = 9;
      decoderNext = 258;
      fresh = true;
      return;
    }
    if (code === 257) return;
    if (!fresh && decoderNext < 4096) decoderNext++;
    fresh = false;
    if (decoderNext + early >= 1 << width && width < 12) width++;
  };
  put(256);
  if (b.length > 0) {
    const table = new Map<number, number>();
    let next = 258;
    let w = b[0];
    for (let i = 1; i < b.length; i++) {
      const key = w * 256 + b[i];
      const got = table.get(key);
      if (got !== undefined) {
        w = got;
        continue;
      }
      put(w);
      if (next < 4096) table.set(key, next++);
      if (next === 4096) {
        put(256);
        table.clear();
        next = 258;
      }
      w = b[i];
    }
    put(w);
  }
  put(257);
  if (accBits > 0) out.push((acc << (8 - accBits)) & 0xff);
  return out.done();
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
  const c = new XmlCleaner(rules);
  const head = c.push(b);
  const tail = c.finish();
  return tail.length === 0 ? head : concat([head, tail]);
}

/** Markup longer than this that has not ended yet is copied as it is (as at the end of the input). */
export const XML_CARRY_MAX = 16 * 1024 * 1024;

/**
 * cleanXml a piece at a time, for parts too large to hold whole: each push returns what is final;
 * markup cut by the end of a piece waits for the next one (up to XML_CARRY_MAX). Pieces of any size
 * give the same bytes as cleanXml on the whole.
 */
export class XmlCleaner {
  private carry = new Uint8Array(0);
  private skip = 0;   // > 0 inside an element being emptied: its depth
  constructor(private rules: XmlRules) {}

  push(input: Uint8Array): Uint8Array {
    const b = this.carry.length ? concat([this.carry, input]) : input;
    const { out, rest } = this.scan(b, false);
    this.carry = rest >= b.length ? new Uint8Array(0) : b.slice(rest);
    if (this.carry.length > XML_CARRY_MAX) {   // markup that never ends: as at the end of the input
      const more = this.scan(this.carry, true).out;
      this.carry = new Uint8Array(0);
      return concat([out, more]);
    }
    return out;
  }

  finish(): Uint8Array {
    const b = this.carry;
    this.carry = new Uint8Array(0);
    return b.length ? this.scan(b, true).out : b;
  }

  /** Scans b; unless `final`, stops at markup that does not end within b (rest: where it starts). */
  private scan(b: Uint8Array, final: boolean): { out: Uint8Array; rest: number } {
    const rules = this.rules;
    const parts: Uint8Array[] = [];
    const n = b.length;
    const copy = (from: number, to: number) => {
      if (this.skip === 0 && to > from) parts.push(b.subarray(from, to));
    };
    /** The end of `seq` from `from`, or -1 if b ends first. */
    const until = (seq: string, from: number) => {
      const e = find(b, ascii(seq), from);
      return e < 0 ? -1 : e + seq.length;
    };
    const done = (rest: number) => ({ out: concat(parts), rest });
    let i = 0;
    while (i < n) {
      const lt = b.indexOf(0x3c, i);
      if (lt < 0) {
        copy(i, n);
        break;
      }
      copy(i, lt);
      if (!final && lt + 9 > n) return done(lt);   // too little to tell which markup this is
      if (startsWithAt(b, lt, '<!--')) {
        const e = until('-->', lt + 4);
        if (e < 0 && !final) return done(lt);
        const end = e < 0 ? n : e;
        if (!rules.comments) copy(lt, end);
        i = end;
      } else if (startsWithAt(b, lt, '<![CDATA[')) {
        const e = until(']]>', lt + 9);
        if (e < 0 && !final) return done(lt);
        const end = e < 0 ? n : e;
        copy(lt, end);
        i = end;
      } else if (startsWithAt(b, lt, '<?')) {
        const e = until('?>', lt + 2);
        if (e < 0 && !final) return done(lt);
        const end = e < 0 ? n : e;
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
        if (k >= n && !final) return done(lt);
        const end = k < n ? k + 1 : n;
        copy(lt, end);
        i = end;
      } else if (b[lt + 1] === 0x2f) {   // end tag
        const gt = b.indexOf(0x3e, lt);
        if (gt < 0 && !final) return done(lt);
        const end = gt < 0 ? n : gt + 1;
        if (this.skip > 0) {
          this.skip--;
          if (this.skip === 0) parts.push(b.subarray(lt, end));
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
          if (this.skip === 0 && rules.attrs.some((p) => attrMatch(p, qname, aname, b.subarray(k + 1, ve)))) drop.push(k + 1, ve);
          k = ve + 1;
        }
        if (end < 0) {   // unterminated: the rest as it is
          if (!final) return done(lt);
          copy(lt, n);
          break;
        }
        const selfClosing = b[end - 2] === 0x2f;
        if (this.skip > 0) {
          if (!selfClosing) this.skip++;
        } else {
          let from = lt;
          for (let d = 0; d < drop.length; d += 2) {
            parts.push(b.subarray(from, drop[d]));
            from = drop[d + 1];
          }
          parts.push(b.subarray(from, end));
          if (!selfClosing && rules.elems.some((p) => nameMatch(p, qname))) this.skip = 1;
        }
        i = end;
      }
    }
    return done(n);
  }
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
/**
 * Photos larger than this (uncompressed) inside zip documents are copied as they are; XML parts of
 * any size are cleaned (native code streams the ones larger than this through XmlCleaner).
 */
export const PART_MAX = 32 * 1024 * 1024;

/** One part of a zip document, cleaned; `data` itself when nothing is to change. */
export function cleanZipPart(format: ZipFormat, name: string, data: Uint8Array): Uint8Array {
  if (ZIP_IMAGE.test(name)) return data.length > PART_MAX ? data : stripImageMetadata(data.slice());
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

// ---- Office 97–2003 and encrypted Office files: OLE compound files --------------------------------

const CFB_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;

export function isCfb(b: Uint8Array): boolean {
  return b.length >= 512 && CFB_SIG.every((x, i) => b[i] === x);
}

const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const le32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const guid = (b: Uint8Array, at: number) => Array.from(b.subarray(at, at + 16), (x) => x.toString(16).padStart(2, '0')).join('');

/** Property-set sections and the string properties emptied in each (all of them: -1). */
const PROPERTY_SETS = new Map<string, number[] | -1>([
  // SummaryInformation: title, subject, author, keywords, comments, template, last saved by, application
  ['e0859ff2f94f6810ab9108002b27b3d9', [2, 3, 4, 5, 6, 7, 8, 18]],
  // DocumentSummaryInformation: category, manager, company
  ['02d5cdd59c2e1b10939708002b2cf9ae', [2, 14, 15]],
  // custom properties: every value
  ['05d5cdd59c2e1b10939708002b2cf9ae', -1],
]);
const CFB_TABLE_MAX = 64 * 1024 * 1024;
const CFB_STREAM_MAX = 16 * 1024 * 1024;

/**
 * Same-length patches for an OLE compound file (Word, Excel, PowerPoint 97–2003, Visio, Publisher;
 * encrypted Office files are compound files too). The file is read through its sector tables and:
 * - the summary property sets lose their title, subject, author, keywords, comments, template,
 *   last-saved-by, application, category, manager and company, and every custom property value
 *   (string values become zeros: empty);
 * - PowerPoint's "Current User" stream loses the user name;
 * - Excel's workbook stream loses the user name in its WriteAccess record.
 * Dates, statistics and the document itself stay. Word documents keep author names inside their
 * own stream (tracked changes, comments), which needs a Word parser. Anything malformed: no patches.
 */
export function cfbPatches(src: RandomRead): Patch[] {
  try {
    return cfb(src);
  } catch {
    return [];
  }
}

function cfb(src: RandomRead): Patch[] {
  const h = src.read(0, 512);
  if (!CFB_SIG.every((x, i) => h[i] === x)) return [];
  const shift = le16(h, 0x1e);
  if (shift !== 9 && shift !== 12) return [];
  const sector = 1 << shift;
  const miniShift = le16(h, 0x20);
  if (miniShift !== 6) return [];
  const cutoff = le32(h, 0x38);
  const at = (n: number) => (n + 1) * sector;
  // the FAT: its sectors from the header's 109 entries and the DIFAT chain
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const n = le32(h, 0x4c + i * 4);
    if (n === FREE || n === END_OF_CHAIN) break;
    fatSectors.push(n);
  }
  let difat = le32(h, 0x44);
  for (let k = 0; difat !== END_OF_CHAIN && difat !== FREE && k < 1 << 16; k++) {
    const d = src.read(at(difat), sector);
    for (let i = 0; i < sector / 4 - 1; i++) {
      const n = le32(d, i * 4);
      if (n !== FREE && n !== END_OF_CHAIN) fatSectors.push(n);
    }
    difat = le32(d, sector - 4);
  }
  if (fatSectors.length * sector > CFB_TABLE_MAX) return [];
  const fat = new Uint32Array(fatSectors.length * (sector / 4));
  fatSectors.forEach((n, i) => {
    if (at(n) + sector > src.size) throw new RangeError('FAT past the end');
    const d = src.read(at(n), sector);
    for (let k = 0; k < sector / 4; k++) fat[i * (sector / 4) + k] = le32(d, k * 4);
  });
  const chain = (start: number, table: Uint32Array): number[] => {
    const list: number[] = [];
    for (let n = start; n !== END_OF_CHAIN; n = table[n]) {
      if (n >= table.length || list.length > table.length) throw new RangeError('bad chain');
      list.push(n);
    }
    return list;
  };
  // the directory
  const dirSectors = chain(le32(h, 0x30), fat);
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (const n of dirSectors) {
    const d = src.read(at(n), sector);
    for (let e = 0; e + 128 <= sector; e += 128) {
      const len = Math.min(64, le16(d, e + 0x40));
      let name = '';
      for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(le16(d, e + i));
      entries.push({ name, type: d[e + 0x42], start: le32(d, e + 0x74), size: le32(d, e + 0x78) + (shift === 12 ? le32(d, e + 0x7c) * 0x1_0000_0000 : 0) });
    }
  }
  const root = entries[0];
  if (!root || root.type !== 5) return [];
  // the mini stream (small streams live there, in 64-byte sectors) and its table
  const miniSectorsOfRoot = root.size > 0 ? chain(root.start, fat) : [];
  const miniFatChain = le32(h, 0x3c) === END_OF_CHAIN ? [] : chain(le32(h, 0x3c), fat);
  if (miniFatChain.length * sector > CFB_TABLE_MAX) return [];
  const miniFat = new Uint32Array(miniFatChain.length * (sector / 4));
  miniFatChain.forEach((n, i) => {
    const d = src.read(at(n), sector);
    for (let k = 0; k < sector / 4; k++) miniFat[i * (sector / 4) + k] = le32(d, k * 4);
  });
  /** Where a stream's bytes are in the file: [file offset, length] pieces in order. */
  const pieces = (e: Entry): [number, number][] => {
    const out: [number, number][] = [];
    let left = e.size;
    if (e.size < cutoff) {
      for (const m of chain(e.start, miniFat)) {
        if (left <= 0) break;
        const off = m * 64;   // within the mini stream
        const s = miniSectorsOfRoot[Math.floor(off / sector)];
        if (s === undefined) throw new RangeError('mini sector past the mini stream');
        const k = Math.min(64, left);
        out.push([at(s) + (off % sector), k]);
        left -= k;
      }
    } else {
      for (const n of chain(e.start, fat)) {
        if (left <= 0) break;
        const k = Math.min(sector, left);
        out.push([at(n), k]);
        left -= k;
      }
    }
    if (left > 0) throw new RangeError('stream shorter than its size');
    for (const [o, k] of out) if (o + k > src.size) throw new RangeError('stream past the end');
    return out;
  };
  const patches: Patch[] = [];
  for (const e of entries) {
    if (e.type !== 2 || e.size === 0 || e.size > CFB_STREAM_MAX) continue;
    const isSummary = e.name === '\u0005SummaryInformation' || e.name === '\u0005DocumentSummaryInformation';
    const isUser = e.name === 'Current User';
    const isBook = e.name === 'Workbook' || e.name === 'Book';
    if (!isSummary && !isUser && !isBook) continue;
    const map = pieces(e);
    const data = new Uint8Array(e.size);
    let q = 0;
    for (const [o, k] of map) {
      data.set(src.read(o, k), q);
      q += k;
    }
    const local: Patch[] = [];   // in stream offsets
    if (isSummary) propertySet(data, local);
    else if (isUser) currentUser(data, local);
    else workbook(data, local, e.name === 'Book');
    data.fill(0);
    // stream offsets to file offsets, split where the stream crosses a sector
    for (const p of local) {
      let s = 0;
      let done = 0;
      for (const [o, k] of map) {
        const from = Math.max(p.at, s);
        const to = Math.min(p.at + p.bytes.length, s + k);
        if (from < to) {
          patches.push({ at: o + (from - s), bytes: p.bytes.subarray(from - p.at, to - p.at) });
          done += to - from;
        }
        s += k;
        if (done === p.bytes.length) break;
      }
    }
  }
  return patches;
}

/** Empties string properties (see PROPERTY_SETS): their bytes become zeros, their lengths stay. */
function propertySet(d: Uint8Array, patches: Patch[]): void {
  if (d.length < 28 || le16(d, 0) !== 0xfffe) return;
  const sections = le32(d, 24);
  for (let i = 0; i < sections && i < 8; i++) {
    const s = 28 + i * 20;
    if (s + 20 > d.length) return;
    const ids = PROPERTY_SETS.get(guid(d, s));
    const off = le32(d, s + 16);
    if (ids === undefined || off + 8 > d.length) continue;
    const size = le32(d, off);
    const count = le32(d, off + 4);
    const end = Math.min(d.length, off + size);
    for (let k = 0; k < count && off + 8 + k * 8 + 8 <= end; k++) {
      const id = le32(d, off + 8 + k * 8);
      const at = off + le32(d, off + 12 + k * 8);
      if (id === 0 || id === 1 || at + 8 > end) continue;   // the dictionary of names, the code page
      if (ids !== -1 && !ids.includes(id)) continue;
      const type = le16(d, at);
      const n = le32(d, at + 4);
      const bytes = type === 0x1e ? n : type === 0x1f ? n * 2 : -1;   // VT_LPSTR, VT_LPWSTR
      if (bytes > 0 && at + 8 + bytes <= end) zeroPatches(patches, at + 8, bytes);
    }
  }
}

/** PowerPoint's CurrentUserAtom: the user name, in ANSI and then in Unicode. */
function currentUser(d: Uint8Array, patches: Patch[]): void {
  if (d.length < 28 || le16(d, 2) !== 0x0ff6) return;
  const len = le16(d, 20);
  const ansi = 28;
  if (ansi + len > d.length) return;
  zeroPatches(patches, ansi, len);
  const unicode = ansi + len + 4;   // after the release version
  if (unicode + len * 2 <= d.length && le32(d, 4) >= 24 + 3 * len) zeroPatches(patches, unicode, len * 2);
}

/**
 * Excel's workbook globals: the WriteAccess record's user name becomes empty (its length 0) and its
 * characters spaces, as Excel pads the record. `biff5`: the older "Book" stream, with a one-byte length.
 */
function workbook(d: Uint8Array, patches: Patch[], biff5: boolean): void {
  for (let p = 0, k = 0; p + 4 <= d.length && k < 4096; k++) {
    const type = le16(d, p);
    const len = le16(d, p + 2);
    if (p + 4 + len > d.length) return;
    if (type === 0x002f || type === 0x000a) return;   // FilePass (the rest is encrypted), EOF
    if (type === 0x005c && len >= (biff5 ? 1 : 3)) {
      if (biff5) {
        patches.push({ at: p + 4, bytes: new Uint8Array(1) });
        patches.push({ at: p + 5, bytes: new Uint8Array(len - 1).fill(0x20) });
      } else {
        patches.push({ at: p + 4, bytes: new Uint8Array(2) });   // no characters
        patches.push({ at: p + 7, bytes: new Uint8Array(len - 3).fill(0x20) });
      }
      return;
    }
    p += 4 + len;
  }
}
