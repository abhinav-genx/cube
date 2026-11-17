import { base64_variants, crypto_generichash, from_base64, randombytes_buf, to_base64, to_hex, to_string } from 'react-native-libsodium';
import { disk, storedUri } from './disk';
import {
  blobSize,
  CHUNK,
  ChunkWriter,
  chunkCount,
  chunkedSize,
  decryptBlob,
  decryptChunked,
  decryptChunkedStream,
  EMPTY_SHARD,
  encryptBlob,
  encryptChunked,
  INDEX,
  INDEX_MIN_BYTES,
  SHARD_MIN_BYTES,
  SHARDS,
  shardName,
  type Opened,
  type Sink,
  type Source,
} from './vault';

/** A file as the app sees it. */
export type Entry = {
  id: string;        // 32 hex chars, random — the on-disk name
  name: string;      // the real name, only ever stored inside the encrypted index
  size: number;
  mime: string;
  addedAt: number;
};

/**
 * A file as the index stores it. `key` (base64) is the file's own key: present for files stored in
 * the chunked v2 format, absent for older files, which are v1 blobs under the vault key.
 *
 * Which format a blob is in follows from its size alone: v1 blobs are 40 + k·65,536 bytes and v2
 * blobs 16 + n·65,552, and the two never coincide. Readers go by the size, so an entry whose key
 * was saved just before its blob was upgraded (a kill in between) still opens.
 */
type Stored = Entry & { key?: string };

const path = (s: Opened, name: string) => `${s.vault}/${name}`;
const B64 = base64_variants.ORIGINAL;

function encodeUtf8(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  // Hermes always has TextEncoder on current RN; this keeps very old runtimes from crashing.
  const bin = unescape(encodeURIComponent(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const publicEntry = ({ id, name, size, mime, addedAt }: Stored): Entry => ({ id, name, size, mime, addedAt });
const newest = (a: Entry, b: Entry) => b.addedAt - a.addedAt;

// ---- the index: SHARDS encrypted pages ------------------------------------------------------
/**
 * One page of the index. `shred` lists blobs (with ids on this page) that must become filler: one
 * being added whose entry has not landed yet, or one being deleted. If the app is killed halfway,
 * tidy() finishes the job, so no readable ciphertext is ever left behind unlisted.
 */
type Shard = { files: Stored[]; shred: string[] };
const shardOf = (id: string) => parseInt(id[0], 16) % SHARDS;

function parseShard(plain: Uint8Array): Shard {
  const text = to_string(plain);
  plain.fill(0);
  const parsed = JSON.parse(text) as Partial<Shard>;
  return {
    files: Array.isArray(parsed.files) ? parsed.files : [],
    shred: Array.isArray(parsed.shred) ? parsed.shred : [],
  };
}

async function readShard(s: Opened, n: number): Promise<Shard> {
  const blob = await disk.read(path(s, shardName(n)));
  if (!blob) return { files: [], shred: [] };
  return parseShard(decryptBlob(s.fileKey, blob));   // throws if unreadable: never treat as empty
}

async function saveShard(s: Opened, n: number, shard: Shard): Promise<void> {
  const plain = encodeUtf8(JSON.stringify(shard));
  await disk.write(path(s, shardName(n)), encryptBlob(s.fileKey, plain, SHARD_MIN_BYTES));
  plain.fill(0);
}

async function readAll(s: Opened): Promise<Shard[]> {
  const out: Shard[] = [];
  for (let n = 0; n < SHARDS; n++) out.push(await readShard(s, n));
  return out;
}

const listOf = (shards: Shard[]): Entry[] => shards.flatMap((x) => x.files.map(publicEntry)).sort(newest);

/**
 * Brings a vault to the current layout, before anything else touches its index:
 *
 * - Vaults from before the split kept one index, "i.bin". If it opens with this vault's key, its
 *   entries move into the pages and i.bin is overwritten with random bytes (it stays, as filler:
 *   the other vault's folder still has its own i.bin until that vault is opened).
 * - Every page name and i.bin must exist in both folders. Missing ones in the other folder get
 *   random filler of the empty-page size, so the folders keep looking alike.
 *
 * Safe to repeat: a kill halfway leaves i.bin readable, and the next run migrates again.
 */
const layoutChecked = new Set<string>();   // per key, per process: the check runs once

/** Forget which vaults were checked (tests simulate restarts with it). */
export function resetLayoutCache(): void {
  layoutChecked.clear();
}

async function ensureLayout(s: Opened): Promise<void> {
  const tag = `${s.vault}:${to_hex(crypto_generichash(16, s.fileKey, null))}`;
  if (layoutChecked.has(tag)) return;
  const legacy = await disk.read(path(s, INDEX));
  if (legacy) {
    let old: Shard | null = null;
    try {
      old = parseShard(decryptBlob(s.fileKey, legacy));
    } catch {
      old = null;   // random filler (already migrated, or a new vault): nothing to move
    }
    if (old) {
      const pages: Shard[] = Array.from({ length: SHARDS }, () => ({ files: [], shred: [] }));
      for (const e of old.files) pages[shardOf(e.id)].files.push(e);
      for (const id of old.shred) pages[shardOf(id)].shred.push(id);
      for (let n = 0; n < SHARDS; n++) await saveShard(s, n, pages[n]);
      await disk.write(path(s, INDEX), randombytes_buf(legacy.length));
    }
  }
  const page = blobSize(0, SHARD_MIN_BYTES);
  for (const dir of [String(s.vault), otherDir(s)]) {
    const have = new Set((await disk.list(dir)).map((f) => f.name));
    const own = dir === String(s.vault);
    for (let n = 0; n < SHARDS; n++) {
      if (have.has(shardName(n))) continue;
      if (own) await saveShard(s, n, { files: [], shred: [] });
      else await disk.write(`${dir}/${shardName(n)}`, randombytes_buf(page));
    }
    if (!have.has(INDEX)) await disk.write(`${dir}/${INDEX}`, randombytes_buf(blobSize(0, INDEX_MIN_BYTES)));
  }
  layoutChecked.add(tag);
}

// Every change to a vault's index is read-modify-write, so changes run one at a time: an add
// and a delete started together would otherwise each write back a page missing the other's change.
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
 * The copy is zeroed when the change ends. Each change first brings the layout up to date.
 */
function change<T>(s: Opened, fn: (own: Opened) => Promise<T>): Promise<T> {
  if (s.fileKey.every((b) => b === 0)) return Promise.reject(new Error('The vault is locked'));
  const own: Opened = { vault: s.vault, fileKey: s.fileKey.slice() };
  return serial(async () => {
    try {
      await ensureLayout(own);
      return await fn(own);
    } finally {
      own.fileKey.fill(0);
    }
  });
}

export function loadIndex(s: Opened): Promise<Entry[]> {
  return change(s, async (s) => listOf(await readAll(s)));
}

async function findStored(s: Opened, id: string): Promise<Stored | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return (await readShard(s, shardOf(id))).files.find((e) => e.id === id) ?? null;
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

/**
 * Disk I/O happens in blocks of this size: each read or write is one call into native code, so
 * 1 MiB blocks (16 encryption chunks) instead of 64 KiB cut those calls sixteenfold for big files
 * while keeping memory use small. The stored format is unchanged.
 */
const IO_BLOCK = 16 * CHUNK;

/** Collects small pieces and hands them to `write` in blocks of about IO_BLOCK bytes. */
function blockWriter(write: (bytes: Uint8Array) => Promise<void>) {
  let parts: Uint8Array[] = [];
  let size = 0;
  const flush = async () => {
    if (size === 0) return;
    const block = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      block.set(p, at);
      at += p.length;
      p.fill(0);   // pieces may be decrypted data (export): wipe each once copied
    }
    parts = [];
    size = 0;
    try {
      await write(block);
    } finally {
      block.fill(0);
    }
  };
  return {
    async add(bytes: Uint8Array) {
      parts.push(bytes);
      size += bytes.length;
      if (size >= IO_BLOCK) await flush();
    },
    flush,
  };
}

/** Writes `size` random bytes to `file`, streamed, so large files never sit in memory. */
async function writeRandom(file: string, size: number): Promise<void> {
  const sink = await disk.create(file);
  try {
    for (let left = size; left > 0; left -= IO_BLOCK) await sink.write(randombytes_buf(Math.min(IO_BLOCK, left)));
    await sink.commit();
  } catch (e) {
    await sink.abort();
    throw e;
  }
}

const writeFiller = (dir: string, size: number) => writeRandom(`${dir}/${newId()}.bin`, size);

/** Overwrites a blob of this vault with random bytes of the same size (it becomes filler). */
async function shredBlob(s: Opened, id: string): Promise<void> {
  const f = (await disk.list(String(s.vault))).find((x) => x.name === `${id}.bin`);
  if (f) await writeRandom(path(s, f.name), f.size);
}

// ---- adding -----------------------------------------------------------------------------------
/**
 * The steps every add takes, around writing the blob itself: mark the id for shredding (so a kill
 * mid-write leaves only filler), write the blob, write same-size filler to the other folder, then
 * land the entry and drop the mark in one page write.
 */
async function addWith(
  s: Opened,
  name: string,
  mime: string,
  writeBlob: (blobPath: string, fileKey: Uint8Array) => Promise<{ size: number; blobBytes: number }>,
): Promise<Entry[]> {
  const id = newId();
  const n = shardOf(id);
  const page = await readShard(s, n);
  await saveShard(s, n, { files: page.files, shred: [...page.shred, id] });
  const fileKey = randombytes_buf(32);
  try {
    const { size, blobBytes } = await writeBlob(path(s, `${id}.bin`), fileKey);
    await writeFiller(otherDir(s), blobBytes);
    const entry: Stored = { id, name, size, mime, addedAt: Date.now(), key: to_base64(fileKey, B64) };
    await saveShard(s, n, { files: [entry, ...page.files], shred: page.shred });
  } catch (e) {
    await saveShard(s, n, page).catch(() => undefined);   // drop the mark; tidy() covers a kill here
    await shredBlob(s, id).catch(() => undefined);
    throw e;
  } finally {
    fileKey.fill(0);
  }
  return listOf(await readAll(s));
}

/** Adds a file held in memory (photos, after metadata removal). */
export function addFile(s: Opened, name: string, mime: string, bytes: Uint8Array): Promise<Entry[]> {
  return change(s, (s) =>
    addWith(s, name, mime, async (blobPath, fileKey) => {
      const blob = encryptChunked(fileKey, bytes);
      await disk.write(blobPath, blob);
      return { size: bytes.length, blobBytes: blob.length };
    }),
  );
}

/**
 * Adds a file streamed from `src` (a picked document), 64 KiB at a time: the plaintext never sits
 * in memory whole, so size is limited only by storage. The caller closes `src`.
 */
export function addFileFrom(s: Opened, name: string, mime: string, src: Source): Promise<Entry[]> {
  return change(s, (s) =>
    addWith(s, name, mime, async (blobPath, fileKey) => {
      const w = new ChunkWriter(fileKey);
      const sink = await disk.create(blobPath);
      const out = blockWriter((block) => sink.write(block));
      let written = 0;
      const put = async (parts: Uint8Array[]) => {
        for (const p of parts) {
          await out.add(p);
          written += p.length;
        }
      };
      try {
        for (;;) {
          const plain = await src.read(IO_BLOCK);
          if (plain.length === 0) break;
          try {
            await put(w.push(plain));
          } finally {
            plain.fill(0);
          }
        }
        await put(w.finish());
        await out.flush();
        await sink.commit();
      } catch (e) {
        await sink.abort();
        throw e;
      }
      return { size: w.size, blobBytes: written };
    }),
  );
}

// ---- reading ----------------------------------------------------------------------------------
/** What native code needs to open a file itself: the blob, its format and its key (zero it after). */
export type FileAccess = { entry: Entry; uri: string; format: 1 | 2; key: Uint8Array };

/** Looks up a file for native preview or export. Throws if it is not in the index. */
export function fileAccess(s: Opened, id: string): Promise<FileAccess> {
  return change(s, async (s) => {
    const e = await findStored(s, id);
    const size = e ? await blobBytes(s, id) : null;
    if (!e || size === null) throw new Error('File is missing');
    const chunked = isChunked(size);
    return { entry: publicEntry(e), uri: storedUri(path(s, `${id}.bin`)), format: chunked ? 2 : 1, key: keyFor(s, e, chunked) };
  });
}

const isChunked = (blobSize: number) => chunkCount(blobSize) > 0;

async function blobBytes(s: Opened, id: string): Promise<number | null> {
  return (await disk.list(String(s.vault))).find((f) => f.name === `${id}.bin`)?.size ?? null;
}

/** The key that opens this entry's blob: its own key (v2) or the vault key (v1). Zero it after use. */
function keyFor(s: Opened, e: Stored, chunked: boolean): Uint8Array {
  if (!chunked) return s.fileKey.slice();
  if (!e.key) throw new Error('corrupt');
  return from_base64(e.key, B64);
}

/** The whole decrypted file, in memory (text preview and export where native code is missing). */
export function readFile(s: Opened, id: string): Promise<Uint8Array> {
  return change(s, async (s) => {
    const e = await findStored(s, id);
    const blob = e ? await disk.read(path(s, `${id}.bin`)) : null;
    if (!e || !blob) throw new Error('File is missing');
    const chunked = isChunked(blob.length);
    const key = keyFor(s, e, chunked);
    try {
      return chunked ? decryptChunked(key, blob) : decryptBlob(key, blob);
    } finally {
      key.fill(0);
    }
  });
}

/** Streams the decrypted file into `sink` (export where native code is missing); commits it. */
export function exportTo(s: Opened, id: string, sink: Sink): Promise<void> {
  return change(s, async (s) => {
    const e = await findStored(s, id);
    const size = e ? await blobBytes(s, id) : null;
    if (!e || size === null) throw new Error('File is missing');
    try {
      if (!isChunked(size)) {
        const blob = await disk.read(path(s, `${id}.bin`));
        if (!blob) throw new Error('File is missing');
        const plain = decryptBlob(s.fileKey, blob);
        await sink.write(plain);
        plain.fill(0);
      } else {
        const f = { size };
        const src = await disk.open(path(s, `${id}.bin`));
        if (!src) throw new Error('File is missing');
        const key = keyFor(s, e, true);
        try {
          const out = blockWriter((block) => sink.write(block));
          await decryptChunkedStream(key, src, f.size, (plain) => out.add(plain.slice()));
          await out.flush();
        } finally {
          key.fill(0);
          src.close();
        }
      }
      await sink.commit();
    } catch (err) {
      await sink.abort();
      throw err;
    }
  });
}

/** URI of a file's blob, for native code. */
export function blobUri(s: Opened, id: string): string {
  return storedUri(path(s, `${id}.bin`));
}

// ---- upgrading old files ------------------------------------------------------------------------
/**
 * Re-encrypts files added before per-file keys (v1: one message under the vault key) into the
 * chunked format with a key of their own, one file per queued change so the user's own adds and
 * deletes are never held up for long. Stops after about `budgetBytes`; later unlocks continue.
 * Returns how many files were upgraded. Run after tidy(); it is safe to stop at any point.
 *
 * Per file: (1) the entry gets its new key (the blob is still v1, which readers recognise by size),
 * (2) the blob is replaced by its v2 form in one crash-safe swap, (3) filler of the new size goes
 * to the other folder and filler of the old size replaces the old blob here, so both folders keep
 * matching blob sizes (tidy() evens out whatever a kill left behind).
 */
export async function upgradeOldFiles(s: Opened, budgetBytes = 64 * 1024 * 1024): Promise<number> {
  let upgraded = 0;
  let spent = 0;
  while (spent < budgetBytes) {
    const size = await change(s, upgradeOne);
    if (size === 0) break;
    upgraded++;
    spent += size;
  }
  return upgraded;
}

/** Upgrades the first old-format file found; returns its old blob size, or 0 if none is left. */
async function upgradeOne(s: Opened): Promise<number> {
  const sizes = new Map((await disk.list(String(s.vault))).map((f) => [f.name, f.size]));
  for (let n = 0; n < SHARDS; n++) {
    const page = await readShard(s, n);
    const e = page.files.find((x) => {
      const size = sizes.get(`${x.id}.bin`);
      return size !== undefined && !isChunked(size);
    });
    if (!e) continue;
    const oldSize = sizes.get(`${e.id}.bin`)!;
    let entry = e;
    if (!entry.key) {
      const fresh = randombytes_buf(32);
      entry = { ...e, key: to_base64(fresh, B64) };
      fresh.fill(0);
      await saveShard(s, n, { files: page.files.map((x) => (x.id === e.id ? entry : x)), shred: page.shred });
    }
    const blob = await disk.read(path(s, `${e.id}.bin`));
    if (!blob) return 0;
    const plain = decryptBlob(s.fileKey, blob);
    const key = from_base64(entry.key!, B64);
    let fresh: Uint8Array;
    try {
      fresh = encryptChunked(key, plain);
    } finally {
      plain.fill(0);
      key.fill(0);
    }
    await disk.write(path(s, `${e.id}.bin`), fresh);
    await writeFiller(otherDir(s), fresh.length);
    await writeFiller(String(s.vault), oldSize);
    return oldSize;
  }
  return 0;
}

// ---- deleting and tidying ---------------------------------------------------------------------
export function removeFile(s: Opened, id: string): Promise<Entry[]> {
  return change(s, async (s) => {
    // Page first (entry and its key gone, blob marked), then the blob becomes filler, then the mark goes.
    const n = shardOf(id);
    const page = await readShard(s, n);
    const files = page.files.filter((e) => e.id !== id);
    await saveShard(s, n, { files, shred: [...page.shred, id] });
    await shredBlob(s, id);
    await saveShard(s, n, { files, shred: page.shred });
    return listOf(await readAll(s));
  });
}

/**
 * Run after each unlock. Finishes adds and deletes a kill interrupted (their blobs become
 * filler), removes half-written ".part" files, and adds filler until both folders hold the same
 * number of blobs of each size.
 */
export function tidy(s: Opened): Promise<void> {
  return change(s, async (s) => {
    // First finish replacements a kill interrupted: "<name>.new" is a complete new copy. Without
    // "<name>" it becomes "<name>" (opening it runs disk recovery); next to "<name>" it is stale.
    for (const dir of ['0', '1']) {
      const names = new Set((await disk.list(dir)).map((f) => f.name));
      for (const name of names) {
        if (!name.endsWith('.new')) continue;
        const base = name.slice(0, -'.new'.length);
        if (names.has(base)) await disk.remove(`${dir}/${name}`);
        else (await disk.open(`${dir}/${base}`))?.close();
      }
    }
    for (let n = 0; n < SHARDS; n++) {
      const page = await readShard(s, n);
      if (page.shred.length === 0) continue;
      for (const id of page.shred) await shredBlob(s, id);
      await saveShard(s, n, { files: page.files, shred: [] });
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

/** The size on disk of a file added now with `plainSize` bytes (for tests and estimates). */
export const storedSize = chunkedSize;
export { EMPTY_SHARD };
