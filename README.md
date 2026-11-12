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

**PINs become keys, never comparisons.** The entered PIN goes through Argon2id (3 passes, 64 MiB) with a per-install salt, then through a keyed step bound to the phone's secure hardware. On Android that is HMAC-SHA256 with a non-exportable Android Keystore key (StrongBox when present, otherwise the TEE), computed by the local native module `modules/cube-native`; the key never leaves the hardware and, on Android 11+, each prompt authorises exactly one HMAC. On iOS it is ECDH with a Secure Enclave P-256 key: Argon2id(PIN) becomes a P-256 point and the enclave computes the shared secret, hashed into the slot key (the enclave has no HMAC keys); each Face ID / Touch ID / passcode prompt authorises one operation. Vaults set up before the native module existed use BLAKE2b keyed with a *master secret* in the Keychain/Keystore. The result is tried against four 76-byte "slots" in `h.bin`, each sealed with XChaCha20-Poly1305. Whichever slot authenticates says what to do:

```
slot → [ 32-byte file key | action | vault | targetVault | targetSlot ]
```

- First PIN's slot: `OPEN`, vault A's key
- Second PIN's slot: `OPEN`, vault B's key
- Third PIN's slot: `WIPE`, vault B's key, and the address of vault A's slot
- Fourth slot: 76 random bytes — indistinguishable from a real slot

Slot order and the vault directory names (`0`/`1`) are chosen at random during setup. Both directories are created in the same moment so timestamps say nothing.

**Every attempt runs the same path.** One Argon2id, all four slots tried with no early exit, and a 1.5 s minimum duration measured from the moment the hardware prompt is dismissed.

**Wipe = crypto-shred.** Entering the third PIN overwrites vault A's slot with random bytes and replaces vault A's per-vault secret (below), then returns vault B in the normal unlock time. Vault A's files stay on disk as unreadable noise, which keeps both folders looking alike. Every unlock attempt (right, wrong, decoy or wipe) rewrites `h.bin`, so its timestamp does not show that a wipe happened. Afterwards the first PIN behaves like a typo.

**Per-vault secrets.** Each vault folder has its own random secret in the Keychain/Keystore (no prompt), and the vault's key is BLAKE2b(slot key, secret). Replacing the secret on wipe also deletes its Keystore key, so a copy of the files taken before the wipe (forensic image, backup, restored folder) stays unreadable even with the first PIN.

**Attempt delay.** After 4 wrong PINs in a row, each further attempt waits 30 s, then 1, 5 and 15 minutes, then 1 hour. The count survives restarts and the wait uses a monotonic clock, so restarting the app or changing the phone's clock does not shorten it. Any PIN that opens something resets it.

**Files** are encrypted with the vault's key, padded to 64 KiB blocks so sizes leak little, and stored under random 128-bit names. The real names live in an encrypted index, padded to 256 KiB so both vaults' indexes look the same until about 1,500 files; both vaults get an (empty) index at setup.

**Native image preview.** Images are decrypted (XChaCha20-Poly1305: HChaCha20 plus the platform's ChaCha20-Poly1305) and decoded in native code (`modules/cube-native`) and shown by a native view, so the decrypted photo never enters JavaScript; on Android the pixels are wiped when the viewer closes. Text files and export still pass through JavaScript.

**Passphrases.** Setup offers a passphrase instead of a PIN (at least 8 characters, any characters); the lock screen opens in the chosen mode and can switch. Text fields reach JavaScript as strings, which cannot be zeroed, so a passphrase may linger in memory longer than a keypad PIN.

**Filler.** Every blob written to one vault folder gets a same-size blob of random bytes in the other, a deleted file is overwritten with random bytes rather than removed, and after each unlock the two folders are evened out. Someone with a copy of storage sees two folders with the same number and sizes of blobs, so the size of the vault you did not open stays hidden. Storage use roughly doubles and never shrinks.

**Hardware binding.** A copy of the app's storage is useless without the phone: every guess has to run through the device's secure hardware. Android: the Keystore HMAC key; iOS: the Secure Enclave key; both biometric or passcode gated and `this device only`. On iOS the vault folder is also excluded from backups.

**Session.** The open vault's key lives in one in-memory store. It is zeroed on lock, after 90 s without a touch, and when the app goes to the background (unless a picker or share sheet that the app opened is up, and then for at most 2 minutes).

## Running it

Native modules (libsodium, keychain, `modules/cube-native`) mean **Expo Go will not work**; you need a development build.

`npm install` runs `patch-package` (`patches/react-native-libsodium+1.7.0.patch`): react-native-libsodium's iOS bridge used `RCTCxxBridge`, which React Native 0.80+ removed; the patch reads the JS runtime from the bridge proxy instead. On iOS, run `pod install` with a UTF-8 locale (`LANG=en_US.UTF-8`) or CocoaPods fails.

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

## Testing

```sh
npm test               # unit tests (Node's test runner, no extra dependencies), ~80 s
npm run typecheck
npm run check-release  # fails if a release build would ship with software keys
```

The unit tests (`tests/*.test.mjs`) run the real `lib/` code against libsodium's WebAssembly build, with the Keychain, the native module and the file system replaced by fakes (`tests/mocks/`). They cover the vault format, all three PINs and the wipe, hardware binding, equal unlock timing, the attempt delay, blob padding and tampering, filler balance, a lock during an add or delete, and crash recovery at every disk step.

Device tests (they clear Cube's data on the device):

```sh
# Android emulator, DEBUG build (debug keypads carry labels) with Metro running and
# EXPO_PUBLIC_SOFTWARE_KEYS=1: setup, add/view/export, decoy, auto-lock, attempt delay,
# delete, wipe, FLAG_SECURE, log and permission checks
adb reverse tcp:8081 tcp:8081 && node --test tests/e2e/android.e2e.mjs

# Android RELEASE APK: manifest, accessibility exposure of the keypad, 3000-event monkey run
bash tests/e2e/android-release-check.sh android/app/build/outputs/apk/release/app-release.apk

# iOS simulator, after using the app: what is on disk and in the Keychain
bash tests/e2e/ios-storage-check.sh
```

Cube's window is `FLAG_SECURE` and hides its content from non-privileged accessibility services, so screenshot- or accessibility-driven tools (ARTEMIS, for one) cannot see it; the Android tests read the UI with `uiautomator dump` over adb. On the iOS simulator, drive a Release build: in a debug build, injected keystrokes can reach React Native's developer shortcuts and reload the app.

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
tests/               unit tests (npm test), fakes in tests/mocks/, device tests in tests/e2e/
scripts/gen_logo.py  regenerates components/logoPaths.ts and assets/*.png
scripts/check-release.js  fails release builds made with software keys
modules/cube-native/  local Expo module: Android Keystore HMAC key, iOS backup exclusion
plugins/
  withReleaseNoInternet.js  drops INTERNET from release builds
  withSecureWindow.js       FLAG_SECURE + overlay-touch filtering from the first frame
  withNoDataExtraction.js   blocks Android 12+ device-to-device transfer
```

## Features

- Three PINs: open, decoy, wipe — cryptographically indistinguishable in storage
- Argon2id + hardware-bound keyed step + XChaCha20-Poly1305 (libsodium, JSI)
- Android: non-exportable Keystore HMAC key (StrongBox or TEE), one HMAC per prompt on Android 11+; iOS: Secure Enclave ECDH key, one operation per prompt; both biometric or passcode gated, hardware-backed required
- Optional passphrase instead of a PIN
- Images decrypted and shown in native code; the decrypted file never enters JavaScript
- Indexes padded to 256 KiB
- Per-vault secrets replaced on wipe, so pre-wipe copies stay dead
- Attempt delay after 4 wrong PINs (30 s up to 1 h)
- Filler blobs keep both vault folders identical in count and size
- Constant-path, fixed-minimum-time unlock
- Crypto-shred wipe that completes in normal unlock time and opens the decoy
- Random slot order, random vault names, random padding slot
- Files padded to 64 KiB blocks, random on-disk names, encrypted index
- Custom keypad: PIN never touches the system keyboard or a JS string in state; digits shuffled each time; in release builds the digits are drawn as vector graphics with no labels, so accessibility services see only unnamed keys
- Auto-lock on idle (90 s) and on background; key zeroed on lock
- Screenshot/recording prevention on every screen, the PIN keypad included (`FLAG_SECURE` from the first frame on Android via `plugins/withSecureWindow.js`, `expo-screen-capture` on iOS); touches through other apps' overlays are ignored
- Backups and Android device-to-device transfer disabled (`allowBackup=false` plus data-extraction rules, Keychain this-device-only), iOS `NSFileProtectionComplete`
- Image and text preview; explicit, warned export via the share sheet
- Minimal UI: one typeface, no cards, no labels that reveal vault type
- `EXPO_PUBLIC_SOFTWARE_KEYS=1` testing mode for emulators, clearly labelled on the lock screen; `scripts/check-release.js` fails store builds that set it

## Drawbacks and limitations

- **Numeric PINs only.** The keypad is 0–9; setup requires 6–12 digits (the lock screen still accepts 4 for vaults set up earlier). A 6-digit PIN is ~1 M possibilities; the hardware binding is what makes that survivable (guesses must run on this phone), but it is still the weakest link. A passphrase mode is the single most valuable upgrade.
- **Argon2id runs on the JS thread.** The UI freezes for the duration of one derivation (~0.5–1 s on a mid-range phone; tune `KDF_OPS`/`KDF_MEM` in `lib/vault.ts`). Setup runs it three times.
- **Whole files in memory.** Encrypt/decrypt is one shot; files of a few hundred MB will exhaust memory. Chunked `crypto_secretstream` is the fix.
- **No recovery.** Forget the first PIN and the files are gone. There is deliberately no backup, export of the vault, or cloud sync.
- **One theme.** Light only.
- **Storage roughly doubles** because of filler, and deleting files does not free space.
- **Screen readers cannot use the keypad** in release builds: the digits are drawn as graphics with no labels so accessibility services cannot log PINs. A passphrase works with screen readers.
- **Setup asks for the fingerprint or passcode three times** on Android 11+ (one hardware operation per prompt, one per PIN).
- **Export opens the whole file to another app** — that app's copy is outside Cube's control.
- **Adding or removing biometrics** does not break the vault (`BIOMETRY_ANY_OR_DEVICE_PASSCODE`); the flip side is that the device passcode alone passes the hardware gate.
- **Deniability is about which PIN, not whether the feature exists.** Anyone who reads this README knows the app supports a decoy and a wipe.

## Known bugs and untested areas

Honest list. Items marked *untested* are expected to work from the API documentation but have not been exercised on hardware by the author.

1. *Untested on physical phones.* End-to-end runs pass on an Android 17 emulator and an iOS 26 simulator (see Testing), but both use software keys: StrongBox/TEE, the Secure Enclave and real biometric prompts have not been exercised.
2. **Android `content://` URIs** — the document picker is called with `copyToCacheDirectory: true` so a `file://` copy is read; if a device returns a `content://` URI anyway, `readUri` may fail and the add shows "That file could not be added."
3. **Cancelling the biometric prompt** shows "Unlock cancelled." based on error codes starting `E_AUTH`/`E_BIOMETRIC`; if a platform surfaces a different code, it will show "Wrong PIN" instead (safe, but confusing).
4. **Background lock while a picker is open** is suppressed by a suspend counter; if a picker rejects without resolving (killed activity), the counter still resets in `finally`, but the idle timer may fire one cycle late.
5. **Large images** are previewed via a base64 data URI; very large photos (50 MB+) may be slow or fail to render.
6. **Index growth.** The index is one JSON document rewritten on every add/delete; thousands of files will make adds slower.
7. **`Alert` as action sheet.** "Add a file" uses a three-button `Alert`, which looks like a dialog rather than a sheet, especially on Android.
8. **Photos keep their metadata.** The iOS photo picker hands over the original file, location included; it is stored encrypted, but an exported copy still carries it.
9. **StrictMode / Fast Refresh** can double-run effects in development and zero a decrypted buffer early; release builds are unaffected.

## Vulnerabilities and threat model

What the design is meant to withstand, and where it stops:

| Attacker has… | Outcome |
| --- | --- |
| A copy of the app's storage (forensic image, backup) | Nothing. Slot keys need the phone's hardware key, and a copy taken before a wipe is dead once the per-vault secret is replaced. The two vault folders look alike. |
| The locked phone, no credentials | Must pass biometric/passcode for every guess, and after 4 wrong PINs each guess waits up to 1 hour. A rooted device can reset the counter. |
| The unlocked phone, briefly | Vault is locked (background lock, idle lock). The keypad reveals nothing. |
| Root/jailbreak on the live phone | Android hardware-key vaults: cannot extract the key, but can drive the hardware to test PINs on the phone (one per prompt on Android 11+), restore old files and Keystore data to undo a wipe, and dump RAM while a vault is open. iOS and older Android vaults: can also read the master secret and guess off the phone. |
| Coercion to enter "the" PIN | Give the second or third PIN. Their behaviour is identical to the first from the outside. |

Specific weaknesses in this implementation:

1. **On vaults set up before the native module, the master secret passes through JavaScript.** `react-native-keychain` returns it as a base64 string, which cannot be zeroed. Vaults set up since (Android Keystore HMAC, iOS Secure Enclave ECDH) never expose a secret. Set an old vault up again to move it over.
2. **Short PIN space.** See Drawbacks. Offline brute force is blocked by hardware binding; on-device brute force is slowed by the attempt delay, which root can reset.
3. **Plaintext touches the cache directory.** The pickers copy the chosen file into the app cache before Cube encrypts it, and Export writes a temporary copy for the share sheet. Both copies are deleted immediately (and any left behind by a crash are deleted at the next launch), but deletion on flash storage is not erasure; fragments may survive until overwritten. The *original* file stays wherever it was — Cube cannot delete it.
4. **Per-vault, not per-file, crypto-shredding.** Deleting one file overwrites its blob with random bytes, but old flash blocks may still hold the ciphertext, decryptable with the vault key. Per-file keys would fix this.

4a. **Rollback with root.** Deleting a Keystore entry is not rollback-proof: someone with root who saved the Keystore database and the files before a wipe can restore both. Android offers no public API for rollback-resistant keys.
5. **Decrypted text files live in JS memory while viewing.** `Uint8Array.fill(0)` is best-effort. Images are decrypted and shown natively instead (falling back to the JavaScript path only if native decoding fails); export reads the file into JavaScript for the share sheet.
6. **Timing.** A 1.5 s floor covers Argon2, the keyed step and slot trial; the wipe adds two Keychain writes inside that floor. Devices slower than the floor leak nothing new but make all paths longer.
7. **No root/jailbreak or debugger detection.** Deliberately — it is bypassable and adds false confidence — but it means no warning either.
8. **Screenshot prevention is best-effort on iOS.** `expo-screen-capture` blocks Android reliably (`FLAG_SECURE`); iOS protection depends on OS behaviour and does not stop photographing the screen.
9. **Keychain items can outlive the app on iOS.** Uninstalling may leave the master secret and per-vault secrets in the Keychain; the ciphertext is gone with the app, so this is a hygiene issue rather than exposure, but reinstalling will not restore anything.
10. **Enrollment changes.** With `BIOMETRY_ANY_OR_DEVICE_PASSCODE`, someone who adds their fingerprint and knows the device passcode passes the hardware gate; they still need the PIN.
11. **Dependency trust.** Security rests on `react-native-libsodium`, `react-native-keychain`, Expo modules and the OS. Pin versions, review updates.
12. **The software-keys testing mode** (`EXPO_PUBLIC_SOFTWARE_KEYS=1`) removes hardware binding and the auth gate entirely; a storage dump of such a build is brute-forceable offline. It exists so the app can be exercised in emulators. The lock screen labels it, and `scripts/check-release.js` (run by EAS before every build, or `npm run check-release` locally) fails any build except the `emulator` and `development` profiles that sets it.
13. **No integrity protection on `h.bin` as a whole.** Each slot is authenticated; the file is not. An attacker can swap slots or truncate the file, which only makes unlocks fail (denial of service), never leaks keys.

## Roadmap

- Native preview for text and PDF; native export
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
