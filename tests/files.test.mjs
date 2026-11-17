// lib/files.ts over the real lib/disk.ts (expo-file-system faked on a temp folder).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { Paths, control as fsControl, resetCrash } from './mocks/expo-file-system.mjs';
import { store as keychain } from './mocks/keychain.mjs';
import { enc } from './helpers.mjs';
import { from_base64 } from 'react-native-libsodium';
import { disk } from '../lib/disk.ts';
import { addFile, addFileFrom, addImageNative, exportTo, fileAccess, loadIndex, readFile, removeFile, resetLayoutCache, tidy, upgradeOldFiles } from '../lib/files.ts';
import { stripImageMetadata } from '../lib/strip.ts';
import { pathToFileURL } from 'node:url';
import { state as native } from './mocks/cube-native.mjs';
import {
  beginListRotation, blobSize, chunkedSize, decryptBlob, decryptChunked, EMPTY_SHARD, encryptBlob, finishListRotation, INDEX_MIN_BYTES,
  listKey, PAGE_MIN_BYTES, PAGES, pageName, pageOf, SHARD_MIN_BYTES, SHARDS, shardName,
} from '../lib/vault.ts';

const root = path.join(Paths.document.path, 'd');
const BLOB = /^[0-9a-f]{32}\.bin$/;
let s0, s1;

const clearListSecrets = () => { for (const k of [...keychain.keys()]) if (k.startsWith('app.cube.l')) keychain.delete(k); };
const secretOf = (service) => (keychain.has(service) ? from_base64(keychain.get(service).password) : null);
/** The list keys a vault's pages may be under right now: current, and pending mid-rotation. */
const listKeys = (s) => [secretOf(`app.cube.l${s.vault}`), secretOf(`app.cube.l${s.vault}.n`)].filter(Boolean).map((x) => listKey(s.fileKey, x));
const pagePath = (s, n) => path.join(root, String(s.vault), pageName(n));

function openPage(s, blob) {
  for (const k of listKeys(s)) {
    try {
      return JSON.parse(new TextDecoder().decode(decryptBlob(k, blob)));
    } catch {
      // not this key
    }
  }
  throw new Error('page does not open');
}
/** Writes a page straight to disk under the vault's current list key. */
function writePage(s, n, page) {
  const k = listKey(s.fileKey, secretOf(`app.cube.l${s.vault}`));
  fs.writeFileSync(pagePath(s, n), encryptBlob(k, enc(JSON.stringify(page)), PAGE_MIN_BYTES));
}

async function freshVaults() {
  resetCrash();
  resetLayoutCache();
  clearListSecrets();
  fs.rmSync(root, { recursive: true, force: true });
  s0 = { vault: 0, fileKey: crypto.getRandomValues(new Uint8Array(32)) };
  s1 = { vault: 1, fileKey: crypto.getRandomValues(new Uint8Array(32)) };
  for (const s of [s0, s1]) {   // the layout setup() writes
    await disk.mkdir(String(s.vault));
    const secret = await beginListRotation(s.vault);
    await finishListRotation(s.vault, secret);
    for (let n = 0; n < PAGES; n++) writePage(s, n, { files: [], shred: [] });
    for (let n = 0; n < SHARDS; n++) fs.writeFileSync(path.join(root, String(s.vault), shardName(n)), randomBytes(blobSize(0, SHARD_MIN_BYTES)));
    fs.writeFileSync(path.join(root, String(s.vault), 'i.bin'), randomBytes(blobSize(0, INDEX_MIN_BYTES)));
  }
  resetCrash();
}
beforeEach(freshVaults);

/** The decrypted pages of a vault, straight from disk. */
function pages(s) {
  return Array.from({ length: PAGES }, (_, n) => openPage(s, new Uint8Array(fs.readFileSync(pagePath(s, n)))));
}
const storedEntries = (s) => pages(s).flatMap((p) => p.files);

// Every file key that ever reached disk (collected at each disk step), so "unreadable" can be checked
// against all of them, not only the ones still listed.
const seenKeys = new Set();
function collectKeys(s) {
  try {
    for (const e of storedEntries(s)) if (e.key) seenKeys.add(e.key);
  } catch {
    // a page mid-write: the next step will see it whole
  }
}
/** Keys on one page file (and its .new copy), if it opens. */
function collectPage(s, file) {
  for (const f of [file, `${file}.new`]) {
    try {
      for (const e of openPage(s, new Uint8Array(fs.readFileSync(f))).files) if (e.key) seenKeys.add(e.key);
    } catch {
      // missing, torn, or not a page of this vault
    }
  }
}
/**
 * A disk-step hook that collects keys cheaply: a step fires before its operation runs, so each step
 * rereads only the page the previous step touched (decrypting all 64 pages per step was far too slow).
 */
function pageWatcher(s) {
  let dirty = null;
  return () => {
    if (dirty) collectPage(s, dirty);
    dirty = null;
    const last = fsControl.log[fsControl.log.length - 1] ?? '';
    const m = /(\d\/l[0-9a-f]{2}\.bin)/.exec(last);
    if (m) dirty = path.join(root, m[1]);
  };
}

const listDir = (d) => (fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)) : []);
const blobSizes = (d) =>
  listDir(d).filter((n) => BLOB.test(n)).map((n) => fs.statSync(path.join(root, d, n)).size).sort((a, b) => a - b);
const size = (p) => fs.statSync(path.join(root, p)).size;

/** Can `name` be decrypted with the vault key (v1) or any file key that ever reached disk (v2)? */
function readable(s, name) {
  const blob = new Uint8Array(fs.readFileSync(path.join(root, String(s.vault), name)));
  try {
    decryptBlob(s.fileKey, blob);
    return true;
  } catch {
    // not a v1 blob
  }
  for (const k of seenKeys) {
    try {
      decryptChunked(new Uint8Array(Buffer.from(k, 'base64')), blob);
      return true;
    } catch {
      // not this key
    }
  }
  return false;
}

/** What must hold after any crash plus tidy(): see lib/files.ts. */
async function assertInvariants(s) {
  const entries = await loadIndex(s);   // the index decrypts
  collectKeys(s);
  const ids = new Set(entries.map((e) => e.id));
  for (const e of entries) await readFile(s, e.id);   // every listed file opens
  for (const n of listDir(String(s.vault))) {
    if (BLOB.test(n) && readable(s, n)) assert.ok(ids.has(n.slice(0, 32)), `unlisted readable blob ${n}`);
    assert.ok(!n.endsWith('.part') && !n.endsWith('.new'), `left-over ${n}`);
  }
  assert.deepEqual(blobSizes('0'), blobSizes('1'), 'folders hold the same blob sizes');
  assert.equal(size('0/i.bin'), size('1/i.bin'));
  for (let n = 0; n < SHARDS; n++) assert.equal(size(`0/${shardName(n)}`), size(`1/${shardName(n)}`), `old page ${n}`);
  for (let n = 0; n < PAGES; n++) assert.equal(size(`0/${pageName(n)}`), size(`1/${pageName(n)}`), `page ${n}`);
  return entries;
}

describe('add, read, remove', () => {
  test('a file round-trips and its name only lives in the encrypted index', async () => {
    const bytes = new Uint8Array(randomBytes(70_000));
    const [e] = await addFile(s0, 'Tax return 2026.pdf', 'application/pdf', bytes);
    assert.match(e.id, /^[0-9a-f]{32}$/);
    assert.deepEqual(await readFile(s0, e.id), bytes);
    assert.deepEqual((await loadIndex(s0)).map((x) => x.name), ['Tax return 2026.pdf']);
    const onDisk = fs.readdirSync(root, { recursive: true }).join(' ');
    assert.ok(!onDisk.includes('Tax'), 'no real names on disk');
    await assertInvariants(s0);
  });

  test('each blob gets same-size filler in the other folder', async () => {
    await addFile(s0, 'a.jpg', 'image/jpeg', new Uint8Array(10));
    await addFile(s0, 'b.jpg', 'image/jpeg', new Uint8Array(100_000));
    await addFile(s1, 'c.txt', 'text/plain', new Uint8Array(5));
    assert.equal(blobSizes('0').length, 3);
    assert.deepEqual(blobSizes('0'), blobSizes('1'));
    assert.equal((await loadIndex(s1)).length, 1);
  });

  test('remove overwrites the blob with random bytes instead of deleting it', async () => {
    const [e] = await addFile(s0, 'secret.txt', 'text/plain', enc('hello'));
    const before = blobSizes('0');
    assert.deepEqual(await removeFile(s0, e.id), []);
    assert.deepEqual(blobSizes('0'), before, 'same count and sizes');
    assert.ok(!readable(s0, `${e.id}.bin`), 'old blob no longer decrypts');
    await assert.rejects(readFile(s0, e.id));
    await assertInvariants(s0);
  });

  test('a missing blob gives a clear error', async () => {
    await assert.rejects(readFile(s0, 'f'.repeat(32)), /File is missing/);
  });

  test('changes started together are all kept (serialised read-modify-write)', async () => {
    const [first] = await addFile(s0, 'first', 'text/plain', enc('1'));
    await Promise.all([
      addFile(s0, 'second', 'text/plain', enc('2')),
      removeFile(s0, first.id),
      addFile(s0, 'third', 'text/plain', enc('3')),
    ]);
    assert.deepEqual((await loadIndex(s0)).map((e) => e.name).sort(), ['second', 'third']);
    await assertInvariants(s0);
  });

  test('unicode, emoji and path-like names are stored verbatim', async () => {
    const names = ['фото.jpg', '😀 party.png', '../../etc/passwd', 'a"b\\c.txt'];
    for (const n of names) await addFile(s0, n, 'text/plain', enc(n));
    assert.deepEqual((await loadIndex(s0)).map((e) => e.name).reverse(), names);
  });

  test('both indexes stay the same size as files are added', async () => {
    for (let i = 0; i < 20; i++) await addFile(s0, `file-${i}-${'x'.repeat(60)}.jpg`, 'image/jpeg', enc('x'));
    assert.equal(size('0/i.bin'), size('1/i.bin'));
  });
});

describe('locking mid-operation', () => {
  // lock() zeroes the session key in place (lib/session.ts). An add, delete or tidy already
  // running must still finish with the real key, or it re-encrypts the index under zeros.
  for (const [name, op] of [
    ['addFile', (s) => addFile(s, 'late.bin', 'application/octet-stream', enc('late'))],
    ['removeFile', (s, id) => removeFile(s, id)],
  ]) {
    test(`${name}: the vault still opens after a lock during the operation`, async () => {
      const [e] = await addFile(s0, 'precious.jpg', 'image/jpeg', enc('precious'));
      const realKey = s0.fileKey.slice();
      fsControl.ops = 0;
      fsControl.onStep = (n) => n === 2 && s0.fileKey.fill(0);   // the app goes to the background
      await op(s0, e.id).catch(() => {});
      resetCrash();
      const reopened = { vault: 0, fileKey: realKey };
      const names = (await loadIndex(reopened)).map((x) => x.name);
      assert.ok(names.includes('precious.jpg') || name === 'removeFile', names.join());
      await assertInvariants(reopened);
    });
  }
});

test('a change requested after the lock is refused, not written with a zero key', async () => {
  const s = { vault: 0, fileKey: new Uint8Array(32) };
  await assert.rejects(addFile(s, 'x', 'text/plain', enc('x')), /locked/);
  await assert.rejects(removeFile(s, 'x'), /locked/);
  await assert.rejects(tidy(s), /locked/);
  await assertInvariants(s0);
});

describe('tidy', () => {
  test('removes .part leftovers and evens out the folders', async () => {
    fs.writeFileSync(path.join(root, '1', 'l03.bin.part'), 'half');
    fs.writeFileSync(path.join(root, '0', `${'a'.repeat(32)}.bin`), new Uint8Array(65_576));
    await tidy(s1);
    await assertInvariants(s1);
  });

  test('a missing page gets recreated (own folder) or filled with filler (other folder)', async () => {
    fs.rmSync(path.join(root, '0', 'l07.bin'));
    fs.rmSync(path.join(root, '1', 'l2a.bin'));
    fs.rmSync(path.join(root, '1', 'ia.bin'));
    await tidy(s0);
    assert.deepEqual(pages(s0)[7], { files: [], shred: [] });
    assert.equal(size('1/l2a.bin'), blobSize(0, PAGE_MIN_BYTES));
    assert.equal(size('1/ia.bin'), blobSize(0, SHARD_MIN_BYTES));
    await assertInvariants(s0);
  });
});

describe('migration from the single-file index', () => {
  /** A vault pair as older versions left it: one i.bin per vault, files as v1 blobs under the vault key. */
  async function legacyVaults(files) {
    fs.rmSync(root, { recursive: true, force: true });
    clearListSecrets();   // vaults from before list secrets
    for (const d of ['0', '1']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const made = [];
    for (const s of [s0, s1]) {
      const entries = [];
      for (const [name, text] of s === s0 ? files : []) {
        const id = randomBytes(16).toString('hex');
        const blob = encryptBlob(s.fileKey, enc(text));
        fs.writeFileSync(path.join(root, String(s.vault), `${id}.bin`), blob);
        fs.writeFileSync(path.join(root, String(1 - s.vault), `${randomBytes(16).toString('hex')}.bin`), randomBytes(blob.length));
        entries.push({ id, name, size: text.length, mime: 'text/plain', addedAt: entries.length });
        made.push({ id, name, text });
      }
      const index = enc(JSON.stringify({ files: entries, shred: [] }));
      fs.writeFileSync(path.join(root, String(s.vault), 'i.bin'), encryptBlob(s.fileKey, index, INDEX_MIN_BYTES));
    }
    return made;
  }

  test('entries move into the pages, old files still open, and i.bin becomes filler', async () => {
    const made = await legacyVaults([['a.txt', 'alpha'], ['b.txt', 'bravo'], ['c.txt', 'charlie']]);
    const listed = await loadIndex(s0);
    assert.deepEqual(listed.map((e) => e.name).sort(), ['a.txt', 'b.txt', 'c.txt']);
    for (const m of made) {
      assert.equal(new TextDecoder().decode(await readFile(s0, m.id)), m.text);
      assert.equal((await fileAccess(s0, m.id)).format, 1, 'old files keep the v1 format');
    }
    assert.throws(() => decryptBlob(s0.fileKey, new Uint8Array(fs.readFileSync(path.join(root, '0', 'i.bin')))));
    // The other folder got filler pages, so both folders hold the same names and sizes.
    assert.deepEqual(listDir('0').filter((n) => !BLOB.test(n)).sort(), listDir('1').filter((n) => !BLOB.test(n)).sort());
    await assertInvariants(s0);
  });

  test('the other vault migrates later, over the filler pages', async () => {
    await legacyVaults([['a.txt', 'alpha']]);
    await loadIndex(s0);
    assert.deepEqual(await loadIndex(s1), []);
    assert.deepEqual(pages(s1)[0], { files: [], shred: [] });
    assert.ok(secretOf('app.cube.l1') && !secretOf('app.cube.l1.n'), 'got its own list secret');
    await assertInvariants(s1);
    assert.equal((await loadIndex(s0)).length, 1);
  });

  test('a kill at any step of the migration loses nothing', async () => {
    await legacyVaults([['a.txt', 'alpha'], ['b.txt', 'bravo']]);
    const snapshot = fs.mkdtempSync(path.join(path.dirname(root), 'snap-'));
    fs.cpSync(root, snapshot, { recursive: true });
    fsControl.ops = 0;
    await loadIndex(s0);
    const steps = fsControl.ops;
    for (let k = 0; k < steps; k = k < DENSE ? k + 1 : k + STRIDE) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.cpSync(snapshot, root, { recursive: true });
      clearListSecrets();   // the Keychain as it was in the snapshot
      resetLayoutCache();   // a fresh process
      fsControl.ops = 0;
      fsControl.failAfter = k;
      await assert.rejects(loadIndex(s0), (e) => e.injected === true, `step ${k}`);
      resetCrash();
      resetLayoutCache();   // the restart after the kill
      assert.deepEqual((await loadIndex(s0)).map((e) => e.name).sort(), ['a.txt', 'b.txt'], `step ${k}`);
      await assertInvariants(s0);
    }
  });
});

describe('migration from the 16-page layout', () => {
  /** Vaults as the 16-page version left them: i0.bin … if.bin under the vault key, no list secret. */
  function sixteenPageVaults(entries) {
    fs.rmSync(root, { recursive: true, force: true });
    clearListSecrets();
    for (const s of [s0, s1]) {
      fs.mkdirSync(path.join(root, String(s.vault)), { recursive: true });
      const old = Array.from({ length: SHARDS }, () => ({ files: [], shred: [] }));
      for (const e of s === s0 ? entries : []) old[parseInt(e.id[0], 16)].files.push(e);
      old.forEach((p, n) => fs.writeFileSync(path.join(root, String(s.vault), shardName(n)), encryptBlob(s.fileKey, enc(JSON.stringify(p)), SHARD_MIN_BYTES)));
      fs.writeFileSync(path.join(root, String(s.vault), 'i.bin'), randomBytes(blobSize(0, INDEX_MIN_BYTES)));
    }
  }
  const entriesOf = (n) => Array.from({ length: n }, (_, i) => {
    const id = randomBytes(16).toString('hex');
    return { id, name: `f${i}`, size: 1, mime: 'text/plain', addedAt: i };
  });

  test('entries move to the 64 pages, old pages become filler, the vault gets a list secret', async () => {
    const entries = entriesOf(40);
    sixteenPageVaults(entries);
    assert.deepEqual((await loadIndex(s0)).map((e) => e.id).sort(), entries.map((e) => e.id).sort());
    for (const e of entries) assert.ok(pages(s0)[pageOf(e.id)].files.some((x) => x.id === e.id), 'on its page');
    for (let n = 0; n < SHARDS; n++) {
      assert.throws(() => decryptBlob(s0.fileKey, new Uint8Array(fs.readFileSync(path.join(root, '0', shardName(n))))), `i${n.toString(16)}.bin is filler`);
    }
    assert.ok(secretOf('app.cube.l0') && !secretOf('app.cube.l0.n'));
    const names = (d) => listDir(d).map((n) => `${n} ${size(`${d}/${n}`)}`).sort();
    assert.deepEqual(names('0'), names('1'), 'both folders hold the same names and sizes');
  });

  test('a kill at any step of the 16-page migration loses nothing', async () => {
    const entries = entriesOf(20);
    sixteenPageVaults(entries);
    const snapshot = fs.mkdtempSync(path.join(path.dirname(root), 'snap16-'));
    fs.cpSync(root, snapshot, { recursive: true });
    fsControl.ops = 0;
    await loadIndex(s0);
    const steps = fsControl.ops;
    for (let k = 0; k < steps; k = k < DENSE ? k + 1 : k + STRIDE) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.cpSync(snapshot, root, { recursive: true });
      clearListSecrets();
      resetLayoutCache();
      fsControl.ops = 0;
      fsControl.failAfter = k;
      await assert.rejects(loadIndex(s0), (e) => e.injected === true, `step ${k}`);
      resetCrash();
      resetLayoutCache();
      assert.deepEqual((await loadIndex(s0)).map((e) => e.id).sort(), entries.map((e) => e.id).sort(), `step ${k}`);
    }
  });
});

describe('list secret rotation on delete', () => {
  test('after a delete, an old copy of the page (holding the file key) opens with no key Cube still has', async () => {
    const [e] = await addFile(s0, 'secret.txt', 'text/plain', enc('secret'));
    await addFile(s0, 'stay.txt', 'text/plain', enc('stay'));
    const before = new Uint8Array(fs.readFileSync(pagePath(s0, pageOf(e.id))));
    const oldSecret = secretOf('app.cube.l0');
    assert.ok(openPage(s0, before).files.some((x) => x.id === e.id && x.key), 'the old page holds the file key');
    await removeFile(s0, e.id);
    const newSecret = secretOf('app.cube.l0');
    assert.notDeepEqual(newSecret, oldSecret, 'list secret replaced');
    assert.equal(secretOf('app.cube.l0.n'), null, 'nothing pending');
    assert.throws(() => openPage(s0, before), 'old page copy no longer opens');
    assert.throws(() => decryptBlob(s0.fileKey, before), 'nor with the vault key');
    assert.deepEqual((await loadIndex(s0)).map((x) => x.name), ['stay.txt']);
    await assertInvariants(s0);
  });

  test('a rotation a kill interrupted is finished by the next change', async () => {
    await addFile(s0, 'a.txt', 'text/plain', enc('a'));
    const pending = await beginListRotation(0);   // as if killed right after storing the next secret
    assert.equal((await loadIndex(s0)).length, 1);
    assert.deepEqual(secretOf('app.cube.l0'), pending, 'pending became current');
    assert.equal(secretOf('app.cube.l0.n'), null);
    await assertInvariants(s0);
  });
});

describe('per-file keys and streaming', () => {
  /** A Source over bytes that returns short reads, like a real file handle may. */
  const sourceOf = (bytes, step = 40_000) => {
    let at = 0;
    return { read: async (n) => { const out = bytes.slice(at, at + Math.min(n, step)); at += out.length; return out; }, close() {} };
  };

  test('every new file has its own key; a left-over blob is unreadable with the vault key', async () => {
    const [a] = await addFile(s0, 'a.txt', 'text/plain', enc('alpha'));
    const [b] = await addFile(s0, 'b.txt', 'text/plain', enc('bravo'));
    const stored = storedEntries(s0);
    const ka = stored.find((e) => e.id === a.id).key, kb = stored.find((e) => e.id === b.id).key;
    assert.ok(ka && kb && ka !== kb);
    const blob = new Uint8Array(fs.readFileSync(path.join(root, '0', `${a.id}.bin`)));
    assert.throws(() => decryptBlob(s0.fileKey, blob));
    assert.throws(() => decryptChunked(s0.fileKey, blob));
    assert.equal(new TextDecoder().decode(decryptChunked(new Uint8Array(Buffer.from(ka, 'base64')), blob)), 'alpha');
    assert.equal((await loadIndex(s0)).some((e) => 'key' in e), false, 'keys never leave lib/files');
    await removeFile(s0, a.id);
    assert.ok(!storedEntries(s0).some((e) => e.key === ka), 'the key goes with the entry');
  });

  test('streamed adds round-trip at chunk boundaries and export streams the same bytes', async () => {
    for (const n of [0, 1, 65_535, 65_536, 65_537, 300_001]) {
      const bytes = new Uint8Array(randomBytes(n));
      const [e] = await addFileFrom(s0, `f${n}`, 'application/octet-stream', sourceOf(bytes));
      assert.equal(e.size, n);
      assert.equal(size(`0/${e.id}.bin`), chunkedSize(n));
      assert.deepEqual(await readFile(s0, e.id), bytes);
      const parts = [];
      await exportTo(s0, e.id, { write: async (b) => void parts.push(Buffer.from(b)), commit: async () => {}, abort: async () => {} });
      assert.deepEqual(new Uint8Array(Buffer.concat(parts)), bytes);
    }
    await assertInvariants(s0);
  });

  test('a failing source leaves no trace but filler', async () => {
    const bad = { read: async () => { throw new Error('provider gone'); }, close() {} };
    await assert.rejects(addFileFrom(s0, 'x', 'application/octet-stream', bad), /provider gone/);
    assert.deepEqual(await loadIndex(s0), []);
    await assertInvariants(s0);
  });

  test('fileAccess gives native code the blob, its format and the right key', async () => {
    const [e] = await addFile(s0, 'p.jpg', 'image/jpeg', enc('jpeg'));
    const a = await fileAccess(s0, e.id);
    assert.equal(a.format, 2);
    assert.match(a.uri, new RegExp(`/0/${e.id}\\.bin$`));
    assert.equal(new TextDecoder().decode(decryptChunked(a.key, new Uint8Array(fs.readFileSync(path.join(root, '0', `${e.id}.bin`))))), 'jpeg');
    await assert.rejects(fileAccess(s0, 'f'.repeat(32)), /missing/);
  });
});

describe('native photo import', () => {
  test('the photo is stored cleaned and encrypted, without passing through JavaScript in the app', async () => {
    const photo = path.join(Paths.cache.path, 'pick.jpg');
    const bytes = new Uint8Array(fs.readFileSync(new URL('./fixtures/photo.jpg', import.meta.url)));
    fs.writeFileSync(photo, bytes);
    const [e] = await addImageNative(s0, 'photo.jpg', 'image/jpeg', pathToFileURL(photo).href);
    assert.deepEqual(await readFile(s0, e.id), stripImageMetadata(bytes.slice()), 'stored exactly as cleaned');
    assert.ok(!Buffer.from(await readFile(s0, e.id)).includes('CubeTest'), 'no camera details');
    assert.equal(size(`0/${e.id}.bin`), chunkedSize(e.size));
    assert.ok(fs.existsSync(photo), 'the picked file itself is left alone');
    fs.rmSync(photo);
    await assertInvariants(s0);
  });

  test('a failed import leaves no trace but filler', async () => {
    const photo = path.join(Paths.cache.path, 'pick2.jpg');
    fs.writeFileSync(photo, new Uint8Array(fs.readFileSync(new URL('./fixtures/photo.jpg', import.meta.url))));
    native.importError = 'E_IMPORT';
    await assert.rejects(addImageNative(s0, 'x.jpg', 'image/jpeg', pathToFileURL(photo).href), /E_IMPORT/);
    native.importError = null;
    fs.rmSync(photo);
    assert.deepEqual(await loadIndex(s0), []);
    await tidy(s0);
    await assertInvariants(s0);
  });
});

describe('upgrading old-format files', () => {
  /** Puts a file in the pre-per-file-key format straight onto disk: v1 blob under the vault key, entry without a key. */
  function addV1(s, name, bytes, { key } = {}) {
    const id = randomBytes(16).toString('hex');
    const blob = encryptBlob(s.fileKey, bytes);
    fs.writeFileSync(path.join(root, String(s.vault), `${id}.bin`), blob);
    fs.writeFileSync(path.join(root, String(1 - s.vault), `${randomBytes(16).toString('hex')}.bin`), randomBytes(blob.length));
    const n = pageOf(id);
    const page = pages(s)[n];
    page.files.unshift({ id, name, size: bytes.length, mime: 'application/octet-stream', addedAt: Date.now(), ...(key ? { key } : {}) });
    writePage(s, n, page);
    return id;
  }

  test('old files move to their own key and the chunked format, unchanged in content', async () => {
    const files = [[70_000], [1], [200_000]].map(([n]) => new Uint8Array(randomBytes(n)));
    const ids = files.map((b, i) => addV1(s0, `old-${i}`, b));
    for (const id of ids) assert.equal((await fileAccess(s0, id)).format, 1);
    assert.equal(await upgradeOldFiles(s0), 3);
    for (const [i, id] of ids.entries()) {
      const a = await fileAccess(s0, id);
      a.key.fill(0);
      assert.equal(a.format, 2, 'now chunked');
      assert.equal(size(`0/${id}.bin`), chunkedSize(files[i].length));
      assert.deepEqual(await readFile(s0, id), files[i]);
      assert.ok(storedEntries(s0).find((e) => e.id === id).key, 'has its own key');
    }
    assert.equal(await upgradeOldFiles(s0), 0, 'nothing left');
    await tidy(s0);
    await assertInvariants(s0);
  });

  test('a small budget upgrades a few files per run; later runs continue', async () => {
    for (let i = 0; i < 3; i++) addV1(s0, `old-${i}`, new Uint8Array(randomBytes(1000)));
    assert.equal(await upgradeOldFiles(s0, 1), 1);
    assert.equal(await upgradeOldFiles(s0, 1), 1);
    assert.equal(await upgradeOldFiles(s0), 1);
    assert.equal(await upgradeOldFiles(s0), 0);
  });

  test('an entry whose key landed before its blob was upgraded still opens, and finishes upgrading', async () => {
    const bytes = new Uint8Array(randomBytes(5000));
    const id = addV1(s0, 'half', bytes, { key: Buffer.from(randomBytes(32)).toString('base64') });
    const a = await fileAccess(s0, id);
    a.key.fill(0);
    assert.equal(a.format, 1, 'format follows the blob size, not the key');
    assert.deepEqual(await readFile(s0, id), bytes);
    assert.equal(await upgradeOldFiles(s0), 1);
    assert.deepEqual(await readFile(s0, id), bytes);
  });
});

/**
 * Runs op once to count its disk steps, then crashes it at each step and checks recovery: every one
 * of the first DENSE steps (where an operation's own logic lives), then every STRIDE-th step (the
 * long, uniform tail: a list rotation rewrites all 64 pages the same way).
 */
const DENSE = 40;
const STRIDE = 5;
async function crashAtEveryStep(prepare, op, check) {
  await freshVaults();
  const ctx = await prepare();
  fsControl.ops = 0;
  await op(ctx);
  const steps = fsControl.ops;
  assert.ok(steps > 5, `counted ${steps} steps`);
  for (let k = 0; k < steps; k = k < DENSE ? k + 1 : k + STRIDE) {
    await freshVaults();
    seenKeys.clear();
    const c = await prepare();
    fsControl.ops = 0;
    fsControl.failAfter = k;
    fsControl.onStep = pageWatcher(c.s);
    await assert.rejects(op(c), (e) => e.injected === true, `step ${k}`);
    collectKeys(c.s);
    resetCrash();   // "restart": the next launch unlocks and runs tidy()
    resetLayoutCache();   // a new process checks the layout again
    await tidy(c.s);
    const entries = await assertInvariants(c.s);
    await check(c, entries, k);
  }
  return steps;
}

describe('crash safety (process killed at every disk step)', () => {
  test('addFile: afterwards the file is either fully there or leaves only filler', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1000));
    const steps = await crashAtEveryStep(
      async () => {
        await addFile(s0, 'keep.txt', 'text/plain', enc('keep'));
        return { s: s0 };
      },
      (c) => addFile(c.s, 'new.bin', 'application/octet-stream', bytes),
      async (c, entries) => {
        assert.ok(entries.some((e) => e.name === 'keep.txt'), 'existing file survives');
        const added = entries.find((e) => e.name === 'new.bin');
        if (added) assert.deepEqual(await readFile(c.s, added.id), bytes);
      },
    );
    assert.ok(steps >= 10);
  });

  test('removeFile: afterwards the file is either still listed and readable or unreadable', async () => {
    await crashAtEveryStep(
      async () => {
        const [e] = await addFile(s0, 'gone.txt', 'text/plain', enc('bye'));
        await addFile(s0, 'stay.txt', 'text/plain', enc('stay'));
        return { s: s0, id: e.id };
      },
      (c) => removeFile(c.s, c.id),
      async (c, entries) => {
        assert.ok(entries.some((e) => e.name === 'stay.txt'));
        if (!entries.some((e) => e.id === c.id)) assert.ok(!readable(c.s, `${c.id}.bin`));
      },
    );
  });

  test('upgradeOldFiles: an old file stays readable whatever step a kill hits', async () => {
    const bytes = new Uint8Array(randomBytes(90_000));
    await crashAtEveryStep(
      async () => {
        const id = randomBytes(16).toString('hex');
        const blob = encryptBlob(s0.fileKey, bytes);
        fs.writeFileSync(path.join(root, '0', `${id}.bin`), blob);
        fs.writeFileSync(path.join(root, '1', `${randomBytes(16).toString('hex')}.bin`), randomBytes(blob.length));
        const page = pages(s0)[pageOf(id)];
        page.files.push({ id, name: 'old.bin', size: bytes.length, mime: 'application/octet-stream', addedAt: 1 });
        writePage(s0, pageOf(id), page);
        return { s: s0, id };
      },
      (c) => upgradeOldFiles(c.s),
      async (c, entries) => {
        assert.ok(entries.some((e) => e.id === c.id), 'still listed');
        assert.deepEqual(await readFile(c.s, c.id), bytes);
      },
    );
  });

  test('addFileFrom (streamed, several chunks): the file is fully there or leaves only filler', async () => {
    const bytes = new Uint8Array(randomBytes(150_000));
    await crashAtEveryStep(
      async () => ({ s: s0 }),
      (c) => addFileFrom(c.s, 'big.bin', 'application/octet-stream', {
        at: 0,
        async read(n) { const out = bytes.slice(this.at, this.at + n); this.at += out.length; return out; },
        close() {},
      }),
      async (c, entries) => {
        const added = entries.find((e) => e.name === 'big.bin');
        if (added) assert.deepEqual(await readFile(c.s, added.id), bytes);
      },
    );
  });
});
