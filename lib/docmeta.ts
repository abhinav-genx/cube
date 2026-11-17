/**
 * Removes author and organisation details from documents before they are stored, the way
 * lib/strip.ts does for photos. Dates are kept, as for photos.
 *
 * - PDF: the document-information strings (Author, Creator, Producer, Title, Subject, Keywords)
 *   are blanked in place, at the same length, so every offset in the file stays valid; XMP
 *   packets are blanked the same way. Info dictionaries inside compressed object streams (common
 *   in PDFs from recent tools) cannot be edited in place and are left as they are.
 * - Office (docx, xlsx, pptx and their macro variants): the author, last-modified-by, title,
 *   subject, keywords, comments and category in docProps/core.xml, company and manager in
 *   docProps/app.xml, and every custom property value are emptied; the zip is rebuilt.
 *
 * Works on the whole file in memory (JavaScript), so only files up to DOC_LIMIT bytes are cleaned;
 * larger ones are stored as they are. Anything unrecognised, encrypted or malformed is returned
 * unchanged rather than risk damaging it.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { blankXmpPackets } from './strip';

export const DOC_LIMIT = 50 * 1024 * 1024;

const OFFICE = /\.(docx|docm|xlsx|xlsm|pptx|pptm)$/i;
const OFFICE_MIME = /officedocument|ms-word\.document\.macro|ms-excel\.sheet\.macro|ms-powerpoint\.presentation\.macro/i;

/** True for documents stripDocumentMetadata knows how to clean (so the caller reads them whole). */
export function isCleanableDocument(name: string, mime: string, size: number): boolean {
  if (size > DOC_LIMIT) return false;
  return mime === 'application/pdf' || /\.pdf$/i.test(name) || OFFICE.test(name) || OFFICE_MIME.test(mime);
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

function stripPdf(b: Uint8Array): void {
  for (const key of PDF_KEYS) {
    const name = ascii(`/${key}`);
    for (let i = find(b, name, 0); i >= 0; i = find(b, name, i + name.length)) {
      const after = i + name.length;
      // the key must end here (not /AuthorX), then the value: a literal or hex string
      if (after < b.length && /[A-Za-z0-9]/.test(String.fromCharCode(b[after]))) continue;
      let j = after;
      while (j < b.length && isWhite(b[j])) j++;
      if (b[j] === 0x28) blankLiteral(b, j);   // (…)
      else if (b[j] === 0x3c && b[j + 1] !== 0x3c) blankHex(b, j);   // <…>, not a <<dictionary
    }
  }
  blankXmpPackets(b);
}

/** (text) → (    ): balanced parentheses and backslash escapes respected; spaces keep the length. */
function blankLiteral(b: Uint8Array, open: number): void {
  let depth = 0;
  for (let k = open; k < b.length; k++) {
    const c = b[k];
    if (c === 0x5c) {   // backslash: the next byte is escaped
      b[k] = 0x20;
      if (k + 1 < b.length) b[++k] = 0x20;
      continue;
    }
    if (c === 0x28) {
      depth++;
      if (depth > 1) b[k] = 0x20;
      continue;
    }
    if (c === 0x29) {
      depth--;
      if (depth === 0) return;
      b[k] = 0x20;
      continue;
    }
    b[k] = 0x20;
  }
}

/** <48656C6C6F> → <2020202020>: hex digits become spaces' code, so the string decodes to spaces. */
function blankHex(b: Uint8Array, open: number): void {
  let n = 0;
  for (let k = open + 1; k < b.length && b[k] !== 0x3e; k++) {
    if (isWhite(b[k])) continue;
    b[k] = n++ % 2 === 0 ? 0x32 : 0x30;   // '2', '0'
  }
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
