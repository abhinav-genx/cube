import { Directory, File, Paths } from 'expo-file-system';
import { HEADER, type Disk } from './vault';

// Everything the app owns lives under <documents>/d. The directory name says nothing.
const root = new Directory(Paths.document, 'd');

function ensureRoot() {
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
}

export const disk: Disk = {
  async read(path) {
    const f = new File(root, path);
    if (!f.exists) return null;
    return new Uint8Array(await f.bytes());
  },
  async write(path, bytes) {
    ensureRoot();
    await new File(root, path).write(bytes);
  },
  async remove(path) {
    const f = new File(root, path);
    if (f.exists) {
      f.delete();
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
