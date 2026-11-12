import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import CubeNative, { resetNative, state as native } from './mocks/cube-native.mjs';
import { control as keychainControl, store as keychain } from './mocks/keychain.mjs';
import { MemDisk, freshVault, pin, time } from './helpers.mjs';

const A = '135790', B = '246802', C = '975310';
const HEADER_BYTES = 320, SLOT = 76, SALT = 16;
const INDEX_BLOB = 24 + 256 * 1024 + 16;

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
const readIndex = async (o) =>
  JSON.parse(new TextDecoder().decode(V.decryptBlob(o.fileKey, await disk.read(`${o.vault}/i.bin`))));

describe('setup', () => {
  test('writes a fixed-size header, a zeroed counter and two equal padded indexes', async () => {
    await makeVault();
    assert.equal((await disk.read('h.bin')).length, HEADER_BYTES);
    assert.equal(await counter(), 0);
    assert.equal((await disk.read('0/i.bin')).length, INDEX_BLOB);
    assert.equal((await disk.read('1/i.bin')).length, INDEX_BLOB);
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

  test('takes the same time for right, decoy, wipe and wrong PINs (at least 1.5 s)', async () => {
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

    const c = await V.unlock(pin(C), disk);
    assert.deepEqual(c, b, 'PIN C opens exactly what PIN B opens');
    await assert.rejects(V.unlock(pin(A), disk), V.WrongPin);
    assert.deepEqual(await V.unlock(pin(B), disk), b);
    assert.notEqual(keychain.get(`app.cube.v${a.vault}`).password, secretBefore, 'wiped vault secret rotated');

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
    assert.throws(() => V.decryptBlob(again.fileKey, copy.get(`${a.vault}/i.bin`)));
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
