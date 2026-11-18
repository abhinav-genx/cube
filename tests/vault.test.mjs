import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import CubeNative, { resetNative, state as native } from './mocks/cube-native.mjs';
import { control as keychainControl, store as keychain } from './mocks/keychain.mjs';
import { MemDisk, freshVault, pin, time } from './helpers.mjs';
import { from_base64 } from 'react-native-libsodium';

const A = '135790', B = '246802', C = '975310';
const HEADER_BYTES = 320, SLOT = 76, SALT = 16;
const INDEX_BLOB = 24 + 256 * 1024 + 16;
const PAGE_BLOB = 24 + 64 * 1024 + 16;

let V, disk;
beforeEach(async () => {
  resetNative();
  keychain.clear();
  keychainControl.failSet = false;
  V = await freshVault();
  disk = new MemDisk();
});

async function makeVault() {
  await V.setup(pin(A), pin(B), pin(C), disk);
}
const counter = async () => new DataView((await disk.read('a.bin')).buffer).getUint32(0);
const listSecret = (vault) => from_base64(keychain.get(`app.cube.l${vault}`).password);
/** The vault's file list: all pages merged, decrypted with its list key. */
const readIndex = async (o) => {
  const out = { files: [], shred: [] };
  const lk = V.listKey(o.fileKey, listSecret(o.vault));
  for (let n = 0; n < V.PAGES; n++) {
    const page = JSON.parse(new TextDecoder().decode(V.decryptBlob(lk, await disk.read(`${o.vault}/${V.pageName(n)}`))));
    out.files.push(...page.files);
    out.shred.push(...page.shred);
  }
  return out;
};

describe('setup', () => {
  test('writes a fixed-size header, a zeroed counter and two identical sets of padded pages', async () => {
    await makeVault();
    assert.equal((await disk.read('h.bin')).length, HEADER_BYTES);
    assert.equal(await counter(), 0);
    for (const dir of ['0', '1']) {
      for (let n = 0; n < V.PAGES; n++) assert.equal((await disk.read(`${dir}/${V.pageName(n)}`)).length, PAGE_BLOB);
      for (let n = 0; n < V.SHARDS; n++) assert.equal(await disk.read(`${dir}/${V.shardName(n)}`), null, 'no old-layout files');
      assert.equal(await disk.read(`${dir}/i.bin`), null);
    }
    assert.ok(keychain.has('app.cube.l0') && keychain.has('app.cube.l1'), 'both vaults have a list secret');
    assert.ok(keychain.has('app.cube.v0') && keychain.has('app.cube.v1'));
    assert.ok(!keychain.has('app.cube.k0'), 'no master secret when the hardware key exists');
  });

  test('asks for the system prompt once per PIN (per-use auth key)', async () => {
    await makeVault();
    assert.equal(native.authCalls, 3);
    assert.equal(native.macCalls, 3);
    const k = native.keys.get('app.cube.h0');
    assert.equal(k.requireAuth, true);
    assert.equal(k.requireHardware, true);
  });

  test('zeroes the PIN arrays it was given', async () => {
    const pins = [pin(A), pin(B), pin(C)];
    await V.setup(...pins, disk);
    for (const p of pins) assert.ok(p.every((b) => b === 0));
  });

  test('refuses equal PINs', async () => {
    await assert.rejects(V.setup(pin(A), pin(A), pin(C), disk), /PINs must differ/);
    await assert.rejects(V.setup(pin(A), pin(B), pin(B), disk), /PINs must differ/);
  });

  test('refuses to run over an existing vault', async () => {
    await makeVault();
    await assert.rejects(V.setup(pin('111111'), pin('222222'), pin('333333'), disk), /already exists/);
  });

  test('a phone without a lock screen gets an error and no header', async () => {
    native.createError = 'E_NO_LOCK_SCREEN';
    await assert.rejects(makeVault(), /E_NO_LOCK_SCREEN/);
    assert.equal(await disk.read('h.bin'), null);
  });

  test('a failed keychain write aborts setup before the header', async () => {
    keychainControl.failSet = true;
    await assert.rejects(makeVault(), /secure hardware/);
    assert.equal(await disk.read('h.bin'), null);
  });

  test('a crash before the header leaves no vault, and setup can run again', async () => {
    disk.failWrite = (p) => p === 'h.bin';
    await assert.rejects(makeVault());
    disk.failWrite = null;
    assert.equal(await disk.read('h.bin'), null);
    await makeVault();
    assert.equal((await V.unlock(pin(A), disk)).fileKey.length, 32);
  });
});

describe('unlock', () => {
  test('PIN A and PIN B open different vaults, each with a stable key', async () => {
    await makeVault();
    const a1 = await V.unlock(pin(A), disk);
    const b1 = await V.unlock(pin(B), disk);
    const a2 = await V.unlock(pin(A), disk);
    assert.notEqual(a1.vault, b1.vault);
    assert.deepEqual(a1, a2);
    assert.notDeepEqual(a1.fileKey, b1.fileKey);
    assert.deepEqual(await readIndex(a1), { files: [], shred: [] });
    assert.deepEqual(await readIndex(b1), { files: [], shred: [] });
  });

  test('a wrong PIN throws WrongPin and counts; a right PIN resets the count', async () => {
    await makeVault();
    await assert.rejects(V.unlock(pin('000000'), disk), V.WrongPin);
    await assert.rejects(V.unlock(pin('13579'), disk), V.WrongPin);   // a prefix of PIN A
    assert.equal(await counter(), 2);
    await V.unlock(pin(B), disk);
    assert.equal(await counter(), 0);
  });

  test('zeroes the PIN it was given, right or wrong', async () => {
    await makeVault();
    for (const p of [pin(A), pin('000000')]) {
      await V.unlock(p, disk).catch(() => {});
      assert.ok(p.every((b) => b === 0));
    }
  });

  test('every attempt rewrites the header, wrong PINs included', async () => {
    await makeVault();
    const before = disk.writes.filter((p) => p === 'h.bin').length;
    await V.unlock(pin(A), disk);
    await V.unlock(pin(B), disk);
    await V.unlock(pin('000000'), disk).catch(() => {});
    assert.equal(disk.writes.filter((p) => p === 'h.bin').length, before + 3);
  });

  test('no header at all looks like a wrong PIN', async () => {
    CubeNative.createKey('app.cube.h0', true, true);
    await assert.rejects(V.unlock(pin(A), disk), V.WrongPin);
  });

  test('a cancelled system prompt rejects without counting a failure', async () => {
    await makeVault();
    native.authError = 'E_AUTH_CANCELLED';
    await assert.rejects(V.unlock(pin(A), disk), /E_AUTH_CANCELLED/);
    assert.equal(await counter(), 0);
  });

  test('the vault is bound to this phone: the same files with another hardware key open nothing', async () => {
    await makeVault();
    native.keys.clear();
    CubeNative.createKey('app.cube.h0', true, true);
    await assert.rejects(V.unlock(pin(A), disk), V.WrongPin);
    await assert.rejects(V.unlock(pin(B), disk), V.WrongPin);
  });

  test('takes the same time for right, decoy, wipe and wrong PINs (at least 1.5 s)', async (t) => {
    // The 1.5 s floor can only hide differences while one Argon2id fits well inside it. On a
    // loaded machine (parallel builds, a slow CI runner) it may not, and the test proves nothing.
    const sodium = await import('react-native-libsodium');
    const t0 = performance.now();
    sodium.crypto_pwhash(32, pin('probe'), new Uint8Array(16), 3, 64 * 1024 * 1024, sodium.crypto_pwhash_ALG_ARGON2ID13);
    const argon = performance.now() - t0;
    if (argon > 1000) return t.skip(`one Argon2id took ${Math.round(argon)} ms here; too close to the 1.5 s floor to measure`);
    await makeVault();
    const runs = [];
    for (const p of [A, '000000', B, C]) runs.push(await time(() => V.unlock(pin(p), disk)));
    const ms = runs.map((r) => r.ms);
    assert.ok(Math.min(...ms) >= 1490, `fastest ${Math.min(...ms)} ms`);
    assert.ok(Math.max(...ms) - Math.min(...ms) < 150, `spread ${ms.map(Math.round)}`);
  });

  test('passphrases are just longer byte strings (UTF-8, spaces, emoji)', async () => {
    const p1 = 'river stone lamp', p2 = 'naïve café 🔐', p3 = 'x'.repeat(200);
    await V.setup(pin(p1), pin(p2), pin(p3), disk);
    const a = await V.unlock(pin(p1), disk);
    const b = await V.unlock(pin(p2), disk);
    assert.notEqual(a.vault, b.vault);
    await assert.rejects(V.unlock(pin('river stone lamp '), disk), V.WrongPin);
  });
});

describe('PIN C (wipe)', () => {
  test('opens vault B, destroys vault A for good, and leaves B intact', async () => {
    await makeVault();
    const a = await V.unlock(pin(A), disk);
    const b = await V.unlock(pin(B), disk);
    const headerBefore = await disk.read('h.bin');
    const secretBefore = keychain.get(`app.cube.v${a.vault}`).password;
    const listBefore = keychain.get(`app.cube.l${a.vault}`).password;
    const listB = keychain.get(`app.cube.l${b.vault}`).password;

    const c = await V.unlock(pin(C), disk);
    assert.deepEqual(c, b, 'PIN C opens exactly what PIN B opens');
    await assert.rejects(V.unlock(pin(A), disk), V.WrongPin);
    assert.deepEqual(await V.unlock(pin(B), disk), b);
    assert.notEqual(keychain.get(`app.cube.v${a.vault}`).password, secretBefore, 'wiped vault secret rotated');
    assert.notEqual(keychain.get(`app.cube.l${a.vault}`).password, listBefore, 'wiped vault list secret replaced');
    assert.equal(keychain.get(`app.cube.l${b.vault}`).password, listB, 'vault B list secret untouched');

    const headerAfter = await disk.read('h.bin');
    assert.equal(headerAfter.length, HEADER_BYTES);
    const changed = [0, 1, 2, 3].filter((i) => {
      const s = SALT + i * SLOT;
      return !headerBefore.subarray(s, s + SLOT).every((v, j) => v === headerAfter[s + j]);
    });
    assert.equal(changed.length, 1, 'exactly one slot (A) replaced with random bytes');
    assert.deepEqual(headerBefore.subarray(0, SALT), headerAfter.subarray(0, SALT));
  });

  test('a second PIN C is harmless and still opens B', async () => {
    await makeVault();
    const b = await V.unlock(pin(B), disk);
    await V.unlock(pin(C), disk);
    assert.deepEqual(await V.unlock(pin(C), disk), b);
  });

  test('if the wipe cannot be written, unlock fails instead of opening B', async () => {
    await makeVault();
    disk.failWrite = (p) => p === 'h.bin';
    await assert.rejects(V.unlock(pin(C), disk), /disk error/);
  });

  test('restoring a pre-wipe copy of the files does not bring vault A back', async () => {
    await makeVault();
    const a = await V.unlock(pin(A), disk);
    const copy = disk.snapshot();   // forensic image / backup taken before the wipe
    await V.unlock(pin(C), disk);
    disk.restore(copy);
    const again = await V.unlock(pin(A), disk);   // the old header still has slot A …
    assert.notDeepEqual(again.fileKey, a.fileKey);   // … but the vault secret is gone
    assert.throws(() => V.decryptBlob(V.listKey(again.fileKey, listSecret(a.vault)), copy.get(`${a.vault}/l00.bin`)));
  });
});

describe('attempt delay', () => {
  test('4 free tries, then 30 s, 1 min, 5 min, 15 min, 1 h', () => {
    assert.deepEqual(
      [0, 1, 4, 5, 6, 7, 8, 9, 10, 50].map(V.delayAfter),
      [0, 0, 0, 30e3, 60e3, 300e3, 900e3, 3600e3, 3600e3, 3600e3],
    );
  });

  test('the fifth wrong PIN starts a 30 s wait that refuses even the right PIN', async () => {
    await makeVault();
    for (let i = 0; i < 4; i++) await assert.rejects(V.unlock(pin('000000'), disk), V.WrongPin);
    assert.equal(await V.unlockWaitMs(disk), 0);
    await assert.rejects(V.unlock(pin('000000'), disk), V.WrongPin);
    const wait = await V.unlockWaitMs(disk);
    // counted from when the failure was saved; the attempt's own 1.5 s minimum runs after that
    assert.ok(wait > 28_000 && wait <= 30_000, `wait ${wait}`);
    const p = pin(A);
    await assert.rejects(V.unlock(p, disk), (e) => e instanceof V.TooSoon && e.waitMs > 28_000);
    assert.ok(p.every((b) => b === 0), 'refused PIN still zeroed');
    assert.equal(native.authCalls, 3 + 5, 'no prompt while waiting');
  });

  test('the count survives an app restart', async () => {
    await makeVault();
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, 7);
    await disk.write('a.bin', b);
    const restarted = await freshVault();
    const wait = await restarted.unlockWaitMs(disk);
    assert.ok(wait > 290_000 && wait <= 300_000, `wait ${wait}`);
    await assert.rejects(restarted.unlock(pin(A), disk), restarted.TooSoon);
  });

  test('a missing or short counter file means no failures', async () => {
    await disk.write('a.bin', new Uint8Array(2));
    assert.equal(await V.unlockWaitMs(disk), 0);
  });
});

describe('master-secret keyer (no native module)', () => {
  test('setup stores a master secret and unlock works', async () => {
    native.hw = false;
    await makeVault();
    assert.ok(keychain.has('app.cube.k0'));
    assert.equal(native.macCalls, 0);
    const a = await V.unlock(pin(A), disk);
    const b = await V.unlock(pin(B), disk);
    assert.notEqual(a.vault, b.vault);
  });

  test('without the master secret every PIN is wrong', async () => {
    native.hw = false;
    await makeVault();
    keychain.delete('app.cube.k0');
    await assert.rejects(V.unlock(pin(A), disk), V.WrongPin);
  });

  test('an older master-secret vault keeps working once the native module appears', async () => {
    native.hw = false;
    await makeVault();
    native.hw = true;   // app update adds the module; no hardware key was ever created
    assert.equal((await V.unlock(pin(A), disk)).fileKey.length, 32);
  });
});

describe('wipeEverything', () => {
  test('deletes keys and folders; no PIN opens anything afterwards', async () => {
    await makeVault();
    await V.wipeEverything(disk);
    assert.equal(native.keys.size, 0);
    assert.ok(!keychain.has('app.cube.v0') && !keychain.has('app.cube.v1'));
    assert.ok(![...keychain.keys()].some((k) => k.startsWith('app.cube.l')), 'list secrets gone');
    assert.equal(await disk.read('0/i.bin'), null);
    CubeNative.createKey('app.cube.h0', true, true);
    for (const p of [A, B, C]) await assert.rejects(V.unlock(pin(p), disk), V.WrongPin);
  });
});

describe('blob encryption', () => {
  const key = new Uint8Array(32).fill(7);
  const sizes = [0, 1, 65_534, 65_535, 65_536, 200_000];

  test('round-trips, including data ending in 0x00 or 0x80 bytes', () => {
    const samples = [
      ...sizes.map((n) => crypto.getRandomValues(new Uint8Array(Math.min(n, 65_536))).subarray(0, n)),
      new Uint8Array([0x80]),
      new Uint8Array([0x80, 0, 0]),
      new Uint8Array([1, 2, 0x80, 0x80]),
      new Uint8Array(70_000),
    ];
    for (const plain of samples) assert.deepEqual(V.decryptBlob(key, V.encryptBlob(key, plain)), plain);
  });

  test('pads to whole 64 KiB blocks and blobSize() predicts the size', () => {
    for (const n of sizes) {
      const blob = V.encryptBlob(key, new Uint8Array(n));
      assert.equal(blob.length, V.blobSize(n));
      assert.equal((blob.length - 40) % 65_536, 0);
    }
    assert.equal(V.encryptBlob(key, new Uint8Array(10), V.INDEX_MIN_BYTES).length, INDEX_BLOB);
    assert.equal(V.blobSize(65_535), V.blobSize(0));
    assert.equal(V.blobSize(65_536), V.blobSize(0) + 65_536);
  });

  test('two encryptions of the same file differ (fresh nonce)', () => {
    const p = new Uint8Array(100);
    assert.notDeepEqual(V.encryptBlob(key, p), V.encryptBlob(key, p));
  });

  test('tampering, truncation or the wrong key is rejected', () => {
    const blob = V.encryptBlob(key, new Uint8Array([1, 2, 3]));
    for (const i of [0, 30, blob.length - 1]) {
      const t = blob.slice();
      t[i] ^= 1;
      assert.throws(() => V.decryptBlob(key, t));
    }
    assert.throws(() => V.decryptBlob(key, blob.subarray(0, blob.length - 1)));
    assert.throws(() => V.decryptBlob(new Uint8Array(32), blob));
  });
});

describe('chunked file format (v2)', () => {
  const key = new Uint8Array(32).fill(5);
  const rand = (n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 7919 + 13) & 0xff));

  test('round-trips at every chunk boundary; chunkedSize predicts the size', () => {
    for (const n of [0, 1, 1000, 65_535, 65_536, 65_537, 131_072, 200_000]) {
      const plain = rand(n);
      const blob = V.encryptChunked(key, plain);
      assert.equal(blob.length, V.chunkedSize(n), `size for ${n}`);
      assert.equal(V.chunkCount(blob.length), Math.ceil((n + 1) / 65_536));
      assert.deepEqual(V.decryptChunked(key, blob), plain);
    }
  });

  test('streaming writer and reader agree with the whole-file functions', async () => {
    const plain = rand(150_000);
    const w = new V.ChunkWriter(key);
    const parts = [];
    for (let at = 0; at < plain.length; at += 9_999) parts.push(...w.push(plain.subarray(at, at + 9_999)));
    parts.push(...w.finish());
    const blob = new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
    assert.deepEqual(V.decryptChunked(key, blob), plain);
    const out = [];
    let at = 0;
    const src = { read: async (n) => { const r = blob.slice(at, at + Math.min(n, 7_000)); at += r.length; return r; }, close() {} };
    await V.decryptChunkedStream(key, src, blob.length, async (p) => void out.push(Buffer.from(p)));
    assert.deepEqual(new Uint8Array(Buffer.concat(out)), plain);
  });

  test('tampering, reordering, dropping or appending chunks, or the wrong key, is rejected', () => {
    const blob = V.encryptChunked(key, rand(200_000));   // 4 chunks
    const C = V.CHUNK_CIPHER_BYTES, P = V.CHUNK_PREFIX_BYTES;
    for (const at of [0, 15, 16, P + C - 1, P + C, blob.length - 1]) {
      const t = blob.slice();
      t[at] ^= 1;
      assert.throws(() => V.decryptChunked(key, t), `flip at ${at}`);
    }
    const swapped = blob.slice();
    swapped.set(blob.subarray(P, P + C), P + C);
    swapped.set(blob.subarray(P + C, P + 2 * C), P);
    assert.throws(() => V.decryptChunked(key, swapped), 'reordered');
    assert.throws(() => V.decryptChunked(key, blob.subarray(0, blob.length - C)), 'last chunk dropped');
    assert.throws(() => V.decryptChunked(key, Buffer.concat([blob, blob.subarray(P, P + C)])), 'chunk appended');
    assert.throws(() => V.decryptChunked(key, blob.subarray(0, blob.length - 1)), 'cut by a byte');
    assert.throws(() => V.decryptChunked(new Uint8Array(32), blob), 'wrong key');
  });

  test('two encryptions of the same file differ (random prefix)', () => {
    const p = rand(10);
    assert.notDeepEqual(V.encryptChunked(key, p), V.encryptChunked(key, p));
  });
});

describe('background Argon2 (patched react-native-libsodium)', () => {
  test('the polled worker result equals the synchronous one, and unlock works through it', async () => {
    const sodium = await import('react-native-libsodium');
    const jobs = new Map();
    let next = 1, polls = 0;
    globalThis.jsi_crypto_pwhash_start = (len, pw, salt, ops, mem, alg) => {
      const id = next++;
      const result = sodium.crypto_pwhash(len, new Uint8Array(pw), new Uint8Array(salt), ops, mem, alg);
      jobs.set(id, { ready: Date.now() + 30, result });
      return id;
    };
    globalThis.jsi_crypto_pwhash_poll = (id) => {
      polls++;
      const j = jobs.get(id);
      if (Date.now() < j.ready) return undefined;
      jobs.delete(id);
      return j.result.buffer;
    };
    try {
      await makeVault();                      // derived through the worker
      delete globalThis.jsi_crypto_pwhash_start;
      delete globalThis.jsi_crypto_pwhash_poll;
      const a = await V.unlock(pin(A), disk);  // derived synchronously: same keys, so it opens
      assert.ok(a.fileKey.length === 32);
      assert.ok(polls > 3, 'JavaScript polled instead of blocking');
    } finally {
      delete globalThis.jsi_crypto_pwhash_start;
      delete globalThis.jsi_crypto_pwhash_poll;
    }
  });
});

describe('unlock errors', () => {
  test('cancels, lockouts and missing lock screens are told apart from wrong PINs', () => {
    const e = (code, message = '') => Object.assign(new Error(message), { code });
    const cases = [
      [e('E_AUTH_CANCELLED'), 'cancelled'],
      [e('', 'User canceled the operation.'), 'cancelled'],     // react-native-keychain, iOS
      [e('-128', 'whatever'), 'cancelled'],
      [e('', 'code: 13, msg: Negative button pressed'), 'cancelled'],   // react-native-keychain, Android
      [e('E_AUTH_LOCKOUT'), 'lockout'],
      [e('', 'Too many attempts. Try again later.'), 'lockout'],
      [e('E_NO_LOCK_SCREEN'), 'no-lock-screen'],
      [e('E_AUTH_FAILED'), 'auth-failed'],
      [new V.WrongPin(), 'wrong'],
      [e('E_KEY_USE', 'refused'), 'error'],
      [new Error('disk error'), 'error'],
      [null, 'error'],
    ];
    for (const [err, kind] of cases) assert.equal(V.classifyUnlockError(err), kind, String(err?.message ?? err));
  });
});

describe('forgetStaleKeys', () => {
  test('without a vault, removes leftover keys; with one, touches nothing', async () => {
    CubeNative.createKey('app.cube.h0', true, true);
    keychain.set('app.cube.v0', { username: 'v', password: 'x', opts: {} });
    keychain.set('app.cube.k0', { username: 'k', password: 'x', opts: {} });
    keychain.set('app.cube.l1', { username: 'v', password: 'x', opts: {} });
    keychain.set('app.cube.l0.n', { username: 'v', password: 'x', opts: {} });
    await V.forgetStaleKeys(disk);
    assert.equal(native.keys.size, 0);
    assert.ok(!keychain.has('app.cube.v0') && !keychain.has('app.cube.k0'));
    assert.ok(!keychain.has('app.cube.l1') && !keychain.has('app.cube.l0.n'));

    await makeVault();
    await V.forgetStaleKeys(disk);
    assert.ok(native.keys.has('app.cube.h0') && keychain.has('app.cube.v0'));
    await V.unlock(pin(A), disk);
  });
});
