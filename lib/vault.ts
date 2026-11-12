/**
 * vault.ts — the 3-PIN deniable vault.
 *
 *   PIN A → opens vault A          (the one you care about)
 *   PIN B → opens vault B          (the one you show)
 *   PIN C → destroys vault A, then opens vault B exactly like PIN B would
 *
 * Nothing on disk says which PIN is which: four equal-size slots in random order,
 * one of them pure random padding. PINs are never stored, only used as key material.
 * Every PIN (right, wrong, B, C) runs the identical code path in the same time.
 *
 * Primitives (libsodium): Argon2id → a hardware-bound keyed step → XChaCha20-Poly1305.
 * The keyed step runs inside the phone's secure hardware (modules/cube-native): HMAC with an
 * Android Keystore key, or ECDH with a Secure Enclave key on iOS. Vaults set up before that
 * existed use BLAKE2b keyed with a Keychain master secret.
 * See README "How it works" and "Vulnerabilities".
 */
import {
  crypto_pwhash,
  crypto_pwhash_SALTBYTES,
  crypto_pwhash_ALG_ARGON2ID13,
  crypto_aead_xchacha20poly1305_ietf_encrypt as aeadEncrypt,
  crypto_aead_xchacha20poly1305_ietf_decrypt as aeadDecrypt,
  crypto_generichash,
  randombytes_buf,
  randombytes_uniform,
  to_base64,
  from_base64,
} from 'react-native-libsodium';
import * as Keychain from 'react-native-keychain';
import CubeNative from '../modules/cube-native';

// ---- layout (all sizes fixed; libsodium constants) -----------------------------------
const KEY = 32;                 // XChaCha20-Poly1305 key
const NONCE = 24;               // XChaCha20 nonce
const TAG = 16;                 // Poly1305 tag
const PAYLOAD = 36;             // fileKey(32) action(1) vault(1) targetVault(1) targetSlot(1)
const SLOT = NONCE + PAYLOAD + TAG;        // 76 bytes, identical for every slot
const SLOTS = 4;                           // A, B, C, padding — shuffled at setup
const SALT = crypto_pwhash_SALTBYTES;      // 16
export const HEADER = 'h.bin';
export const INDEX = 'i.bin';              // per vault: "<vault>/i.bin"
const ATTEMPTS = 'a.bin';                  // failed-attempt counter
const HEADER_BYTES = SALT + SLOTS * SLOT;  // 320 bytes, always
const BLOCK = 64 * 1024;                   // files padded to multiples of this
/** Indexes are padded to at least this, so both vaults' indexes match until ~1,500 files. */
export const INDEX_MIN_BYTES = 4 * BLOCK;  // 256 KiB
const MIN_UNLOCK_MS = 1500;                // every unlock attempt takes at least this long
const AAD = '';                            // react-native-libsodium requires a string here

// Argon2id cost. Tune so ONE derivation takes ~0.5 s on your slowest target device.
// crypto_pwhash blocks the JS thread while it runs — show your spinner before calling unlock().
const KDF_OPS = 3;
const KDF_MEM = 64 * 1024 * 1024;

const OPEN = 1;
const WIPE = 2;
const NONE = 0xff;
const MASTER_SERVICE = 'app.cube.k0';      // Keychain master secret (iOS; older Android vaults)
const HW_ALIAS = 'app.cube.h0';            // Android Keystore HMAC key
const VAULT_SERVICE = 'app.cube.v';        // + "0" / "1": per-vault secret, rotated on wipe

/**
 * Emulators and cloud test phones have no hardware-backed Keystore and often no lock screen,
 * so a production build refuses to set up there. Building with EXPO_PUBLIC_SOFTWARE_KEYS=1
 * accepts software key storage without a user-auth gate — FOR TESTING ONLY. The lock screen
 * shows a notice whenever this is on, and scripts/check-release.js fails store builds with it.
 */
export const SOFTWARE_KEYS = process.env.EXPO_PUBLIC_SOFTWARE_KEYS === '1';

export interface Disk {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;   // file or directory, recursive, no error if missing
  mkdir(path: string): Promise<void>;
  /** The files (not folders) in a directory, with their sizes in bytes. */
  list(path: string): Promise<{ name: string; size: number }[]>;
}

export type Opened = { vault: number; fileKey: Uint8Array };

export class WrongPin extends Error {
  constructor() {
    super('Wrong PIN');
    this.name = 'WrongPin';
  }
}

/** Thrown by unlock() while the attempt delay is running; `waitMs` says how long is left. */
export class TooSoon extends Error {
  constructor(readonly waitMs: number) {
    super('Too many attempts');
    this.name = 'TooSoon';
  }
}

// ---- the keyed step: Argon2id(PIN) → slot key, bound to this phone -------------------
/**
 * A keyer turns Argon2id(PIN) into a slot key using a secret that never leaves this phone.
 *
 * Hardware: Android HMAC with a non-exportable Keystore key (StrongBox or TEE), or iOS ECDH with
 * a Secure Enclave key. No secret ever reaches JavaScript, so every guess must run on this phone,
 * behind the system prompt.
 *
 * Master (vaults set up before the hardware key existed): BLAKE2b keyed with a 32-byte master
 * secret kept in the Keychain/Keystore behind biometrics or the device passcode. Weaker:
 * react-native-keychain hands that secret to JavaScript when it is read.
 */
interface Keyer {
  key(stretched: Uint8Array): Uint8Array;
  close(): void;
}

const hardwareKeys = () => CubeNative?.hardwareKeysAvailable() === true;

function hardwareKeyer(): Keyer {
  return {
    key(stretched) {
      const out = new Uint8Array(KEY);
      CubeNative!.mac(HW_ALIAS, stretched, out);
      return out;
    },
    close() {},
  };
}

function masterKeyer(master: Uint8Array): Keyer {
  return {
    key: (stretched) => crypto_generichash(KEY, stretched, master),
    close: () => master.fill(0),
  };
}

/** For unlock: shows the system prompt (biometric or device passcode) and returns a keyer. */
async function openKeyer(): Promise<Keyer> {
  if (hardwareKeys() && CubeNative!.hasKey(HW_ALIAS)) {
    await CubeNative!.authenticate(HW_ALIAS, 'Unlock');
    return hardwareKeyer();
  }
  const c = await Keychain.getGenericPassword({
    service: MASTER_SERVICE,
    authenticationPrompt: { title: 'Unlock' },
  });
  if (!c) throw new WrongPin();   // no key at all looks like a wrong PIN
  return masterKeyer(from_base64(c.password));
}

/** For setup: creates a fresh hardware key (master secret only where the module is missing). */
async function createKeyer(): Promise<{ keyer: Keyer; reauth: () => Promise<void> }> {
  if (hardwareKeys()) {
    // Throws E_NO_LOCK_SCREEN / E_NO_SECURE_HARDWARE, which setup.tsx turns into a message.
    CubeNative!.createKey(HW_ALIAS, !SOFTWARE_KEYS, !SOFTWARE_KEYS);
    await Keychain.resetGenericPassword({ service: MASTER_SERVICE });   // no stale master left
    // Auth-per-use keys allow one HMAC per prompt, so each PIN gets its own prompt.
    return { keyer: hardwareKeyer(), reauth: () => CubeNative!.authenticate(HW_ALIAS, 'Create your vault') };
  }
  const master = randombytes_buf(KEY);
  const ok = await Keychain.setGenericPassword('k', to_base64(master), {
    service: MASTER_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    ...(SOFTWARE_KEYS
      ? {
          // testing only: any key storage, no biometric/passcode gate
          securityLevel: Keychain.SECURITY_LEVEL.ANY,
          storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
        }
      : {
          // BIOMETRY_CURRENT_SET would also destroy the vault when a fingerprint is added/removed.
          accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
          securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,   // refuse software-only key storage
          storage: Keychain.STORAGE_TYPE.AES_GCM,                   // Android: auth-gated AES-GCM
        }),
  });
  if (!ok) throw new Error('Could not store the key in secure hardware');
  return { keyer: masterKeyer(master), reauth: async () => {} };
}

// ---- per-vault secrets: what makes a wipe stick ---------------------------------------
/**
 * Each vault folder has its own random secret in the Keychain/Keystore (no prompt needed), and
 * the vault's real key is BLAKE2b(slot key, secret). A wipe replaces the wiped vault's secret, and
 * deleting a Keystore entry deletes its key, so a copy of the files taken before the wipe (forensic
 * image, backup, restored folder) stays unreadable even with the right PIN.
 * Vaults set up before this existed have no secret and use the slot key directly.
 */
async function readVaultSecret(vault: number): Promise<Uint8Array | null> {
  const c = await Keychain.getGenericPassword({ service: VAULT_SERVICE + vault });
  return c ? from_base64(c.password) : null;
}

async function newVaultSecret(vault: number): Promise<void> {
  const service = VAULT_SERVICE + vault;
  await Keychain.resetGenericPassword({ service });
  const ok = await Keychain.setGenericPassword('v', to_base64(randombytes_buf(KEY)), {
    service,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    securityLevel: SOFTWARE_KEYS ? Keychain.SECURITY_LEVEL.ANY : Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
    storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
  });
  if (!ok) throw new Error('Could not store the key in secure hardware');
}

function vaultKey(slotKey: Uint8Array, secret: Uint8Array | null): Uint8Array {
  return secret ? crypto_generichash(KEY, slotKey, secret) : slotKey.slice();
}

// ---- attempt delay ---------------------------------------------------------------------
/**
 * After FREE_TRIES wrong PINs in a row, each further attempt must wait (30 s up to 1 h).
 * The count survives restarts; the wait is measured with a monotonic clock from when this
 * process first looked, so changing the phone's clock or restarting the app never shortens it.
 * Any PIN that opens something (including the decoy and wipe PINs) resets the count.
 */
const FREE_TRIES = 4;
const DELAYS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
let failures: number | null = null;
let allowedAt = 0;
const monotonic = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

export function delayAfter(n: number): number {
  return n <= FREE_TRIES ? 0 : DELAYS_MS[Math.min(n - FREE_TRIES - 1, DELAYS_MS.length - 1)];
}

async function loadFailures(disk: Disk): Promise<number> {
  if (failures === null) {
    const b = await disk.read(ATTEMPTS);
    failures = b && b.length >= 4 ? new DataView(b.buffer, b.byteOffset, 4).getUint32(0) : 0;
    allowedAt = monotonic() + delayAfter(failures);
  }
  return failures;
}

async function saveFailures(disk: Disk, n: number): Promise<void> {
  failures = n;
  allowedAt = monotonic() + delayAfter(n);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  await disk.write(ATTEMPTS, b).catch(() => undefined);
}

/** Milliseconds until the next attempt is allowed (0 = now). */
export async function unlockWaitMs(disk: Disk): Promise<number> {
  await loadFailures(disk);
  return Math.max(0, Math.ceil(allowedAt - monotonic()));
}

// ---- primitives ------------------------------------------------------------------------
function stretch(pin: Uint8Array, salt: Uint8Array): Uint8Array {
  return crypto_pwhash(KEY, pin, salt, KDF_OPS, KDF_MEM, crypto_pwhash_ALG_ARGON2ID13);
}

function seal(k: Uint8Array, payload: Uint8Array): Uint8Array {
  const nonce = randombytes_buf(NONCE);
  const ct = aeadEncrypt(payload, AAD, null, nonce, k);
  const out = new Uint8Array(SLOT);
  out.set(nonce);
  out.set(ct, NONCE);
  return out;
}

function openSlot(k: Uint8Array, slot: Uint8Array): Uint8Array | null {
  try {
    return aeadDecrypt(null, slot.subarray(NONCE), AAD, slot.subarray(0, NONCE), k);
  } catch {
    return null;   // wrong key, padding slot, or tampering — all identical from outside
  }
}

function payload(fileKey: Uint8Array, action: number, vault: number, targetVault: number, targetSlot: number) {
  const p = new Uint8Array(PAYLOAD);
  p.set(fileKey);
  p[32] = action;
  p[33] = vault;
  p[34] = targetVault;
  p[35] = targetSlot;
  return p;
}

function shuffle(a: number[]): number[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randombytes_uniform(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function padTime(t0: number): Promise<void> {
  const left = MIN_UNLOCK_MS - (Date.now() - t0);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

// ---- setup (once) ------------------------------------------------------------------------
/**
 * PINs as bytes (the keypad produces them: new Uint8Array(digits.map(d => 48 + d))).
 * With a hardware key that needs the user, the system prompt appears once per PIN.
 */
export async function setup(pinA: Uint8Array, pinB: Uint8Array, pinC: Uint8Array, disk: Disk): Promise<void> {
  if (same(pinA, pinB) || same(pinA, pinC) || same(pinB, pinC)) {
    throw new Error('PINs must differ');
  }
  // Never over an existing vault: a new key would make it unreadable.
  if (await disk.read(HEADER)) throw new Error('A vault already exists');

  const { keyer, reauth } = await createKeyer();
  await newVaultSecret(0);
  await newVaultSecret(1);

  const salt = randombytes_buf(SALT);
  const keyA = randombytes_buf(KEY);
  const keyB = randombytes_buf(KEY);
  const vaultA = randombytes_uniform(2);          // directory "0" or "1", chosen at random
  const vaultB = 1 - vaultA;
  const [slotA, slotB, slotC, slotPad] = shuffle([0, 1, 2, 3]);

  const ks: Uint8Array[] = [];
  for (const pin of [pinA, pinB, pinC]) {
    const s = stretch(pin, salt);
    await reauth();
    ks.push(keyer.key(s));
    s.fill(0);
  }
  keyer.close();
  const [kA, kB, kC] = ks;

  const slots: Uint8Array[] = new Array(SLOTS);
  slots[slotA] = seal(kA, payload(keyA, OPEN, vaultA, NONE, NONE));
  slots[slotB] = seal(kB, payload(keyB, OPEN, vaultB, NONE, NONE));
  slots[slotC] = seal(kC, payload(keyB, WIPE, vaultB, vaultA, slotA));
  slots[slotPad] = randombytes_buf(SLOT);        // indistinguishable from a real slot

  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt);
  slots.forEach((s, i) => header.set(s, SALT + i * SLOT));
  await disk.remove('0');                        // leftovers without a header are unreadable
  await disk.remove('1');                        // noise that would break the new index
  await disk.mkdir('0');                         // both vaults are born together,
  await disk.mkdir('1');                         // so timestamps say nothing
  // Both vaults start with an (empty) index, so neither looks unused.
  for (const [vault, key] of [[vaultA, keyA], [vaultB, keyB]] as const) {
    const vk = vaultKey(key, await readVaultSecret(vault));
    // (react-native-libsodium's native build has no from_string; Hermes has TextEncoder.)
    await disk.write(
      `${vault}/${INDEX}`,
      encryptBlob(vk, new TextEncoder().encode('{"files":[],"shred":[]}'), INDEX_MIN_BYTES),
    );
    vk.fill(0);
  }
  await saveFailures(disk, 0);
  await disk.write(HEADER, header);              // last: the header's existence means setup finished

  [keyA, keyB, kA, kB, kC, pinA, pinB, pinC].forEach((b) => b.fill(0));
}

// ---- unlock ------------------------------------------------------------------------------
/**
 * Identical behaviour for every input: one Argon2id, one keyed step, every slot tried (no early
 * exit), both vault secrets read, fixed minimum duration. Throws WrongPin for anything that opens
 * nothing, TooSoon while the attempt delay runs.
 * Zero `fileKey` (fileKey.fill(0)) the moment the vault locks again.
 */
export async function unlock(pin: Uint8Array, disk: Disk): Promise<Opened> {
  const wait = await unlockWaitMs(disk);
  if (wait > 0) {
    pin.fill(0);
    throw new TooSoon(wait);
  }

  const keyer = await openKeyer();                         // biometric / passcode prompt
  const t0 = Date.now();                                   // timing window starts after the prompt
  const header = await disk.read(HEADER);

  if (!header || header.length !== HEADER_BYTES) {
    keyer.close();
    pin.fill(0);
    await saveFailures(disk, (await loadFailures(disk)) + 1);
    await padTime(t0);
    throw new WrongPin();
  }

  const s = stretch(pin, header.subarray(0, SALT));
  pin.fill(0);
  const k = keyer.key(s);
  s.fill(0);
  keyer.close();
  const secrets = [await readVaultSecret(0), await readVaultSecret(1)];

  let hit: { slot: number; p: Uint8Array } | null = null;
  for (let i = 0; i < SLOTS; i++) {
    const start = SALT + i * SLOT;
    const p = openSlot(k, header.subarray(start, start + SLOT));
    if (p && !hit) hit = { slot: i, p };
    else p?.fill(0);
  }
  k.fill(0);

  let opened: Opened | null = null;
  let wipeVault: number | null = null;
  if (hit) {
    const slotKey = hit.p.slice(0, KEY);
    const action = hit.p[32];
    const vault = hit.p[33];
    const targetVault = hit.p[34];
    const targetSlot = hit.p[35];
    hit.p.fill(0);
    if (action === WIPE) {
      // Crypto-shred: vault A's slot becomes just another padding slot; its file key dies with it.
      header.set(randombytes_buf(SLOT), SALT + targetSlot * SLOT);
      wipeVault = targetVault;
    }
    opened = { vault, fileKey: vaultKey(slotKey, secrets[vault]) };
    slotKey.fill(0);
  }
  secrets.forEach((x) => x?.fill(0));

  // Every attempt rewrites the header (right, decoy, wipe or wrong PIN), so its timestamp says
  // only that a PIN was tried, never which kind. Only the wipe changes its contents.
  if (wipeVault !== null) {
    await disk.write(HEADER, header);                      // the wipe must land before we return
    await newVaultSecret(wipeVault);                       // and old copies of its files die too
  } else {
    await disk.write(HEADER, header).catch(() => undefined);
  }
  // The wiped vault's files stay where they are: unreadable now, and they keep both folders
  // looking alike (see lib/files.ts, filler).
  await saveFailures(disk, opened ? 0 : (await loadFailures(disk)) + 1);

  await padTime(t0);
  if (!opened) throw new WrongPin();
  return opened;
}

/**
 * Alternative policy — PIN C destroys everything, vault B included.
 * Deleting the keys kills every slot, including copies an attacker made earlier.
 * To use it: in unlock(), call wipeEverything(disk) instead of the WIPE branch.
 */
export async function wipeEverything(disk: Disk): Promise<void> {
  if (hardwareKeys()) CubeNative!.deleteKey(HW_ALIAS);
  await Keychain.resetGenericPassword({ service: MASTER_SERVICE });
  await Keychain.resetGenericPassword({ service: VAULT_SERVICE + 0 });
  await Keychain.resetGenericPassword({ service: VAULT_SERVICE + 1 });
  await disk.write(HEADER, randombytes_buf(HEADER_BYTES));
  await disk.remove('0');
  await disk.remove('1');
}

// ---- file encryption ---------------------------------------------------------------------
/** Size on disk of a blob holding `plainSize` bytes (padded to at least `minBytes`). */
export function blobSize(plainSize: number, minBytes = 0): number {
  return NONCE + Math.max(Math.ceil((plainSize + 1) / BLOCK) * BLOCK, Math.ceil(minBytes / BLOCK) * BLOCK) + TAG;
}

/**
 * Encrypt one blob for a vault. Padded to 64 KiB blocks so sizes leak little.
 * Stored under a random file name; real names live in the encrypted index (lib/files.ts).
 * Everything is held in memory, so very large files (hundreds of MB) will not work —
 * crypto_secretstream chunking is the fix (README "Roadmap").
 */
export function encryptBlob(fileKey: Uint8Array, plain: Uint8Array, minBytes = 0): Uint8Array {
  const total = blobSize(plain.length, minBytes) - NONCE - TAG;
  const padded = new Uint8Array(total);
  padded.set(plain);
  padded[plain.length] = 0x80;                             // ISO 7816-4 padding marker
  const nonce = randombytes_buf(NONCE);
  const ct = aeadEncrypt(padded, AAD, null, nonce, fileKey);
  padded.fill(0);
  const out = new Uint8Array(NONCE + ct.length);
  out.set(nonce);
  out.set(ct, NONCE);
  return out;
}

export function decryptBlob(fileKey: Uint8Array, blob: Uint8Array): Uint8Array {
  const padded = aeadDecrypt(null, blob.subarray(NONCE), AAD, blob.subarray(0, NONCE), fileKey); // throws if tampered
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 0x80) throw new Error('corrupt');
  const out = padded.slice(0, end);
  padded.fill(0);
  return out;
}
