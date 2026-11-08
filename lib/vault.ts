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
 * Primitives (libsodium): Argon2id → BLAKE2b(keyed with a hardware-protected master
 * secret) → XChaCha20-Poly1305. See README "How it works" and "Vulnerabilities".
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

// ---- layout (all sizes fixed; libsodium constants) -----------------------------------
const KEY = 32;                 // XChaCha20-Poly1305 key
const NONCE = 24;               // XChaCha20 nonce
const TAG = 16;                 // Poly1305 tag
const PAYLOAD = 36;             // fileKey(32) action(1) vault(1) targetVault(1) targetSlot(1)
const SLOT = NONCE + PAYLOAD + TAG;        // 76 bytes, identical for every slot
const SLOTS = 4;                           // A, B, C, padding — shuffled at setup
const SALT = crypto_pwhash_SALTBYTES;      // 16
export const HEADER = 'h.bin';
const HEADER_BYTES = SALT + SLOTS * SLOT;  // 320 bytes, always
const BLOCK = 64 * 1024;                   // files padded to multiples of this
const MIN_UNLOCK_MS = 1500;                // every unlock attempt takes at least this long
const AAD = '';                            // react-native-libsodium requires a string here

// Argon2id cost. Tune so ONE derivation takes ~0.5 s on your slowest target device.
// crypto_pwhash blocks the JS thread while it runs — show your spinner before calling unlock().
const KDF_OPS = 3;
const KDF_MEM = 64 * 1024 * 1024;

const OPEN = 1;
const WIPE = 2;
const NONE = 0xff;
const MASTER_SERVICE = 'app.cube.k0';

/**
 * Emulators and cloud test phones have no hardware-backed Keystore and often no lock screen,
 * so a production build refuses to set up there. Building with EXPO_PUBLIC_SOFTWARE_KEYS=1
 * accepts software key storage without a user-auth gate — FOR TESTING ONLY. The lock screen
 * shows a notice whenever this is on. Never ship a build with it set.
 */
export const SOFTWARE_KEYS = process.env.EXPO_PUBLIC_SOFTWARE_KEYS === '1';

export interface Disk {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;   // file or directory, recursive, no error if missing
  mkdir(path: string): Promise<void>;
}

export type Opened = { vault: number; fileKey: Uint8Array };

export class WrongPin extends Error {
  constructor() {
    super('Wrong PIN');
    this.name = 'WrongPin';
  }
}

// ---- hardware-protected master secret ------------------------------------------------
// Slot keys are Argon2id(PIN) mixed with this secret, so a copy of the app's storage is
// useless without the phone. Android: Keystore key, hardware-backed, biometric-gated.
// iOS: Keychain item, this device only, never in backups, biometric/passcode-gated.
//
// Limitation: react-native-keychain hands the secret to JS when read (as a base64 string
// that cannot be zeroed). For a key that never exists in software, replace these two
// functions with a small native module (see README "Roadmap").
async function saveMaster(m: Uint8Array): Promise<void> {
  const ok = await Keychain.setGenericPassword('k', to_base64(m), {
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
}

async function loadMaster(): Promise<Uint8Array> {
  const c = await Keychain.getGenericPassword({
    service: MASTER_SERVICE,
    authenticationPrompt: { title: 'Unlock' },
  });
  if (!c) throw new WrongPin();   // master gone (after wipeEverything) looks like a wrong PIN
  return from_base64(c.password);
}

// ---- primitives ------------------------------------------------------------------------
/** Argon2id(PIN, salt), then BLAKE2b keyed with the master secret. */
function pinKey(pin: Uint8Array, salt: Uint8Array, master: Uint8Array): Uint8Array {
  const derived = crypto_pwhash(KEY, pin, salt, KDF_OPS, KDF_MEM, crypto_pwhash_ALG_ARGON2ID13);
  const k = crypto_generichash(KEY, derived, master);
  derived.fill(0);
  return k;
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
/** PINs as bytes (the keypad produces them: new Uint8Array(digits.map(d => 48 + d))). */
export async function setup(pinA: Uint8Array, pinB: Uint8Array, pinC: Uint8Array, disk: Disk): Promise<void> {
  if (same(pinA, pinB) || same(pinA, pinC) || same(pinB, pinC)) {
    throw new Error('PINs must differ');
  }

  const master = randombytes_buf(KEY);
  await saveMaster(master);

  const salt = randombytes_buf(SALT);
  const keyA = randombytes_buf(KEY);
  const keyB = randombytes_buf(KEY);
  const vaultA = randombytes_uniform(2);          // directory "0" or "1", chosen at random
  const vaultB = 1 - vaultA;
  const [slotA, slotB, slotC, slotPad] = shuffle([0, 1, 2, 3]);

  const kA = pinKey(pinA, salt, master);
  const kB = pinKey(pinB, salt, master);
  const kC = pinKey(pinC, salt, master);

  const slots: Uint8Array[] = new Array(SLOTS);
  slots[slotA] = seal(kA, payload(keyA, OPEN, vaultA, NONE, NONE));
  slots[slotB] = seal(kB, payload(keyB, OPEN, vaultB, NONE, NONE));
  slots[slotC] = seal(kC, payload(keyB, WIPE, vaultB, vaultA, slotA));
  slots[slotPad] = randombytes_buf(SLOT);        // indistinguishable from a real slot

  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt);
  slots.forEach((s, i) => header.set(s, SALT + i * SLOT));
  await disk.write(HEADER, header);
  await disk.mkdir('0');                         // both vaults are born together,
  await disk.mkdir('1');                         // so timestamps say nothing

  [master, keyA, keyB, kA, kB, kC, pinA, pinB, pinC].forEach((b) => b.fill(0));
}

// ---- unlock ------------------------------------------------------------------------------
/**
 * Identical behaviour for every input: one Argon2id, every slot tried (no early exit),
 * fixed minimum duration. Throws WrongPin for anything that opens nothing.
 * Zero `fileKey` (fileKey.fill(0)) the moment the vault locks again.
 */
export async function unlock(pin: Uint8Array, disk: Disk): Promise<Opened> {
  const master = await loadMaster();                       // biometric / passcode prompt
  const t0 = Date.now();                                   // timing window starts after the prompt
  const header = await disk.read(HEADER);

  if (!header || header.length !== HEADER_BYTES) {
    master.fill(0);
    pin.fill(0);
    await padTime(t0);
    throw new WrongPin();
  }

  const k = pinKey(pin, header.subarray(0, SALT), master);
  pin.fill(0);
  master.fill(0);

  let hit: { slot: number; p: Uint8Array } | null = null;
  for (let i = 0; i < SLOTS; i++) {
    const start = SALT + i * SLOT;
    const p = openSlot(k, header.subarray(start, start + SLOT));
    if (p && !hit) hit = { slot: i, p };
    else p?.fill(0);
  }
  k.fill(0);

  if (!hit) {
    await padTime(t0);
    throw new WrongPin();
  }

  const fileKey = hit.p.slice(0, KEY);
  const action = hit.p[32];
  const vault = hit.p[33];
  const targetVault = hit.p[34];
  const targetSlot = hit.p[35];
  hit.p.fill(0);

  if (action === WIPE) await destroyVault(targetVault, targetSlot, header, disk);

  await padTime(t0);
  return { vault, fileKey };
}

// ---- wipe --------------------------------------------------------------------------------
/**
 * Crypto-shred: overwrite the vault's slot (its file key dies with it) — fast and done before
 * returning. The now-unreadable ciphertext is deleted in the background so that the wipe
 * path takes no longer than a normal unlock, however many files there were.
 */
async function destroyVault(vault: number, slot: number, header: Uint8Array, disk: Disk): Promise<void> {
  header.set(randombytes_buf(SLOT), SALT + slot * SLOT);   // now just another padding slot
  await disk.write(HEADER, header);
  void disk
    .remove(String(vault))
    .then(() => disk.mkdir(String(vault)))                 // layout looks untouched
    .catch(() => undefined);
}

/**
 * Alternative policy — PIN C destroys everything, vault B included.
 * Deleting the master secret kills every slot, including copies an attacker made earlier.
 * To use it: in unlock(), call wipeEverything(disk) instead of destroyVault(...).
 */
export async function wipeEverything(disk: Disk): Promise<void> {
  await Keychain.resetGenericPassword({ service: MASTER_SERVICE });
  await disk.write(HEADER, randombytes_buf(HEADER_BYTES));
  await disk.remove('0');
  await disk.remove('1');
}

// ---- file encryption ---------------------------------------------------------------------
/**
 * Encrypt one blob for a vault. Padded to 64 KiB blocks so sizes leak little.
 * Stored under a random file name; real names live in the encrypted index (lib/files.ts).
 * Everything is held in memory, so very large files (hundreds of MB) will not work —
 * crypto_secretstream chunking is the fix (README "Roadmap").
 */
export function encryptBlob(fileKey: Uint8Array, plain: Uint8Array): Uint8Array {
  const total = Math.ceil((plain.length + 1) / BLOCK) * BLOCK;
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
