import { Directory, File, Paths } from 'expo-file-system';
import { HEADER, type Disk } from './vault';

// Everything the app owns lives under <documents>/d. The directory name says nothing.
const root = new Directory(Paths.document, 'd');

function ensureRoot() {
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
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
};

/** True once setup() has written the slot header. */
export function vaultExists(): boolean {
  recover(HEADER);
  return new File(root, HEADER).exists;
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

/** Write a temporary plaintext copy for sharing. Caller must delete it afterwards. */
export async function writeTemp(name: string, bytes: Uint8Array): Promise<File> {
  const f = new File(Paths.cache, name);
  await f.write(bytes);
  return f;
}
