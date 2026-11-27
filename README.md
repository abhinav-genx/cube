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

- **Lock** — the cube, the entered digits as dots, a keypad. Confirm with the check key. A wrong PIN says only "Wrong PIN"; a storage or Keychain failure (the same whatever PIN was typed) says "Couldn’t unlock".
- **Setup** (first launch) — choose and confirm three PINs in sequence, then the vault is created.
- **Files** — a plain list. Add a photo or a document (the system action sheet on iOS, a bottom sheet on Android), tap to open, long-press to delete (the file disappears at once; the slower clean-up runs just after), lock in the top corner.
- **File** — previews images, text and PDFs. Export sends a copy to the share sheet (see the warning it shows).

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

**Every attempt runs the same path.** One Argon2id, all four slots tried with no early exit, and a 1.5 s minimum duration measured from the moment the hardware prompt is dismissed. Argon2id runs on a worker thread (a small addition to `react-native-libsodium` in `patches/`: the same libsodium function, polled from JavaScript), so the screen stays responsive while it works.

**Wipe = crypto-shred.** Entering the third PIN overwrites vault A's slot with random bytes and replaces vault A's per-vault secret (below), then returns vault B in the normal unlock time. Vault A's files stay on disk as unreadable noise, which keeps both folders looking alike. Every unlock attempt (right, wrong, decoy or wipe) rewrites `h.bin`, so its timestamp does not show that a wipe happened. Afterwards the first PIN behaves like a typo.

**Per-vault secrets.** Each vault folder has its own random secret in the Keychain/Keystore (no prompt), and the vault's key is BLAKE2b(slot key, secret). Replacing the secret on wipe also deletes its Keystore key, so a copy of the files taken before the wipe (forensic image, backup, restored folder) stays unreadable even with the first PIN.

**Attempt delay.** After 4 wrong PINs in a row, each further attempt waits 30 s, then 1, 5 and 15 minutes, then 1 hour. The count survives restarts and the wait uses a monotonic clock, so restarting the app or changing the phone's clock does not shorten it. Any PIN that opens something resets it.

**Files** each get their own random key and are encrypted in 64 KiB chunks (XChaCha20-Poly1305; each chunk's nonce carries its position and marks the last one, so chunks cannot be reordered, dropped or cut short). The plaintext is padded to whole chunks so sizes leak little, and blobs are stored under random 128-bit names with nothing constant in them. Chunking means files of any size are added, viewed and exported in constant memory. Files added before per-file keys (one message under the vault key) still open, and are re-encrypted into the chunked format with keys of their own in the background after unlocking, one at a time until none is left (the list shows how many remain). Which format a blob is in follows from its size alone, so an upgrade interrupted at any point leaves the file readable.

**The file list** (names, sizes, types and each file's key) is split into 64 pages (`l00.bin` … `l3f.bin`) by the first two hex digits of each file's id, so adding or deleting a file rewrites one 64 KiB page, not the whole list. Both vaults have all 64 pages from setup on, and page n always has the same size in both folders, however many files either vault holds: when a page outgrows its size, the same page in the other folder grows to match (random bytes appended, since that vault's key is not at hand; its reader skips them), and sizes never shrink. Older vaults (one `i.bin`, or 16 pages `i0.bin` … `if.bin`) move into the 64 pages the first time they open; new pages are written first and the old files are overwritten with random bytes only once the last page is safely written, so a kill at any point loses nothing. Migrated vaults keep the old names as random filler, in both folders alike; vaults set up since then never have them.

**List secrets: deletes that stick.** The pages are encrypted with a list key: BLAKE2b of a *list secret* kept in the Keychain/Keystore, keyed by the vault key. Every delete replaces the list secret and rewrites all pages under the new key (right after the file leaves the list, so the delete itself feels instant), so old copies of pages that flash storage keeps around, which still hold the deleted file's key, can no longer be decrypted, even with the right PIN. The next secret is stored as pending before any page is rewritten and readers try both keys, so a kill mid-rotation leaves the list readable and the next change finishes it.

**Native preview and export.** Images and text files are decrypted (HChaCha20 plus ChaCha20-Poly1305: the platform's where it has one, and a pure-Kotlin implementation on Android 7–8) in native code (`modules/cube-native`) and shown by a native view, so the decrypted file never enters JavaScript; on Android image pixels are wiped when the viewer closes. On Android, export offers two choices: “Without a copy” streams the file through a private content provider straight into the receiving app, decrypting into a pipe, with no readable copy on storage (the link works until the vault locks or for 2 minutes); “As a file” writes a temporary copy, deleted when you come back, for apps that must seek in a file or keep it. On iOS, export decrypts into memory and hands that to the share sheet under the file's name, with no file in the app's folder (files over 256 MB use a temporary copy instead). The native code is checked against vectors from the JavaScript implementation in both directions (see Testing).

**Passphrases.** Setup offers a passphrase instead of a PIN (at least 8 characters, any characters); the lock screen opens in the chosen mode and can switch. The passphrase field is native (`CubeSecureField`): JavaScript only learns its length, and on submit takes it as UTF-8 bytes (NFC) while the field clears itself, so the passphrase never becomes a JavaScript string. (Native text fields keep their own copy until cleared.)

**Filler.** Every blob written to one vault folder gets a same-size blob of random bytes in the other, a deleted file is overwritten with random bytes rather than removed, and after each unlock the two folders are evened out. Someone with a copy of storage sees two folders with the same number and sizes of blobs, so the size of the vault you did not open stays hidden. Storage use roughly doubles and never shrinks.

**Hardware binding.** A copy of the app's storage is useless without the phone: every guess has to run through the device's secure hardware. Android: the Keystore HMAC key; iOS: the Secure Enclave key; both biometric or passcode gated and `this device only`. On iOS the vault folder is also excluded from backups.

**Session.** The open vault's key lives in one in-memory store. It is zeroed on lock, after 90 s without a touch, and when the app goes to the background (unless a picker or share sheet that the app opened is up, and then for at most 2 minutes, counted exactly; a picker that never returns cannot keep auto-lock off).

**Adding files.** Every file is read, cleaned and encrypted in native code, so none enters JavaScript. Photos lose their location and camera details (`CubeStrip`, byte-for-byte the same as `lib/strip.ts`), JPEG XL included. PDFs stream through a cleaner that blanks author, creator, producer, title, subject, keywords and XMP in place (`CubeDocClean`, byte-for-byte the same machine as `lib/docmeta.ts`), at any size; compressed object streams (where recent tools put the author) and compressed XMP streams are decompressed, blanked and recompressed at the same offset first, so the file keeps its length and every offset stays valid. Office files are rewritten while being read in place: the zip's directory is read first, the document properties are emptied, and every other part is copied as it is, still compressed, so size is no limit either. Inside Office files the names of people who commented, tracked changes or co-authored, paths naming the user's folders (template links, Excel's saved location) and embedded photos are cleaned as well, XML parts of any size (large ones stream through the cleaner); OpenDocument files (odt, ods, odp, odg) and EPUBs get the same treatment, and zip64 files are read too. Office 97–2003 files (doc, xls, ppt, and Visio and Publisher files), and encrypted Office files, which share that format, lose the title, author, last editor, company, manager, keywords, comments and custom properties in their summary, and the user name Excel and PowerPoint keep, edited in place. PDFs also lose camera details from embedded JPEG photos, and compressed streams with PNG predictors, an indirect length (even one kept inside an object stream) or LZW, ASCII85, ASCIIHex and run-length encoding (alone or chained with Flate) are cleaned like the rest. Videos and audio (MP4, MOV, M4A, 3GP, AVI, MP3, FLAC, WAV, AIFF, Ogg Vorbis/Opus/FLAC/Theora, Matroska and WebM) lose their location, device make and model, software, titles, track and chapter names, comments and cover art, edited in place at the same length (`CubeMediaClean`, the same patches as `lib/mediameta.ts`): metadata boxes become `free` boxes, tags become padding or Void elements, and Ogg comment headers are emptied with their page checksums updated, so every offset stays valid and the sound and picture are untouched; creation dates stay. The location tracks that action cameras record beside the video (GoPro, Google CAMM, DJI, Sony, and DJI subtitle tracks that print the position) are removed with their samples, Insta360 trailers lose their GPS fixes and serial number, and motion-JPEG frames lose their Exif and comments. RTF files lose their author, operator, company, revision and comment authors and generator as they stream, and SVG files their comments, metadata and the editor attributes that hold file paths. Everything else streams 1 MiB at a time. On Android the picked document is read where it is (`content://`). On iOS, Cube's own pickers open documents where they are (no copy in the app's folder) and hand photos over in memory, in their original format, without recompression and without Photos permission. Cube only ever deletes files inside its own cache folder, never a picked original.

## Installing

Builds are attached to each [GitHub release](https://github.com/abhinav-genx/cube/releases). Read the status note above first: Cube is unaudited and has not yet been tested on a physical phone.

- **Android** (8 or later, with a screen lock set): download `Cube-<version>.apk`, allow installs from your browser or file manager when Android asks, and open it. The APK is signed with Cube's release key; its SHA-256 certificate fingerprint is in the release notes, and `apksigner verify --print-certs Cube-<version>.apk` shows it. Updates must carry the same key.
- **iOS** (15.1 or later): `Cube-<version>-unsigned.ipa` is not signed, so it does not install by tapping it. Sideload it with [AltStore](https://altstore.io) or [Sideloadly](https://sideloadly.io), which sign it with your own Apple ID (a free Apple ID's signature lasts 7 days, then the app has to be refreshed).

Check a download against the SHA-256 checksum in the release notes (`shasum -a 256 <file>`).

## Running it

Native modules (libsodium, keychain, `modules/cube-native`) mean **Expo Go will not work**; you need a development build.

`npm install` runs `patch-package` (`patches/react-native-libsodium+1.7.0.patch`): react-native-libsodium's iOS bridge used `RCTCxxBridge`, which React Native 0.80+ removed; the patch reads the JS runtime from the bridge proxy instead. On iOS, run `pod install` with a UTF-8 locale (`LANG=en_US.UTF-8`) or CocoaPods fails.

```sh
npm install
npx expo prebuild          # generates ios/ and android/ (git-ignored)
npx expo run:android       # or: npx expo run:ios
```

Requirements: Node 20+, a device or emulator **with a lock screen (and ideally biometrics) set up**, Android 8+ with hardware-backed Keystore, iOS 15.1+. Without a lock screen, setup fails with "Check that a device lock screen is set".

For a release build: `npx expo run:android --variant release` / `npx expo run:ios --configuration Release`, or `eas build`. Do not ship debug builds — they expose the dev menu and Hermes heap. Android release builds are signed with your own key, never the debug key (`plugins/withReleaseSigning.js` stops a release build without one): set `CUBE_RELEASE_STORE_FILE`, `CUBE_RELEASE_STORE_PASSWORD`, `CUBE_RELEASE_KEY_ALIAS` and `CUBE_RELEASE_KEY_PASSWORD`, then `cd android && ./gradlew assembleRelease`. An unsigned iOS archive for sideloading: `xcodebuild -workspace ios/Cube.xcworkspace -scheme Cube -configuration Release -sdk iphoneos -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO build`, then zip `Cube.app` inside a `Payload/` folder as `Cube.ipa`.

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
npm test               # unit tests (Node's test runner, no extra dependencies), ~90 s
npm run typecheck
npm run check-release  # fails if a release build would ship with software keys
```

GitHub Actions (`.github/workflows/ci.yml`) runs the typecheck and the unit tests on Node 24 and 26 for every push and pull request.

The native code is checked against the JavaScript code in both directions: it must decrypt blobs JavaScript wrote (through the platform cipher and the pure-Kotlin one), produce byte-identical photo, PDF, RTF, XML (Office parts, OpenDocument, SVG) and video/audio cleaning on the same inputs (PDFs and RTF fed in pieces of 1 byte to 1 MiB), write blobs JavaScript decrypts (whole and streamed), rewrite Office, OpenDocument and EPUB files into zips with the same parts and contents as `lib/docmeta.ts` gives, and clean whole PDFs (compressed streams, predictors, indirect lengths, embedded JPEGs, LZW, ASCII85, ASCIIHex and run-length streams, lengths inside object streams) to the same contents:

```sh
node --import ./tests/register.mjs tests/native/make-vectors.mjs /tmp/vectors
swiftc -parse-as-library modules/cube-native/ios/CubeCrypto.swift modules/cube-native/ios/CubeStrip.swift modules/cube-native/ios/CubeDocClean.swift modules/cube-native/ios/CubeMediaClean.swift tests/native/crypto-check.swift -o /tmp/cc && /tmp/cc /tmp/vectors
(cd android && CUBE_VECTORS=/tmp/vectors ./gradlew :cube-native:testDebugUnitTest)   # after expo prebuild
node --import ./tests/register.mjs tests/native/check-native-out.mjs /tmp/vectors     # JS reads what native wrote
```

The unit tests (`tests/*.test.mjs`) run the real `lib/` code against libsodium's WebAssembly build, with the Keychain, the native module and the file system replaced by fakes (`tests/mocks/`). They cover the vault format, all three PINs and the wipe, hardware binding, equal unlock timing, the attempt delay, blob padding and tampering, the chunked per-file-key format (tampering, reordering, truncation), streamed adds and exports, the paged file list and its migration (including a kill at every step), filler balance, a lock during an add or delete, crash recovery at every disk step, auto-lock around pickers, unlock-error messages, the background Argon2 path, safe deletion of picker copies, deletes that return before their background clean-up, document cleaning (PDFs streamed at every split point, predictors, indirect lengths and embedded photos, the LZW, ASCII85, ASCIIHex and run-length filters; Office, OpenDocument, EPUB and zip64 files; RTF and SVG; real samples in `tests/fixtures/`), video and audio metadata removal (MP4/MOV from ffmpeg and from AVFoundation, M4A, MP3, FLAC, WAV, AIFF, Ogg Vorbis, Opus, Ogg FLAC, Matroska and WebM in `tests/fixtures/media/`, made by `make.sh`, and an action-camera GPS track), and photo metadata removal (real JPEG/HEIC/PNG/WebP files in `tests/fixtures/`, made and checked with Apple's ImageIO by `tests/fixtures/images.swift`).

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
  files.ts         paged encrypted file list, per-file keys, streamed add / read / export / remove
  strip.ts         removes location and camera details from photos
  docmeta.ts       removes author and organisation details from documents
  mediameta.ts     removes location, device and names from videos and audio
  session.ts       in-memory key, idle + background lock
  usePin.ts        PIN buffer hook (Uint8Array in a ref)
  theme.ts, format.ts
tests/               unit tests (npm test), fakes in tests/mocks/, device tests in tests/e2e/,
                     native decrypter vectors in tests/native/, image fixtures in tests/fixtures/
.github/workflows/   CI: typecheck and unit tests
scripts/gen_logo.py  regenerates components/logoPaths.ts and assets/*.png
scripts/check-release.js  fails release builds made with software keys
modules/cube-native/  local Expo module: hardware keys (Android Keystore HMAC, iOS Secure Enclave),
                      native image/text preview and export (CubeCrypto.kt / CubeCrypto.swift),
                      keyboard check (Android), iOS backup exclusion
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
- Images, text and PDFs decrypted and shown in native code (PDFs from memory, with copying and links turned off), and exports decrypted natively; the decrypted file never enters JavaScript
- Light and dark appearance, following the system; on iPad, every orientation, with content kept to a phone's width
- A random key per file and 64 KiB chunked encryption: deleting a file destroys its key, and files of any size use constant memory
- File list split into 64 encrypted pages, so adds and deletes stay fast with thousands of files
- A list secret replaced on every delete, so old copies of the file list left on flash cannot be decrypted
- Photos and videos cleaned and encrypted in native code; PDFs, Office, OpenDocument, EPUB, RTF and SVG files cleaned of author and organisation details, and audio of its tags
- Native passphrase field: the passphrase never becomes a JavaScript string
- Android export through a pipe: no readable copy on storage
- Android reads picked documents in place: no plaintext copy in the cache
- Argon2id on a worker thread, so the screen stays responsive during unlock
- Warns when a third-party Android keyboard would receive the passphrase
- Native preview and export on every supported Android version (pure-Kotlin cipher on Android 7–8)
- Leftover keys from an uninstalled copy (iOS keeps Keychain items) are cleared before setup
- Photos lose their location and camera details when added (`lib/strip.ts`): GPS, camera and lens make/model, serial numbers, owner name, maker notes, XMP and IPTC are removed losslessly from JPEG, HEIC, PNG, WebP and JPEG XL; pixels, orientation and dates are kept, so exported copies carry no location either
- File-list pages padded to 64 KiB, all 64 present in both vaults
- Per-vault secrets replaced on wipe, so pre-wipe copies stay dead
- Attempt delay after 4 wrong PINs (30 s up to 1 h)
- Filler blobs keep both vault folders identical in count and size
- Constant-path, fixed-minimum-time unlock
- Crypto-shred wipe that completes in normal unlock time and opens the decoy
- Random slot order, random vault names, random padding slot
- Files padded to 64 KiB blocks, random on-disk names, encrypted index
- Custom keypad: PIN never touches the system keyboard or a JS string in state; digits shuffled each time; in release builds the digits are drawn as vector graphics with no labels, so accessibility services see only unnamed keys
- Auto-lock on idle (90 s) and on background; key zeroed on lock
- Screenshot/recording prevention on every screen, the PIN keypad included (`FLAG_SECURE` from the first frame on Android via `plugins/withSecureWindow.js`; on iOS `expo-screen-capture`'s secure-layer technique, retried until it attaches and re-applied on every return to the app); the iOS app-switcher snapshot is fully blurred; touches through other apps' overlays are ignored
- Backups and Android device-to-device transfer disabled (`allowBackup=false` plus data-extraction rules, Keychain this-device-only), iOS `NSFileProtectionComplete`
- Image and text preview; explicit, warned export via the share sheet
- Minimal UI: one typeface, no cards, no labels that reveal vault type
- `EXPO_PUBLIC_SOFTWARE_KEYS=1` testing mode for emulators, clearly labelled on the lock screen; `scripts/check-release.js` fails store builds that set it

## Drawbacks and limitations

- **PINs are short.** Setup requires 8–12 digits, ~100 M possibilities (the lock screen still accepts 4 or 6 for vaults set up earlier; a 6-digit PIN is ~1 M). The hardware binding is what makes that survivable (guesses must run on this phone), but it is still the weakest link. Choose passphrase mode at setup for more.
- **Argon2id takes time.** One derivation is ~0.5–1 s on a mid-range phone (tune `KDF_OPS`/`KDF_MEM` in `lib/vault.ts`); setup runs it three times. It runs off the JS thread, so the screen stays responsive.
- **Photos are held in memory whole** while their metadata is removed (in native code); documents and other files stream.
- **No recovery.** Forget the first PIN and the files are gone. There is deliberately no backup, export of the vault, or cloud sync.
- **PDF preview needs Android 11 or later** (it renders from a memory file, which older versions cannot make); on older phones PDFs open through Export.
- **Storage roughly doubles** because of filler, and deleting files does not free space.
- **Screen readers cannot use the keypad** in release builds: the digits are drawn as graphics with no labels so accessibility services cannot log PINs. A passphrase works with screen readers.
- **Setup asks for the fingerprint or passcode three times** on Android 11+ (one hardware operation per prompt, one per PIN).
- **Export opens the whole file to another app** — that app's copy is outside Cube's control.
- **Adding or removing biometrics** does not break the vault (`BIOMETRY_ANY_OR_DEVICE_PASSCODE`); the flip side is that the device passcode alone passes the hardware gate.
- **Deniability is about which PIN, not whether the feature exists.** Anyone who reads this README knows the app supports a decoy and a wipe.

## Known bugs and untested areas

Honest list. Items marked *untested* are expected to work from the API documentation but have not been exercised on hardware by the author.

1. *Untested on physical phones.* End-to-end runs pass on an Android 17 emulator and an iOS 26 simulator (see Testing), but both use software keys: StrongBox/TEE, the Secure Enclave and real biometric prompts have not been exercised.
2. **Cloud files that are not on the phone** (a Google Drive file not yet downloaded, offline) cannot be read; Cube says so and asks to open the file once in its own app first. On iOS an iCloud file that is not downloaded is fetched before it is read.
3. **Unlock error messages** depend on the platform's error codes: Cube maps cancels, lockouts and a missing screen lock from its own module and from `react-native-keychain`'s messages; anything else shows "Couldn’t unlock", which reveals nothing about the PIN (such failures happen the same way whatever was typed).
4. **Images the phone cannot decode** (an unusual format) are previewed from a base64 data URI, up to 20 MB; larger ones, or ones that still fail, show a note and open through Export.
5. **Old files are upgraded in the background.** Files added before per-file keys are re-encrypted with keys of their own after unlocking, one at a time until none is left; locking pauses it and the next unlock continues. Until then they stay under the vault key.
6. **Metadata removal covers common formats only.** Photos: JPEG, HEIC/HEIF/AVIF, PNG, WebP, JPEG XL, GIF and TIFF, and TIFF- and HEIF-based camera RAW files; SVG is cleaned as a document; BMP carries nothing to remove; other image types are stored as picked. Documents: PDF, Office (Office 97–2003 too), OpenDocument, EPUB, RTF and SVG, at any size. Word 97–2003 files keep the names of tracked-change and comment authors stored inside the document stream (their summary is cleaned), and encrypted Office files keep whatever is inside the encryption. Photos larger than 32 MB inside Office files are copied as they are. PDF metadata streams with image-only filters (JBIG2, CCITT, never used for text) keep their contents, as does a stream that cannot be made to fit even in its shortened form. Video and audio: MP4/MOV/M4A/3GP, AVI, MP3 (ID3v1, ID3v2, APEv2), FLAC, WAV, AIFF, Ogg (Vorbis, Opus, FLAC, Theora, Speex; chained files too), Matroska and WebM; other containers (MPEG-TS, FLV, ASF/WMV) are stored as picked. Details encoded inside the picture or sound itself (an encoder's signature in an audio frame, for example) stay. Music files lose their titles, artists and cover art along with everything else; WAV and FLAC lose their dates too. Dates are kept on purpose elsewhere. The JavaScript fallback (no native module) cleans PDFs only outside compressed streams, and zip documents, Office 97–2003 files, SVG, video and audio only up to 50 MB.
7. **StrictMode / Fast Refresh** can double-run effects in development and zero a decrypted buffer early; release builds are unaffected.

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
3. **Plaintext can still touch storage in a few places.** Cube's own iOS pickers read documents in place and hand photos over in memory, and iOS export shares from memory; but exports over 256 MB on iOS, and “As a file” on Android, write a temporary copy, and the receiving app may store what it is given. Android reads documents in place and “Without a copy” exports through a pipe. Copies are deleted immediately (and any left behind by a crash are deleted at the next launch), but deletion on flash storage is not erasure; fragments may survive until overwritten. The *original* file stays wherever it was — Cube cannot delete it.
4. **Crypto-shredding has limits.** Deleting a file removes its key, overwrites its blob with random bytes and replaces the list secret, so neither leftover ciphertext nor old copies of the file list can be read afterwards. What remains: Keychain/Keystore storage itself is not rollback-proof against root (see 4a); files added before per-file keys are decryptable with the vault key until the background upgrade reaches them; and pages written before list secrets existed (under the plain vault key) may survive on flash.

4a. **Rollback with root.** Deleting a Keystore entry is not rollback-proof: someone with root who saved the Keystore database and the files before a wipe can restore both. Android offers no public API for rollback-resistant keys.
5. **Decrypted data in memory.** Photos are added, and images and text shown and exported, in native code, so their plaintext stays out of JavaScript (JavaScript is the fallback only for an image the platform cannot decode). Native strings and bitmaps are released, and Android bitmaps wiped, when the viewer closes; text strings cannot be wiped. Documents, videos and audio are cleaned in native code too; only without the native module do they pass through JavaScript. The file list (names and per-file keys) is held as JavaScript strings while a vault is open: names have to be text to be shown.
6. **Timing.** A 1.5 s floor covers Argon2, the keyed step and slot trial; the wipe adds two Keychain writes inside that floor. Devices slower than the floor leak nothing new but make all paths longer.
7. **No root/jailbreak or debugger detection.** Deliberately — it is bypassable and adds false confidence — but it means no warning either.
8. **Screenshot prevention is best-effort on iOS.** Android blocks capture reliably (`FLAG_SECURE`). On iOS, `expo-screen-capture` renders the app inside a secure layer that screenshots and recordings leave blank, and Cube re-applies it whenever the app returns to the foreground; this relies on iOS behaviour that Apple does not document as a security feature, and nothing stops photographing the screen.
9. **Keychain items can outlive the app on iOS.** Uninstalling may leave the master secret and per-vault secrets in the Keychain until Cube is set up again (setup clears them first). The ciphertext is gone with the app, so this is hygiene rather than exposure.
10. **Enrollment changes.** With `BIOMETRY_ANY_OR_DEVICE_PASSCODE`, someone who adds their fingerprint and knows the device passcode passes the hardware gate; they still need the PIN.
11. **Dependency trust.** Security rests on `react-native-libsodium`, `react-native-keychain`, Expo modules and the OS. Pin versions, review updates.
12. **The software-keys testing mode** (`EXPO_PUBLIC_SOFTWARE_KEYS=1`) removes hardware binding and the auth gate entirely; a storage dump of such a build is brute-forceable offline. It exists so the app can be exercised in emulators. The lock screen labels it, and `scripts/check-release.js` (run by EAS before every build, or `npm run check-release` locally) fails any build except the `emulator` and `development` profiles that sets it.
13. **No integrity protection on `h.bin` as a whole.** Each slot is authenticated; the file is not. An attacker can swap slots or truncate the file, which only makes unlocks fail (denial of service), never leaks keys.
14. **Third-party keyboards on Android.** In passphrase mode, the active keyboard app receives every keystroke. Cube warns when that keyboard is not part of the phone's system, but cannot stop it; the PIN pad is drawn by Cube and needs no keyboard.
15. **Two copies of storage show which folder is in use.** Someone who copies the app's storage twice, some time apart, can see which vault folder's file list changed (one page per add, all 64 pages after a delete) while the other folder's stayed the same. A single copy shows nothing. Making both folders change alike would mean writing the other vault's file list, which needs its key.

## Roadmap

Nothing planned beyond the open items under Known bugs and the hardware testing in the status note.

## Regenerating the logo

```sh
python3 scripts/gen_logo.py   # needs Pillow; rewrites components/logoPaths.ts and assets/*.png
```

The leaf is a seven-leaflet outline with teeth that point toward the tip, mapped onto each cube face with an affine matrix so it sits on the surface rather than in front of it.

## License

MIT — see [LICENSE](LICENSE). Use, change and share it freely; the software comes with no warranty.
