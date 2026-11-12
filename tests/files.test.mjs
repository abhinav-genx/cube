// lib/files.ts over the real lib/disk.ts (expo-file-system faked on a temp folder).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { Paths, control as fsControl, resetCrash } from './mocks/expo-file-system.mjs';
import { enc } from './helpers.mjs';
import { disk } from '../lib/disk.ts';
import { addFile, loadIndex, readFile, removeFile, tidy } from '../lib/files.ts';
import { decryptBlob, encryptBlob, INDEX_MIN_BYTES } from '../lib/vault.ts';

const root = path.join(Paths.document.path, 'd');
const BLOB = /^[0-9a-f]{32}\.bin$/;
let s0, s1;

async function freshVaults() {
  resetCrash();
  fs.rmSync(root, { recursive: true, force: true });
  s0 = { vault: 0, fileKey: crypto.getRandomValues(new Uint8Array(32)) };
  s1 = { vault: 1, fileKey: crypto.getRandomValues(new Uint8Array(32)) };
  for (const s of [s0, s1]) {
    await disk.mkdir(String(s.vault));
    await disk.write(`${s.vault}/i.bin`, encryptBlob(s.fileKey, enc('{"files":[],"shred":[]}'), INDEX_MIN_BYTES));
  }
  resetCrash();
}
beforeEach(freshVaults);

const listDir = (d) => (fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)) : []);
const blobSizes = (d) =>
  listDir(d).filter((n) => BLOB.test(n)).map((n) => fs.statSync(path.join(root, d, n)).size).sort((a, b) => a - b);
const size = (p) => fs.statSync(path.join(root, p)).size;

function readable(s, name) {
  try {
    decryptBlob(s.fileKey, new Uint8Array(fs.readFileSync(path.join(root, String(s.vault), name))));
    return true;
  } catch {
    return false;
  }
}

/** What must hold after any crash plus tidy(): see lib/files.ts. */
async function assertInvariants(s) {
  const entries = await loadIndex(s);   // the index decrypts
  const ids = new Set(entries.map((e) => e.id));
  for (const e of entries) await readFile(s, e.id);   // every listed file opens
  for (const n of listDir(String(s.vault))) {
    if (BLOB.test(n) && readable(s, n)) assert.ok(ids.has(n.slice(0, 32)), `unlisted readable blob ${n}`);
    assert.ok(!n.endsWith('.part'), `left-over ${n}`);
  }
  assert.deepEqual(blobSizes('0'), blobSizes('1'), 'folders hold the same blob sizes');
  assert.equal(size('0/i.bin'), size('1/i.bin'));
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
  test('pads an index written before padding existed', async () => {
    await disk.write('0/i.bin', encryptBlob(s0.fileKey, enc('{"files":[]}')));
    assert.ok(size('0/i.bin') < size('1/i.bin'));
    await tidy(s0);
    assert.equal(size('0/i.bin'), size('1/i.bin'));
  });

  test('removes .part leftovers and evens out the folders', async () => {
    fs.writeFileSync(path.join(root, '1', 'i.bin.part'), 'half');
    fs.writeFileSync(path.join(root, '0', `${'a'.repeat(32)}.bin`), new Uint8Array(65_576));
    await tidy(s1);
    await assertInvariants(s1);
  });

  test('does nothing when this vault has no index', async () => {
    fs.rmSync(path.join(root, '0', 'i.bin'));
    await tidy(s0);
    assert.deepEqual(listDir('0'), []);
  });
});

/** Runs op once to count its disk steps, then crashes it at every step and checks recovery. */
async function crashAtEveryStep(prepare, op, check) {
  await freshVaults();
  const ctx = await prepare();
  fsControl.ops = 0;
  await op(ctx);
  const steps = fsControl.ops;
  assert.ok(steps > 5, `counted ${steps} steps`);
  for (let k = 0; k < steps; k++) {
    await freshVaults();
    const c = await prepare();
    fsControl.ops = 0;
    fsControl.failAfter = k;
    await assert.rejects(op(c), (e) => e.injected === true, `step ${k}`);
    resetCrash();   // "restart": the next launch unlocks and runs tidy()
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
});
