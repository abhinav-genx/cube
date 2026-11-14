import { Directory, File, Paths } from 'expo-file-system';
import { randombytes_buf, to_hex } from 'react-native-libsodium';
import CubeNative from '../modules/cube-native';
import { HEADER, type Disk } from './vault';

// Everything the app owns lives under <documents>/d. The directory name says nothing.
const root = new Directory(Paths.document, 'd');

let excluded = false;
function ensureRoot() {
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  if (!excluded) {
    // iOS backs up the Documents folder by default; the vault never leaves the phone.
    // (Android: allowBackup=false plus data-extraction rules; this call is a no-op there.)
    try {
      CubeNative?.excludeFromBackup(root.uri);
      excluded = true;
    } catch {
      // retried on the next write
    }
  }
}

// Replacing a file must survive the app being killed mid-write (a half-written h.bin or i.bin
// would lose a vault). File.write truncates in place, so a write goes to "<name>.part", which is
// renamed to "<name>.new" once complete; then the old file is removed and "<name>.new" renamed
// into place. A rename onto a free name is atomic on Android and iOS, so at every moment either
// <name> or <name>.new holds a complete copy, and recover() finishes an interrupted swap.
const PART = '.part';
const NEXT = '.new';
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function recover(path: string): void {
  const next = new File(root, path + NEXT);
  if (next.exists && !new File(root, path).exists) next.rename(baseName(path));
}

export const disk: Disk = {
  async read(path) {
    recover(path);
    const f = new File(root, path);
    if (!f.exists) return null;
    return new Uint8Array(await f.bytes());
  },
  async write(path, bytes) {
    ensureRoot();
    recover(path);
    const part = new File(root, path + PART);
    const next = new File(root, path + NEXT);
    if (part.exists) part.delete();   // an interrupted write never got past this stage
    if (next.exists) next.delete();   // complete but never committed; <name> is still valid
    await part.write(bytes);
    part.rename(baseName(path) + NEXT);
    const current = new File(root, path);
    if (current.exists) current.delete();
    new File(root, path + NEXT).rename(baseName(path));
  },
  async remove(path) {
    const f = new File(root, path);
    if (f.exists || new File(root, path + NEXT).exists) {
      for (const p of [path, path + NEXT, path + PART]) {
        const g = new File(root, p);
        if (g.exists) g.delete();
      }
      return;
    }
    const d = new Directory(root, path);
    if (d.exists) d.delete();
  },
  async mkdir(path) {
    ensureRoot();
    new Directory(root, path).create({ intermediates: true, idempotent: true });
  },
  async list(path) {
    const d = new Directory(root, path);
    if (!d.exists) return [];
    return d
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => ({ name: f.name, size: f.size }));
  },
};

// Which entry the lock screen shows first: the keypad or the passphrase field. Not a secret
// (anyone watching sees which one you use) and the lock screen can always switch.
export type EntryMode = 'pin' | 'phrase';
const MODE = 'p.bin';

export function readEntryMode(): EntryMode {
  try {
    const f = new File(root, MODE);
    return f.exists && f.textSync() === 'phrase' ? 'phrase' : 'pin';
  } catch {
    return 'pin';
  }
}

export async function writeEntryMode(mode: EntryMode): Promise<void> {
  await disk.write(MODE, new TextEncoder().encode(mode));
}

/** True once setup() has written the slot header. */
export function vaultExists(): boolean {
  recover(HEADER);
  return new File(root, HEADER).exists;
}

/** The file:// URI of a stored file, for native code that reads it directly (image preview). */
export function storedUri(path: string): string {
  recover(path);
  return new File(root, path).uri;
}

/** Read a file the pickers handed us (a file:// copy in the app cache). */
export async function readUri(uri: string): Promise<Uint8Array> {
  return new Uint8Array(await new File(uri).bytes());
}

/** Remove the picker's plaintext cache copy. Best effort; see README "Vulnerabilities". */
export function deleteUri(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // nothing sensible to do here
  }
}

// Plaintext ever written to the cache lives in one of these: the pickers' copies of a file being
// added, and Cube's own export copies. sweepPlaintextCache() empties them at launch, in case the
// app was killed before it could delete a copy.
const EXPORTS = 'cube-export';
const PLAINTEXT_DIRS = ['DocumentPicker', 'ImagePicker', EXPORTS];

/** A file name that cannot leave its folder: no path separators, no control characters, no "..". */
export function safeName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base === '' || base === '.' || base === '..' ? 'file' : base;
}

/**
 * Write a temporary plaintext copy for sharing, under the file's real (sanitised) name in a
 * random folder of its own. Caller must call removeExports() afterwards.
 */
export async function writeTemp(name: string, bytes: Uint8Array): Promise<File> {
  const dir = new Directory(Paths.cache, EXPORTS, to_hex(randombytes_buf(8)));
  dir.create({ intermediates: true, idempotent: true });
  const f = new File(dir, safeName(name));
  await f.write(bytes);
  return f;
}

/** Delete every export copy. Best effort. */
export function removeExports(): void {
  removeCacheDir(EXPORTS);
}

/** Delete leftover plaintext copies (pickers' and exports'). Call at launch. Best effort. */
export function sweepPlaintextCache(): void {
  PLAINTEXT_DIRS.forEach(removeCacheDir);
}

function removeCacheDir(name: string): void {
  try {
    const d = new Directory(Paths.cache, name);
    if (d.exists) d.delete();
  } catch {
    // nothing sensible to do here
  }
}
