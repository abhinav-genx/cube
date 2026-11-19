// End-to-end tests on an Android emulator or phone with a DEBUG build of Cube installed
// (debug builds label the keypad keys; release builds deliberately do not) and Metro running.
//   adb reverse tcp:8081 tcp:8081 && node --test tests/e2e/android.e2e.mjs
// WARNING: clears Cube's data on the device.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { pdf15 } from '../fixtures/pdf15.mjs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  PKG, adb, dump, enterPin, focused, has, launch, longPress, runAs, screenText, sh, sleep, stop, tap, typeText, waitFor,
} from './android-driver.mjs';

const A = '13579024', B = '24680135', C = '97531086';
const MARKER = 'CUBE-E2E-SECRET-7f3a91';
const DOC = 'cube-e2e-secret.txt';
const PHOTO = 'cube-e2e-photo.jpg';
const PDF = 'cube-e2e-doc.pdf';   // tests/fixtures/doc.pdf: Author "Jane Doe", Creator "Acme Writer"
const PDF15 = 'cube-e2e-pdf15.pdf';   // tests/fixtures/pdf15.mjs: the same, inside compressed streams
const results = {};

function pushFixtures() {
  const dir = tmpdir();
  writeFileSync(join(dir, DOC), `${MARKER}\nThis line must never appear in plaintext on disk.\n`);
  // A real JPEG (red 64x64) so the native decoder has something to decode.
  execFileSync('sips', ['-s', 'format', 'jpeg', '-z', '480', '640', '/System/Library/Desktop Pictures/.thumbnails/Big Sur Coastline.heic', '--out', join(dir, PHOTO)], { stdio: 'ignore' });
  execFileSync('cp', [new URL('../fixtures/doc.pdf', import.meta.url).pathname, join(dir, PDF)]);
  writeFileSync(join(dir, PDF15), pdf15());
  for (const f of [DOC, PHOTO, PDF, PDF15]) adb('push', join(dir, f), `/sdcard/Download/${f}`);
  sh(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/${PHOTO} >/dev/null 2>&1`);
}

async function unlockWith(pin) {
  await waitFor('Confirm');
  await enterPin(pin);
}
async function openVault(pin) {
  await toLockScreen();
  await unlockWith(pin);
  await waitFor('Files', { timeout: 20_000 });
  await waitFor('Add file');
}
/** Start each scenario from the lock screen, whatever the last one left behind. */
async function toLockScreen() {
  const nodes = dump();
  if (has('Confirm', nodes) && !has('Add file', nodes)) return;
  // A launch straight after a force-stop occasionally sticks on the splash or never shows the
  // window (the emulator stays on its home screen): retry a few times.
  for (let attempt = 1; ; attempt++) {
    stop();
    launch();
    try {
      await waitFor('Confirm', { timeout: 30_000 });
      return;
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
}
async function lockVault() {
  await tap('Lock');
  await waitFor('Confirm');
}

/** Picks a file from the system document picker by its name. */
async function pickFromDownloads(name) {
  await waitFor(/Recent|Downloads|Files|Browse|Open from/i, { timeout: 15_000 });
  if (!has(new RegExp(`^${name.replace(/\./g, '\\.')}(,|$)`))) {
    // Navigate: hamburger/roots → Downloads
    const nodes = dump();
    const roots = nodes.find((n) => /Show roots|navigation/i.test(n.desc));
    if (roots) await tap(roots);
    await tap(/^Downloads?$/);
  }
  // The picker labels items "name, size, date" (grid) or by name alone (list).
  await tap(new RegExp(`^${name.replace(/\./g, '\\.')}(,|$)`), { timeout: 15_000 });
}

async function addFile(kind, name) {
  await waitFor('Add file');
  for (let i = 0; i < 3 && !has(/^Add a file$/); i++) {
    await tap('Add file');
    await sleep(1500);
  }
  await tap(new RegExp(`^${kind}$`, 'i'));   // the bottom sheet's choices
  await pickFromDownloads(name);
  await waitFor('Files', { timeout: 20_000 });
  await waitFor(name, { timeout: 45_000 });   // the first add after a cold start can be slow on an emulator
}

/** Files in the vault folders: { path, size }. */
function storage() {
  return runAs('cd files/d && find . -type f -exec stat -c "%s %n" {} +')
    .trim().split('\n').filter(Boolean)
    .map((l) => { const [size, p] = l.trim().split(' '); return { path: p.replace(/^\.\//, ''), size: Number(size) }; });
}
/** The failed-attempt counter in a.bin. */
const failures = () => {
  const b = runAs('od -An -tu1 files/d/a.bin').trim().split(/\s+/).map(Number);
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
};
/** Overwrites the counter (the app must be stopped: it caches the count in memory). */
const setFailures = (n) => {
  const oct = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].map((b) => '\\' + b.toString(8).padStart(3, '0')).join('');
  runAs(`printf "${oct}" > files/d/a.bin`);
};
const blobs = (dir) => storage().filter((f) => new RegExp(`^${dir}/[0-9a-f]{32}\\.bin$`).test(f.path)).map((f) => f.size).sort((a, b) => a - b);

/** True when a grep for `needle` over every file the app owns finds nothing. */
function nowhereOnDisk(needle) {
  const out = runAs(`grep -rl "${needle}" . 2>/dev/null; echo end`).trim();
  return out === 'end' ? [] : out.split('\n').filter((l) => l !== 'end');
}

before(() => {
  stop();
  sh(`pm clear ${PKG}`);
  // Debug builds reach Metro over the network; Android 17 asks for local-network access first.
  sh(`pm grant ${PKG} android.permission.ACCESS_LOCAL_NETWORK 2>/dev/null; true`);
  sh('logcat -c');
  pushFixtures();
  launch();
});
after(() => {
  console.log('E2E-RESULTS ' + JSON.stringify(results));
});

describe('setup', () => {
  test('a fresh install opens setup', async () => {
    await waitFor('Choose the PIN that opens your files.', { timeout: 60_000 });
  });

  test('rejects a 7-digit PIN, a mismatched confirmation and a reused PIN', async () => {
    await enterPin('1234567');
    await sleep(500);
    assert.ok(has('Choose the PIN that opens your files.'), 'still on the first step');
    // clear the 7 digits
    const del = dump().find((n) => n.desc === 'Delete digit');
    sh(Array(7).fill(`input tap ${del.cx} ${del.cy}`).join('; '));

    await enterPin(A);
    await waitFor('Enter it once more.');
    await enterPin('11111111');
    await waitFor('The two entries differ. Enter this PIN again.');
    await enterPin(A);
    await waitFor('Enter it once more.');
    await enterPin(A);
    await waitFor('Choose a second PIN.');
    await enterPin(A);
    await waitFor('Use a different PIN for each.');
  });

  test('creates the vault with three PINs', async () => {
    await enterPin(B);
    await waitFor('Enter the second PIN once more.');
    await enterPin(B);
    await waitFor('Choose a third PIN.');
    await enterPin(C);
    await waitFor('Enter the third PIN once more.');
    const t0 = Date.now();
    await enterPin(C);
    await waitFor('Your vault is ready.', { timeout: 60_000 });
    results.setupMs = Date.now() - t0;
    await tap('Go to the lock screen');
    await waitFor('Confirm');
    const files = storage().map((f) => f.path).sort();
    for (const p of ['h.bin', 'a.bin', 'p.bin', '0/l00.bin', '1/l3f.bin']) assert.ok(files.includes(p), `${p} in ${files}`);
    assert.ok(!files.some((p) => /\/i[0-9a-f]?\.bin$/.test(p)), 'no files of the older layouts in a new vault');
    assert.equal(storage().find((f) => f.path === 'h.bin').size, 320);
  });

  test('cube://setup cannot reach setup once a vault exists', async () => {
    sh(`am start -a android.intent.action.VIEW -d cube://setup ${PKG} >/dev/null`);
    await sleep(2500);
    assert.ok(!has(/Choose the PIN/), 'setup screen not shown');
    await waitFor('Confirm');
  });
});

describe('daily use', () => {
  test('PIN A opens an empty vault; unlock takes at least 1.5 s', async () => {
    await waitFor('Confirm');
    const t0 = Date.now();
    await enterPin(A);
    await waitFor('No files yet. Add one with the button below.', { timeout: 20_000 });
    results.unlockMs = Date.now() - t0;
    assert.ok(results.unlockMs >= 1500);
  });

  test('adds a document through the system picker', async () => {
    await addFile('Document', DOC);
  });

  test('opens the document and shows its text', async () => {
    await tap(DOC);
    await waitFor(new RegExp(MARKER), { timeout: 15_000 });
  });

  /** Opens Export and picks one of the Android choices. */
  async function exportAs(choice) {
    await tap('Export');
    await waitFor('Export this file?');
    await tap(new RegExp(`^${choice}$`, 'i'));
    await waitFor(/Share|Nearby|Copy|Messages|Gmail|Drive/i, { timeout: 15_000 });
  }

  test('“Without a copy” shares through a pipe: nothing readable is written', async () => {
    await exportAs('Without a copy');
    const during = runAs('ls -R cache/cube-export 2>/dev/null; echo end').trim();
    assert.ok(!during.includes(DOC), `no export copy while sharing: ${during}`);
    sh('input keyevent KEYCODE_BACK');
    await waitFor('Export', { timeout: 10_000 });
  });

  test('“As a file” writes a temporary copy only while the share sheet is open', async () => {
    await exportAs('As a file');
    const during = runAs('ls -R cache/cube-export 2>/dev/null; echo end');
    assert.ok(during.includes(DOC), `export copy present while sharing: ${during}`);
    sh('input keyevent KEYCODE_BACK');
    await waitFor('Export', { timeout: 10_000 });
    await sleep(1000);
    const afterShare = runAs('ls cache/cube-export 2>/dev/null; echo end').trim();
    assert.equal(afterShare, 'end', 'export copy removed after the share sheet closed');
  });

  test('back to the list, then lock', async () => {
    await tap('Back');
    await waitFor('Add file');
    await lockVault();
  });

  test('nothing readable on disk: no file names, no contents, picker copies gone', async () => {
    assert.deepEqual(nowhereOnDisk(MARKER), []);
    assert.deepEqual(nowhereOnDisk('cube-e2e-secret'), []);
    const pickerFiles = runAs('find cache/DocumentPicker cache/ImagePicker -type f 2>/dev/null; echo end').trim();
    assert.equal(pickerFiles, 'end', `picker copies removed: ${pickerFiles}`);
  });

  test('both vault folders hold the same blob sizes and equal-size file lists', async () => {
    assert.deepEqual(blobs(0), blobs(1));
    assert.equal(blobs(0).length, 1);
    const s = storage();
    // the 64 file-list pages exist in both folders, same sizes
    const pageNames = Array.from({ length: 64 }, (_, n) => `l${n.toString(16).padStart(2, '0')}.bin`);
    for (const name of pageNames) {
      const a = s.find((f) => f.path === `0/${name}`), b = s.find((f) => f.path === `1/${name}`);
      assert.ok(a && b, `${name} in both folders`);
      assert.equal(a.size, b.size, name);
    }
  });
});

describe('decoy vault', () => {
  test('PIN B opens a separate, empty vault', async () => {
    await openVault(B);
    assert.ok(!has(DOC), 'vault A files not visible');
    await waitFor('No files yet. Add one with the button below.');
  });

  test('adds a photo and shows it with the native viewer', async () => {
    await addFile('Photo', PHOTO);
    await tap(PHOTO);
    await waitFor(PHOTO);   // the native view carries the name as its description
    await sleep(1500);
    assert.ok(!has('This file could not be opened.'));
    results.meminfoViewingKB = Number((sh(`dumpsys meminfo ${PKG} | grep 'TOTAL PSS'`).match(/TOTAL PSS:\s+(\d+)/) ?? [])[1]);
    await tap('Back');
  });

  test('a PDF is stored without its author and creator', async () => {
    await addFile('Document', PDF);
    await tap(PDF);
    await waitFor('Export');
    await tap('Export');
    await waitFor('Export this file?');
    await tap(/^As a file$/i);
    await waitFor(/Share|Nearby|Copy|Messages|Gmail|Drive/i, { timeout: 15_000 });
    const copy = runAs(`cat "cache/cube-export/$(ls cache/cube-export | head -1)/${PDF}" 2>/dev/null || find cache/cube-export -type f -exec cat {} +`);
    sh('input keyevent KEYCODE_BACK');
    assert.ok(copy.startsWith('%PDF'), 'the exported copy is the PDF');
    assert.ok(!copy.includes('Jane Doe') && !copy.includes('Acme Writer'), 'author and creator removed');
    assert.ok(copy.includes('/Author ('), 'the PDF structure is kept');
    await waitFor('Export', { timeout: 10_000 });
    await tap('Back');
  });

  test('a PDF 1.5 loses the author hidden in its compressed streams', async () => {
    await addFile('Document', PDF15);
    await tap(PDF15);
    await waitFor('Export');
    await tap('Export');
    await waitFor('Export this file?');
    await tap(/^As a file$/i);
    await waitFor(/Share|Nearby|Copy|Messages|Gmail|Drive/i, { timeout: 15_000 });
    const where = runAs('find cache/cube-export -type f').trim().split('\n')[0];
    const copy = execFileSync('adb', ['exec-out', 'run-as', PKG, 'cat', where], { maxBuffer: 64 << 20 });
    sh('input keyevent KEYCODE_BACK');
    assert.equal(copy.length, pdf15().length, 'same length: offsets still valid');
    const t = copy.toString('latin1');
    const inflated = [...t.matchAll(/\/FlateDecode\/Length (\d+) *>>stream\n/g)].map((m) => {
      const at = m.index + m[0].length;
      return inflateSync(copy.subarray(at, at + Number(m[1]))).toString('latin1');
    });
    assert.equal(inflated.length, 2, 'the object stream and the XMP stream');
    for (const s of inflated) assert.ok(!s.includes('Jane') && !s.includes('Acme'), s);
    assert.ok(inflated[0].includes('/CreationDate(D:20250101120000Z)'), 'the date is kept');
    await waitFor('Export', { timeout: 10_000 });
    await tap('Back');
    await lockVault();
  });
});

describe('auto-lock', () => {
  test('leaving the app locks the vault', async () => {
    await openVault(A);
    sh('input keyevent KEYCODE_HOME');
    await sleep(1500);
    launch();
    await waitFor('Confirm');
    assert.ok(!has('Add file'));
  });
});

describe('attempt delay', () => {
  // Checked by behaviour and by the counter in a.bin. (On this emulator UI Automator kept
  // reporting stale text for the countdown while the app's state was correct; the countdown
  // itself is checked visually on iOS.)
  test('the fifth wrong PIN starts a wait that refuses even the right PIN', async () => {
    await toLockScreen();
    assert.equal(failures(), 0);
    for (let i = 1; i <= 5; i++) {
      await enterPin('00000000');
      const end = Date.now() + 15_000;
      while (failures() < i && Date.now() < end) await sleep(500);
      assert.equal(failures(), i, `attempt ${i} counted`);
      await sleep(1500);   // the keypad stays disabled until the attempt's 1.5 s minimum is up
    }
    await enterPin(A);
    await sleep(4000);
    assert.ok(!has('Add file'), 'right PIN refused during the wait');
    assert.equal(failures(), 5, 'a refused attempt is not counted');
  });

  test('the count survives a restart: 7 failures means a 5-minute wait after relaunch', async () => {
    stop();
    setFailures(7);
    await toLockScreen();
    await sleep(1500);
    await enterPin(A);
    await sleep(4000);
    assert.ok(!has('Add file'), 'right PIN refused after a restart');
    assert.equal(failures(), 7, 'a refused attempt is not counted');
  });

  test('below the limit the right PIN works and resets the count', async () => {
    stop();
    setFailures(4);
    await openVault(A);
    assert.equal(failures(), 0);
    await lockVault();
  });
});

describe('delete', () => {
  test('long-press deletes a file; its blob stays as same-size filler', async () => {
    await openVault(A);
    const before = blobs(0).concat(blobs(1));
    await longPress(await waitFor(DOC));
    await waitFor(`Delete “${DOC}”?`);
    const del = dump().filter((n) => /^delete$/i.test(n.text)).pop();
    await tap(del);
    await waitFor('No files yet. Add one with the button below.');
    // the list updates at once; the blob is shredded and the list rotated just after
    const end = Date.now() + 20_000;
    while (JSON.stringify(blobs(0).concat(blobs(1))) !== JSON.stringify(before) && Date.now() < end) await sleep(500);
    assert.deepEqual(blobs(0).concat(blobs(1)), before, 'no blob removed or added');
    await lockVault();
  });
});

describe('PIN C (wipe)', () => {
  test('opens the decoy vault and destroys vault A', async () => {
    await openVault(A);   // put a file back in A first
    await addFile('Document', DOC);
    await lockVault();
    await openVault(C);
    await waitFor(PHOTO);
    assert.ok(!has(DOC));
    await lockVault();
    await enterPin(A);
    await waitFor('Wrong PIN', { timeout: 15_000 });
  });

  test('vault B is untouched', async () => {
    await sleep(500);
    await openVault(B);
    await waitFor(PHOTO);
    await lockVault();
  });
});

describe('passphrase entry on the lock screen', () => {
  test('switches to the passphrase field and back', async () => {
    await toLockScreen();
    await tap('Use passphrase');
    await tap('Passphrase');
    typeText('wrong horse');
    await tap('Unlock');
    await waitFor('Wrong passphrase', { timeout: 15_000 });
    await tap('Use PIN');
    await waitFor('Confirm');
  });
});

describe('platform protections', () => {
  test('the window is FLAG_SECURE and screenshots come out blank', async () => {
    const dumpW = sh('dumpsys window windows');
    const block = dumpW.split(/\n(?=  Window #)/).find((b) => b.includes(`${PKG}/${PKG}.MainActivity`)) ?? '';
    const fl = (block.match(/fl=([^\n]*)/) ?? [])[1] ?? '';
    results.windowFlags = fl.trim();
    assert.match(fl, /\bSECURE\b/);
    const raw = execFileSync('adb', ['exec-out', 'screencap'], { maxBuffer: 64 << 20 });
    const w = raw.readUInt32LE(0), h = raw.readUInt32LE(4);
    const px = raw.subarray(raw.length - w * h * 4);
    // The status bar (system UI, not Cube's window) stays visible; Cube's own area must be black.
    let nonBlack = 0;
    for (let y = 150; y < h; y += 4) for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      if (px[i] | px[i + 1] | px[i + 2]) nonBlack++;
    }
    results.screencapNonBlackSamplesBelowStatusBar = nonBlack;
    assert.equal(nonBlack, 0, 'Cube\'s window is black in the screenshot');
  });

  test('no PINs, file names or contents in the system log', async () => {
    // adbd logs the test's own shell commands, and MediaProvider logs the fixture push.
    const log = sh('logcat -d').split('\n').filter((l) => !/ adbd |MediaProvider/.test(l)).join('\n');
    for (const s of [A, B, C, MARKER, 'wrong horse']) assert.ok(!log.includes(s), `log contains ${s}`);
    results.logMentionsFileName = log.includes(DOC);
  });

  test('backups are off and only the launcher activity is exported', async () => {
    const pkg = sh(`dumpsys package ${PKG}`);
    assert.ok(!/ALLOW_BACKUP/.test(pkg.match(/flags=\[[^\]]*\]/g)?.join(' ') ?? ''), 'no ALLOW_BACKUP flag');
    const perms = (pkg.match(/requested permissions:[\s\S]*?install permissions:/) ?? [''])[0];
    results.requestedPermissions = perms.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('android.permission') || l.startsWith(PKG));
    // Debug builds add INTERNET and SYSTEM_ALERT_WINDOW for Metro and the dev menu; the release
    // manifest is checked separately (scripts in the release pass).
    const debug = /DEBUGGABLE/.test(pkg);
    const banned = ['CAMERA', 'RECORD_AUDIO', 'READ_EXTERNAL_STORAGE', 'READ_MEDIA_VIDEO', ...(debug ? [] : ['INTERNET', 'SYSTEM_ALERT_WINDOW'])];
    for (const p of banned) assert.ok(!perms.includes(`android.permission.${p}`), `${p} requested`);
  });

  test('cold start time', async () => {
    stop();
    const out = sh(`am start -W -n ${PKG}/.MainActivity`);
    results.coldStartMs = Number((out.match(/TotalTime: (\d+)/) ?? [])[1]);
    await waitFor('Confirm');
  });
});
