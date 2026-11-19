/**
 * Removes author and organisation details from documents before they are stored, the way
 * lib/strip.ts does for photos. Dates are kept, as for photos.
 *
 * - PDF: the document-information strings (Author, Creator, Producer, Title, Subject, Keywords)
 *   are blanked in place, at the same length, so every offset in the file stays valid; XMP
 *   packets are blanked the same way. Information dictionaries inside Flate-compressed object
 *   streams (common in PDFs from recent tools), and compressed XMP streams, are decompressed,
 *   blanked, recompressed and written back at the same offset (pdfStreamPatches).
 * - Office (docx, xlsx, pptx and their macro variants): the author, last-modified-by, title,
 *   subject, keywords, comments and category in docProps/core.xml, company and manager in
 *   docProps/app.xml, and every custom property value are emptied; the zip is rebuilt.
 *
 * Native code (modules/cube-native CubeDocClean) does both while streaming, at any size; this is
 * the JavaScript fallback. PDFs stream here too (PdfCleaner); Office files are rebuilt in memory, so
 * only those up to DOC_LIMIT bytes are cleaned. Anything unrecognised, encrypted or malformed is
 * returned unchanged rather than risk damaging it.
 */
import { strFromU8, strToU8, unzipSync, unzlibSync, zipSync, zlibSync, type Zippable } from 'fflate';

export const DOC_LIMIT = 50 * 1024 * 1024;

const OFFICE = /\.(docx|docm|xlsx|xlsm|pptx|pptm)$/i;
const OFFICE_MIME = /officedocument|ms-word\.document\.macro|ms-excel\.sheet\.macro|ms-powerpoint\.presentation\.macro/i;

/** Which kind of document this is, for cleaning: a PDF, an Office file, or neither. */
export function documentKind(name: string, mime: string): 'pdf' | 'office' | null {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (OFFICE.test(name) || OFFICE_MIME.test(mime)) return 'office';
  return null;
}

/**
 * True for documents the JavaScript fallback cleans in memory (Office files up to DOC_LIMIT).
 * PDFs stream through PdfCleaner at any size; native code (modules/cube-native) cleans both, at any size.
 */
export function isCleanableDocument(name: string, mime: string, size: number): boolean {
  return documentKind(name, mime) === 'office' && size <= DOC_LIMIT;
}

/**
 * Returns the cleaned document: `bytes` itself, edited in place (PDF), or a new array (Office,
 * rebuilt; the caller should zero the original then). Unrecognised input comes back unchanged.
 */
export function stripDocumentMetadata(bytes: Uint8Array): Uint8Array {
  if (startsWith(bytes, '%PDF-')) {
    stripPdf(bytes);
    return bytes;
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {   // "PK": a zip
    try {
      return stripOffice(bytes) ?? bytes;
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
 * Finds the Flate-compressed object streams (/Type /ObjStm, where recent tools put the document
 * information dictionary) and XMP streams (/Type /Metadata) whose contents PdfCleaner would change,
 * and returns same-length patches for them: the cleaned contents, recompressed, then newlines up
 * to the old end; and the /Length number, rewritten with spaces after it. Every offset in the file
 * stays valid. A stream whose cleaned form compresses larger than before, or with an indirect
 * /Length, other filters or decode parameters, is left alone. The native ports
 * (CubeDocClean.swift / .kt) find the same streams; their compressor's bytes differ, the
 * decompressed contents do not.
 */
export function pdfStreamPatches(src: RandomRead): Patch[] {
  const patches: Patch[] = [];
  const STEP = 1 << 20;
  for (let start = 0; start < src.size; start += STEP) {
    const win = src.read(start, Math.min(STEP + STREAM.length, src.size - start));
    for (let i = win.indexOf(0x73); i >= 0 && i < Math.min(STEP, win.length); i = win.indexOf(0x73, i + 1)) {
      if (i + STREAM.length > win.length) break;
      let hit = true;
      for (let k = 1; k < STREAM.length; k++) if (win[i + k] !== STREAM[k]) { hit = false; break; }
      if (hit) streamPatch(src, start + i, patches);
    }
  }
  return patches;
}

/** Looks at the "stream" keyword at `p`; adds patches if it starts a stream worth cleaning. */
function streamPatch(src: RandomRead, p: number, patches: Patch[]): void {
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
  if (!/\/Type\s*\/(ObjStm|Metadata)(?![A-Za-z0-9])/.test(dict)) return;
  if (!/\/Filter\s*(\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dict) || /\/DecodeParms/.test(dict)) return;
  const len = /\/Length\s+(\d+)(?!\s*\d*\s+R)(?![0-9])/.exec(dict);
  if (!len) return;
  const L = Number(len[1]);
  if (L > STREAM_MAX || dataStart + L > src.size) return;
  const data = src.read(dataStart, L);
  if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) return;
  let plain: Uint8Array;
  try {
    plain = unzlibSync(data);
  } catch {
    return;   // not valid zlib: leave it
  }
  if (plain.length > STREAM_MAX) return;
  const c = new PdfCleaner();
  const head = c.push(plain);
  const tail = c.finish();
  const clean = new Uint8Array(plain.length);
  clean.set(head);
  clean.set(tail, head.length);
  let same = true;
  for (let k = 0; k < plain.length; k++) if (plain[k] !== clean[k]) { same = false; break; }
  plain.fill(0);
  if (same) return;
  const z = zlibSync(clean, { level: 9 });
  clean.fill(0);
  if (z.length > L) return;   // cleaned but no smaller: cannot fit, left as it is
  const bytes = new Uint8Array(L).fill(0x0a);
  bytes.set(z);
  patches.push({ at: dataStart, bytes });
  const digits = String(z.length).padEnd(len[1].length, ' ');
  const digitsAt = p - back + open + len.index + len[0].length - len[1].length;
  patches.push({ at: digitsAt, bytes: ascii(digits) });
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

// ---- Office ------------------------------------------------------------------------------------

const CORE_TAGS = ['dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'cp:keywords', 'dc:description', 'cp:category'];
const APP_TAGS = ['Company', 'Manager'];

function emptyElements(xml: string, tags: string[]): string {
  let out = xml;
  for (const t of tags) {
    const esc = t.replace(':', '\\:');
    out = out.replace(new RegExp(`(<${esc}(?:\\s[^>]*)?>)[\\s\\S]*?(</${esc}>)`, 'g'), '$1$2');
  }
  return out;
}

function stripOffice(b: Uint8Array): Uint8Array | null {
  const files = unzipSync(b);
  if (!files['[Content_Types].xml']) return null;   // a zip, but not an Office document
  const out: Zippable = {};
  let changed = false;
  for (const [name, data] of Object.entries(files)) {
    let next = data;
    if (name === 'docProps/core.xml') next = strToU8(emptyElements(strFromU8(data), CORE_TAGS));
    else if (name === 'docProps/app.xml') next = strToU8(emptyElements(strFromU8(data), APP_TAGS));
    else if (name === 'docProps/custom.xml') {
      next = strToU8(strFromU8(data).replace(/(<vt:[A-Za-z0-9]+(?:\s[^>]*)?>)[\s\S]*?(<\/vt:[A-Za-z0-9]+>)/g, '$1$2'));
    }
    if (next !== data) changed = true;
    out[name] = next;
  }
  if (!changed) return null;
  // [Content_Types].xml first, as Office writes it; everything else in its original order.
  const ordered: Zippable = { '[Content_Types].xml': out['[Content_Types].xml'] };
  for (const name of Object.keys(out)) if (name !== '[Content_Types].xml') ordered[name] = out[name];
  return zipSync(ordered, { level: 6 });
}

// ---- bytes -------------------------------------------------------------------------------------

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function startsWith(b: Uint8Array, s: string): boolean {
  if (b.length < s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
  return true;
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
