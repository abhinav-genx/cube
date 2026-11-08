import { randombytes_buf, to_hex, to_string } from 'react-native-libsodium';
import { disk } from './disk';
import { decryptBlob, encryptBlob, type Opened } from './vault';

export type Entry = {
  id: string;        // 32 hex chars, random — the on-disk name
  name: string;      // the real name, only ever stored inside the encrypted index
  size: number;
  mime: string;
  addedAt: number;
};

const INDEX = 'i.bin';

const path = (s: Opened, name: string) => `${s.vault}/${name}`;

function encodeUtf8(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  // Hermes always has TextEncoder on current RN; this keeps very old runtimes from crashing.
  const bin = unescape(encodeURIComponent(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function loadIndex(s: Opened): Promise<Entry[]> {
  const blob = await disk.read(path(s, INDEX));
  if (!blob) return [];
  const plain = decryptBlob(s.fileKey, blob);
  const text = to_string(plain);
  plain.fill(0);
  const parsed = JSON.parse(text) as { files?: Entry[] };
  return Array.isArray(parsed.files) ? parsed.files : [];
}

async function saveIndex(s: Opened, entries: Entry[]): Promise<void> {
  const plain = encodeUtf8(JSON.stringify({ files: entries }));
  await disk.write(path(s, INDEX), encryptBlob(s.fileKey, plain));
  plain.fill(0);
}

export async function addFile(s: Opened, name: string, mime: string, bytes: Uint8Array): Promise<Entry[]> {
  const id = to_hex(randombytes_buf(16));
  await disk.write(path(s, `${id}.bin`), encryptBlob(s.fileKey, bytes));
  const entries = await loadIndex(s);
  entries.unshift({ id, name, size: bytes.length, mime, addedAt: Date.now() });
  await saveIndex(s, entries);
  return entries;
}

export async function readFile(s: Opened, id: string): Promise<Uint8Array> {
  const blob = await disk.read(path(s, `${id}.bin`));
  if (!blob) throw new Error('File is missing');
  return decryptBlob(s.fileKey, blob);
}

export async function removeFile(s: Opened, id: string): Promise<Entry[]> {
  await disk.remove(path(s, `${id}.bin`));
  const entries = (await loadIndex(s)).filter((e) => e.id !== id);
  await saveIndex(s, entries);
  return entries;
}
