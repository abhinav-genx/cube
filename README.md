# Cube

A small, deniable file vault for Android and iOS, built with React Native, Expo Router and TypeScript.

Three PINs, one keypad:

| PIN | What happens |
| --- | --- |
| First | Opens your files. |
| Second | Opens a separate set of files — the one you can show if someone insists. |
| Third | Permanently destroys the first set, then opens the second set exactly as the second PIN would. No warning, no undo. |

Nothing on the phone records which PIN is which, or how many PINs exist. A wrong PIN, the second PIN and the third PIN all look identical from the outside: same screen, same timing, same result.

> **Status: unaudited, and not yet run on a physical device by its author.** The code type-checks and the Expo config resolves, but treat this as a reference implementation to review and test, not something to protect anything you cannot afford to lose. Read [Vulnerabilities](#vulnerabilities-and-threat-model) before relying on it.

## Screens

- **Lock** — the cube, six dots, a keypad. Confirm with the check key. Any failure says only "Wrong PIN".
- **Setup** (first launch) — choose and confirm three PINs in sequence, then the vault is created.
- **Files** — a plain list. Add a photo or a document, tap to open, long-press to delete, lock in the top corner.
- **File** — previews images and text. Export sends a copy to the share sheet (see the warning it shows).

The UI never says "decoy", "real" or "wipe". Both file sets are just "Files".

## How it works

All crypto is libsodium via `react-native-libsodium`; nothing is hand-rolled.

**PINs become keys, never comparisons.** The entered PIN goes through Argon2id (3 passes, 64 MiB) with a per-install salt, then through BLAKE2b keyed with a *master secret* that lives in the phone's secure hardware (Android Keystore, iOS Keychain). The result is tried against four 76-byte "slots" in `h.bin`, each sealed with XChaCha20-Poly1305. Whichever slot authenticates says what to do:

```
slot → [ 32-byte file key | action | vault | targetVault | targetSlot ]
```

- First PIN's slot: `OPEN`, vault A's key
- Second PIN's slot: `OPEN`, vault B's key
- Third PIN's slot: `WIPE`, vault B's key, and the address of vault A's slot
- Fourth slot: 76 random bytes — indistinguishable from a real slot

Slot order and the vault directory names (`0`/`1`) are chosen at random during setup. Both directories are created in the same moment so timestamps say nothing.

**Every attempt runs the same path.** One Argon2id, all four slots tried with no early exit, and a 1.5 s minimum duration measured from the moment the hardware prompt is dismissed.

**Wipe = crypto-shred.** Entering the third PIN overwrites vault A's slot with random bytes (its file key is gone; the ciphertext is now noise), returns vault B in the normal unlock time, and deletes the dead ciphertext in the background so the wipe takes no longer than any other unlock. Afterwards the first PIN behaves like a typo.

**Files** are encrypted with the vault's key, padded to 64 KiB blocks so sizes leak little, and stored under random 128-bit names. The real names live in an encrypted index. Deleting a file removes its ciphertext and index entry.

**Hardware binding.** A copy of the app's storage is useless without the phone: every guess has to run through the device's secure hardware, and the master secret is `WHEN_UNLOCKED_THIS_DEVICE_ONLY` on iOS / `SECURE_HARDWARE` + `AES_GCM` (biometric or passcode gated) on Android, excluded from backups on both.

**Session.** The open vault's key lives in one in-memory store. It is zeroed on lock, after 90 s without a touch, and when the app goes to the background (unless a picker or share sheet that the app opened is up).

## Running it

Native modules (libsodium, keychain) mean **Expo Go will not work**; you need a development build.

```sh
npm install
npx expo prebuild          # generates ios/ and android/ (git-ignored)
npx expo run:android       # or: npx expo run:ios
```

Requirements: Node 20+, a device or emulator **with a lock screen (and ideally biometrics) set up**, Android 8+ with hardware-backed Keystore, iOS 15.1+. Without a lock screen, setup fails with "Check that a device lock screen is set".

For a release build: `npx expo run:android --variant release` / `npx expo run:ios --configuration Release`, or `eas build`. Do not ship debug builds — they expose the dev menu and Hermes heap.

Type check: `npm run typecheck`.

### Running in an emulator or cloud test phone

Emulators have no hardware-backed Keystore and usually no lock screen, so a normal build stops at setup with "This device cannot keep keys in secure hardware". For testing only, build with software keys:

```sh
EXPO_PUBLIC_SOFTWARE_KEYS=1 npx expo run:android          # local emulator
npx eas-cli build -p android --profile emulator            # cloud build → installable APK
```

That flag makes the master secret a software Keystore entry with no biometric gate and puts "Testing build: software keys" on the lock screen. Never ship it.

`eas.json` has three Android profiles: `development` (dev client APK), `emulator` (release APK with software keys), `preview` (release APK, hardware keys). Building needs an Expo account (`npx eas-cli login`); an APK from the `emulator` profile installs on any Android 8+ emulator or cloud device.

## Project layout

```
app/
  _layout.tsx      fonts, navigation stack, background auto-lock
  index.tsx        lock screen
  setup.tsx        first-run: three PINs
  vault.tsx        file list
  file/[id].tsx    viewer + export
components/
  Logo.tsx         the cube (react-native-svg), logoPaths.ts is generated
  PinPad.tsx       keypad that emits bytes, not strings
  PinDots.tsx      progress dots + shake
  Button.tsx, Screen.tsx
lib/
  vault.ts         crypto core: setup / unlock / wipe / encryptBlob / decryptBlob
  disk.ts          storage on expo-file-system's File API
  files.ts         encrypted index, add / read / remove
  session.ts       in-memory key, idle + background lock
  usePin.ts        PIN buffer hook (Uint8Array in a ref)
  theme.ts, format.ts
scripts/gen_logo.py  regenerates components/logoPaths.ts and assets/*.png
```

## Features

- Three PINs: open, decoy, wipe — cryptographically indistinguishable in storage
- Argon2id + keyed BLAKE2b + XChaCha20-Poly1305 (libsodium, JSI)
- Master secret in Android Keystore / iOS Keychain, biometric or passcode gated, hardware-backed required
- Constant-path, fixed-minimum-time unlock
- Crypto-shred wipe that completes in normal unlock time and opens the decoy
- Random slot order, random vault names, random padding slot
- Files padded to 64 KiB blocks, random on-disk names, encrypted index
- Custom keypad: PIN never touches the system keyboard or a JS string in state
- Auto-lock on idle (90 s) and on background; key zeroed on lock
- Screenshot/recording prevention on vault screens (`expo-screen-capture`)
- Backups disabled (`allowBackup=false`, Keychain this-device-only), iOS `NSFileProtectionComplete`
- Image and text preview; explicit, warned export via the share sheet
- Minimal UI: one typeface, no cards, no labels that reveal vault type
- `EXPO_PUBLIC_SOFTWARE_KEYS=1` testing mode for emulators, clearly labelled on the lock screen

## Drawbacks and limitations

- **Numeric PINs only.** The keypad is 0–9, 4–12 digits. A 6-digit PIN is ~1 M possibilities; the hardware binding is what makes that survivable (guesses must run on this phone), but it is still the weakest link. A passphrase mode is the single most valuable upgrade.
- **Argon2id runs on the JS thread.** The UI freezes for the duration of one derivation (~0.5–1 s on a mid-range phone; tune `KDF_OPS`/`KDF_MEM` in `lib/vault.ts`). Setup runs it three times.
- **Whole files in memory.** Encrypt/decrypt is one shot; files of a few hundred MB will exhaust memory. Chunked `crypto_secretstream` is the fix.
- **No recovery.** Forget the first PIN and the files are gone. There is deliberately no backup, export of the vault, or cloud sync.
- **One theme.** Light only.
- **Export opens the whole file to another app** — that app's copy is outside Cube's control.
- **Adding or removing biometrics** does not break the vault (`BIOMETRY_ANY_OR_DEVICE_PASSCODE`); the flip side is that the device passcode alone passes the hardware gate.
- **Deniability is about which PIN, not whether the feature exists.** Anyone who reads this README knows the app supports a decoy and a wipe.

## Known bugs and untested areas

Honest list. Items marked *untested* are expected to work from the API documentation but have not been exercised on hardware by the author.

1. *Untested on devices.* No end-to-end run on real Android/iOS yet. Expect small integration issues around pickers, keychain prompts and the new `expo-file-system` File API.
2. **Android `content://` URIs** — the document picker is called with `copyToCacheDirectory: true` so a `file://` copy is read; if a device returns a `content://` URI anyway, `readUri` may fail and the add shows "That file could not be added."
3. **Cancelling the biometric prompt** shows "Unlock cancelled." based on error codes starting `E_AUTH`/`E_BIOMETRIC`; if a platform surfaces a different code, it will show "Wrong PIN" instead (safe, but confusing).
4. **Background lock while a picker is open** is suppressed by a suspend counter; if a picker rejects without resolving (killed activity), the counter still resets in `finally`, but the idle timer may fire one cycle late.
5. **Large images** are previewed via a base64 data URI; very large photos (50 MB+) may be slow or fail to render.
6. **Index growth.** The index is one JSON document rewritten on every add/delete; thousands of files will make adds slower.
7. **`Alert` as action sheet.** "Add a file" uses a three-button `Alert`, which looks like a dialog rather than a sheet, especially on Android.
8. **No tests.** `npm run typecheck` is the only automated check. The crypto layout (`SLOT`, `PAYLOAD`, header size) should get unit tests before any format change.
9. **StrictMode / Fast Refresh** can double-run effects in development and zero a decrypted buffer early; release builds are unaffected.

## Vulnerabilities and threat model

What the design is meant to withstand, and where it stops:

| Attacker has… | Outcome |
| --- | --- |
| A copy of the app's storage (forensic image, backup) | Nothing. Slot keys need the master secret in the phone's hardware. |
| The locked phone, no credentials | Must pass biometric/passcode, then guess the PIN on-device at ~1 guess/s. Longer PINs help; there is no attempt counter the app can enforce against a rooted device. |
| The unlocked phone, briefly | Vault is locked (background lock, idle lock). The keypad reveals nothing. |
| Root/jailbreak on the live phone | Can read the master secret when the app reads it, replicate the unlock logic, test PINs without triggering the wipe, and dump RAM while a vault is open. Software cannot stop this. |
| Coercion to enter "the" PIN | Give the second or third PIN. Their behaviour is identical to the first from the outside. |

Specific weaknesses in this implementation:

1. **The master secret passes through JavaScript.** `react-native-keychain` returns it as a base64 string, which cannot be zeroed; Hermes may keep copies until GC. A native module that keeps a non-exportable key in StrongBox / Secure Enclave and only wraps/unwraps would remove this (and would make deleting the key destroy even previously copied storage). This is the top item on the roadmap.
2. **Short PIN space.** See Drawbacks. Offline brute force is blocked by hardware binding, on-device brute force is not.
3. **Plaintext touches the cache directory.** The pickers copy the chosen file into the app cache before Cube encrypts it, and Export writes a temporary copy for the share sheet. Both copies are deleted immediately, but deletion on flash storage is not erasure; fragments may survive until overwritten. The *original* file stays wherever it was — Cube cannot delete it.
4. **Per-vault, not per-file, crypto-shredding.** Deleting one file removes its ciphertext, but that ciphertext remains decryptable with the vault key if recovered from flash. Per-file keys would fix this.
5. **Decrypted data lives in JS memory while viewing.** `Uint8Array.fill(0)` is best-effort; the image preview additionally creates an unzeroable base64 string.
6. **Timing.** A 1.5 s floor covers Argon2 and slot trial; file deletion after a wipe is deferred to the background. Residual leaks: the deferred deletion causes disk activity an attacker with root could observe, and devices slower than the floor leak nothing new but make all paths longer.
7. **No root/jailbreak or debugger detection.** Deliberately — it is bypassable and adds false confidence — but it means no warning either.
8. **Screenshot prevention is best-effort on iOS.** `expo-screen-capture` blocks Android reliably (`FLAG_SECURE`); iOS protection depends on OS behaviour and does not stop photographing the screen.
9. **Keychain items can outlive the app on iOS.** Uninstalling may leave the master secret in the Keychain; the ciphertext is gone with the app, so this is a hygiene issue rather than exposure, but reinstalling will not restore anything.
10. **Enrollment changes.** With `BIOMETRY_ANY_OR_DEVICE_PASSCODE`, someone who adds their fingerprint and knows the device passcode passes the hardware gate; they still need the PIN.
11. **Dependency trust.** Security rests on `react-native-libsodium`, `react-native-keychain`, Expo modules and the OS. Pin versions, review updates.
12. **The software-keys testing mode** (`EXPO_PUBLIC_SOFTWARE_KEYS=1`) removes hardware binding and the auth gate entirely; a storage dump of such a build is brute-forceable offline. It exists so the app can be exercised in emulators. The lock screen labels it; CI should fail if it is set on a store build.
13. **No integrity protection on `h.bin` as a whole.** Each slot is authenticated; the file is not. An attacker can swap slots or truncate the file, which only makes unlocks fail (denial of service), never leaks keys.

## Roadmap

- Native key module: non-exportable StrongBox / Secure Enclave key wrapping the master secret
- Passphrase mode (alphanumeric, system keyboard disabled from learning)
- `crypto_secretstream` chunked files; per-file keys
- Argon2 on a background thread (`crypto_pwhash` async)
- Unit tests for the slot format and unlock paths
- Dark theme; iPad layout

## Regenerating the logo

```sh
python3 scripts/gen_logo.py   # needs Pillow; rewrites components/logoPaths.ts and assets/*.png
```

The leaf is a seven-leaflet outline with teeth that point toward the tip, mapped onto each cube face with an affine matrix so it sits on the surface rather than in front of it.

## License

No license has been chosen yet. Add one before publishing.
