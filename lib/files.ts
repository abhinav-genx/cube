import { randombytes_buf, to_hex, to_string } from 'react-native-libsodium';
import { disk, storedUri } from './disk';
import { blobSize, decryptBlob, encryptBlob, INDEX, INDEX_MIN_BYTES, type Opened } from './vault';

export type Entry = {
  id: string;        // 32 hex chars, random — the on-disk name
  name: string;      // the real name, only ever stored inside the encrypted index
  size: number;
  mime: string;
  addedAt: number;
};

const path = (s: Opened, name: string) => `${s.vault}/${name}`;

function encodeUtf8(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  // Hermes always has TextEncoder on current RN; this keeps very old runtimes from crashing.
  const bin = unescape(encodeURIComponent(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The encrypted index. `shred` lists blobs that must become filler: one being added whose entry
 * has not landed yet, or one being deleted. If the app is killed halfway, tidy() finishes the job,
 * so no readable ciphertext is ever left behind unlisted.
 */
type Index = { files: Entry[]; shred: string[] };

async function readIndex(s: Opened): Promise<Index> {
  const blob = await disk.read(path(s, INDEX));
  if (!blob) return { files: [], shred: [] };
  const plain = decryptBlob(s.fileKey, blob);
  const text = to_string(plain);
  plain.fill(0);
  const parsed = JSON.parse(text) as Partial<Index>;
  return {
    files: Array.isArray(parsed.files) ? parsed.files : [],
    shred: Array.isArray(parsed.shred) ? parsed.shred : [],
  };
}

export async function loadIndex(s: Opened): Promise<Entry[]> {
  return (await readIndex(s)).files;
}

async function saveIndex(s: Opened, index: Index): Promise<void> {
  const plain = encodeUtf8(JSON.stringify(index));
  await disk.write(path(s, INDEX), encryptBlob(s.fileKey, plain, INDEX_MIN_BYTES));
  plain.fill(0);
}

// Every change to a vault's index is read-modify-write, so changes run one at a time: an add
// and a delete started together would otherwise each write back an index missing the other's change.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Queues a change with its own copy of the key, taken now. lock() zeroes the session's key in
 * place, and a change already started (or queued) must finish with the real key: written with a
 * zeroed one, the index would be re-encrypted under zeros and every file in the vault lost.
 * The copy is zeroed when the change ends.
 */
function change<T>(s: Opened, fn: (own: Opened) => Promise<T>): Promise<T> {
  if (s.fileKey.every((b) => b === 0)) return Promise.reject(new Error('The vault is locked'));
  const own: Opened = { vault: s.vault, fileKey: s.fileKey.slice() };
  return serial(async () => {
    try {
      return await fn(own);
    } finally {
      own.fileKey.fill(0);
    }
  });
}

// ---- filler: both vault folders always look alike ----------------------------------------
// Someone with a copy of storage could otherwise count the blobs in each folder and see that the
// vault you did not open holds more. So every blob written to one folder gets a same-size blob of
// random bytes in the other, deleted files are overwritten with random bytes instead of removed,
// and tidy() evens out whatever a crash left uneven. Random bytes look exactly like ciphertext.
// The cost: storage use roughly doubles and never shrinks.
const BLOB = /^[0-9a-f]{32}\.bin$/;
const newId = () => to_hex(randombytes_buf(16));
const otherDir = (s: Opened) => String(1 - s.vault);

async function writeFiller(dir: string, size: number): Promise<void> {
  await disk.write(`${dir}/${newId()}.bin`, randombytes_buf(size));
}

/** Overwrites a blob of this vault with random bytes of the same size (it becomes filler). */
async function shredBlob(s: Opened, id: string): Promise<void> {
  const f = (await disk.list(String(s.vault))).find((x) => x.name === `${id}.bin`);
  if (f) await disk.write(path(s, f.name), randombytes_buf(f.size));
}

export function addFile(s: Opened, name: string, mime: string, bytes: Uint8Array): Promise<Entry[]> {
  return change(s, async (s) => {
    const index = await readIndex(s);
    const id = newId();
    const blob = encryptBlob(s.fileKey, bytes);
    await saveIndex(s, { files: index.files, shred: [...index.shred, id] });   // until the entry lands
    await disk.write(path(s, `${id}.bin`), blob);
    await writeFiller(otherDir(s), blob.length);
    const files = [{ id, name, size: bytes.length, mime, addedAt: Date.now() }, ...index.files];
    await saveIndex(s, { files, shred: index.shred });
    return files;
  });
}

export async function readFile(s: Opened, id: string): Promise<Uint8Array> {
  const blob = await disk.read(path(s, `${id}.bin`));
  if (!blob) throw new Error('File is missing');
  return decryptBlob(s.fileKey, blob);
}

/** URI of a file's blob, for the native image preview. */
export function blobUri(s: Opened, id: string): string {
  return storedUri(path(s, `${id}.bin`));
}

export function removeFile(s: Opened, id: string): Promise<Entry[]> {
  return change(s, async (s) => {
    // Index first (entry gone, blob marked), then the blob becomes filler, then the mark goes.
    const index = await readIndex(s);
    const files = index.files.filter((e) => e.id !== id);
    await saveIndex(s, { files, shred: [...index.shred, id] });
    await shredBlob(s, id);
    await saveIndex(s, { files, shred: index.shred });
    return files;
  });
}

/**
 * Run after each unlock. Finishes adds and deletes a kill interrupted (their blobs become
 * filler), removes half-written ".part" files, and adds filler until both folders hold the same
 * number of blobs of each size. Does nothing if this vault's index is missing or unreadable.
 */
export function tidy(s: Opened): Promise<void> {
  return change(s, async (s) => {
    if (!(await disk.read(path(s, INDEX)))) return;
    const index = await readIndex(s);
    const own = (await disk.list(String(s.vault))).find((f) => f.name === INDEX);
    const undersized = !!own && own.size < blobSize(0, INDEX_MIN_BYTES);   // written before padding
    if (index.shred.length > 0 || undersized) {
      for (const id of index.shred) await shredBlob(s, id);
      await saveIndex(s, { files: index.files, shred: [] });
    }
    for (const dir of ['0', '1']) {
      for (const f of await disk.list(dir)) {
        if (f.name.endsWith('.part')) await disk.remove(`${dir}/${f.name}`);
      }
    }
    await balanceFolders();
  });
}

async function balanceFolders(): Promise<void> {
  const counts = async (dir: string) => {
    const m = new Map<number, number>();
    for (const f of await disk.list(dir)) if (BLOB.test(f.name)) m.set(f.size, (m.get(f.size) ?? 0) + 1);
    return m;
  };
  const [a, b] = [await counts('0'), await counts('1')];
  for (const size of new Set([...a.keys(), ...b.keys()])) {
    const d = (a.get(size) ?? 0) - (b.get(size) ?? 0);
    for (let i = 0; i < Math.abs(d); i++) await writeFiller(d > 0 ? '1' : '0', size);
  }
}
