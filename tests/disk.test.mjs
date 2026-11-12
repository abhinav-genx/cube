import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { Paths, control as fsControl, resetCrash } from './mocks/expo-file-system.mjs';
import { state as native } from './mocks/cube-native.mjs';
import { enc } from './helpers.mjs';
import {
  disk, readEntryMode, removeExports, safeName, storedUri, sweepPlaintextCache, vaultExists, writeEntryMode, writeTemp,
} from '../lib/disk.ts';

const root = path.join(Paths.document.path, 'd');
const cache = Paths.cache.path;
beforeEach(() => {
  resetCrash();
  fs.rmSync(root, { recursive: true, force: true });
});
const text = async (p) => new TextDecoder().decode(await disk.read(p));

describe('safeName', () => {
  test('cannot escape its folder', () => {
    const cases = {
      'photo.jpg': 'photo.jpg',
      '../../etc/passwd': 'passwd',
      'a/b/c.txt': 'c.txt',
      'C:\\Users\\x\\evil.exe': 'evil.exe',
      '..': 'file',
      '.': 'file',
      '': 'file',
      '   ': 'file',
      'tab\there\n.txt': 'tabhere.txt',
      'dir/': 'file',
      'résumé 😀.pdf': 'résumé 😀.pdf',
    };
    for (const [input, out] of Object.entries(cases)) assert.equal(safeName(input), out, JSON.stringify(input));
  });
});

describe('disk', () => {
  test('write, overwrite, read, list, remove', async () => {
    assert.equal(await disk.read('x.bin'), null);
    await disk.write('x.bin', enc('one'));
    await disk.write('x.bin', enc('two!'));
    assert.equal(await text('x.bin'), 'two!');
    await disk.mkdir('0');
    await disk.write('0/a.bin', new Uint8Array(5));
    assert.deepEqual(await disk.list('0'), [{ name: 'a.bin', size: 5 }]);
    assert.deepEqual(await disk.list('missing'), []);
    await disk.remove('x.bin');
    assert.equal(await disk.read('x.bin'), null);
    await disk.remove('0');
    assert.ok(!fs.existsSync(path.join(root, '0')));
    await disk.remove('never-existed');
  });

  test('marks the vault folder for exclusion from backups', async () => {
    await disk.write('y.bin', enc('y'));
    assert.ok(native.excluded.some((u) => u.endsWith('/Documents/d')), native.excluded.join());
  });

  test('a kill at any step of an overwrite leaves the old or the new contents, never neither', async () => {
    await disk.write('h.bin', enc('old contents'));
    fsControl.ops = 0;
    await disk.write('h.bin', enc('new contents'));
    const steps = fsControl.ops;
    assert.equal(steps, 4);
    for (let k = 0; k < steps; k++) {
      fs.rmSync(root, { recursive: true, force: true });
      await disk.write('h.bin', enc('old contents'));
      resetCrash();
      fsControl.failAfter = k;
      await assert.rejects(disk.write('h.bin', enc('new contents')));
      resetCrash();
      assert.ok(vaultExists(), `step ${k}: header still found`);
      assert.ok(['old contents', 'new contents'].includes(await text('h.bin')), `step ${k}`);
      await disk.write('h.bin', enc('after'));   // and the next write still works
      assert.equal(await text('h.bin'), 'after');
    }
  });

  test('the very first write killed midway leaves no file (not a torn one)', async () => {
    fsControl.failAfter = 0;
    await assert.rejects(disk.write('h.bin', enc('first')));
    resetCrash();
    assert.equal(await disk.read('h.bin'), null);
    assert.equal(vaultExists(), false);
  });

  test('storedUri finishes an interrupted swap first', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'z.bin.new'), 'z');
    assert.match(storedUri('z.bin'), /\/d\/z\.bin$/);
    assert.ok(fs.existsSync(path.join(root, 'z.bin')));
  });
});

describe('entry mode', () => {
  test('defaults to the keypad, remembers passphrase mode', async () => {
    assert.equal(readEntryMode(), 'pin');
    await writeEntryMode('phrase');
    assert.equal(readEntryMode(), 'phrase');
    await writeEntryMode('pin');
    assert.equal(readEntryMode(), 'pin');
    fs.writeFileSync(path.join(root, 'p.bin'), 'garbage');
    assert.equal(readEntryMode(), 'pin');
  });
});

describe('plaintext cache', () => {
  test('exports go to their own random folder under a safe name, and are removed', async () => {
    const f = await writeTemp('../../secret.txt', enc('plain'));
    assert.match(f.uri, /\/Caches\/cube-export\/[0-9a-f]{16}\/secret\.txt$/);
    const g = await writeTemp('secret.txt', enc('plain'));
    assert.notEqual(path.dirname(f.path), path.dirname(g.path));
    removeExports();
    assert.ok(!fs.existsSync(path.join(cache, 'cube-export')));
  });

  test('the launch sweep removes picker and export copies, nothing else', () => {
    for (const d of ['DocumentPicker', 'ImagePicker', 'cube-export', 'other']) {
      fs.mkdirSync(path.join(cache, d), { recursive: true });
      fs.writeFileSync(path.join(cache, d, 'f'), 'x');
    }
    sweepPlaintextCache();
    assert.deepEqual(fs.readdirSync(cache).sort(), ['other']);
  });
});
