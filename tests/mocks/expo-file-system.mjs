// expo-file-system's File/Directory/Paths over a temp folder, with crash injection:
// set control.failAfter = n and the (n+1)th mutating call throws. A write that "crashes" leaves
// half its bytes behind, like a process killed mid-write.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cube-fs-'));
export const control = { failAfter: Infinity, ops: 0, log: [], onStep: null };
export function resetCrash() {
  control.failAfter = Infinity;
  control.ops = 0;
  control.log = [];
  control.onStep = null;
}
export const baseDir = base;

function step(op, p) {
  control.ops++;
  control.log.push(`${op} ${path.relative(base, p)}`);
  control.onStep?.(control.ops, op, p);
  if (control.ops > control.failAfter) {
    const e = new Error(`injected crash at ${op} ${path.relative(base, p)}`);
    e.injected = true;
    throw e;
  }
}

function toPath(parts) {
  return path.join(
    ...parts.map((p) => (p instanceof Entry ? p.path : typeof p === 'string' && p.startsWith('file://') ? fileURLToPath(p) : p)),
  );
}

class Entry {
  constructor(...parts) {
    this.path = toPath(parts);
  }
  get uri() {
    return pathToFileURL(this.path).href;
  }
  get name() {
    return path.basename(this.path);
  }
}

export class File extends Entry {
  get exists() {
    return fs.existsSync(this.path) && fs.statSync(this.path).isFile();
  }
  get size() {
    return fs.statSync(this.path).size;
  }
  async bytes() {
    return new Uint8Array(fs.readFileSync(this.path));
  }
  textSync() {
    return fs.readFileSync(this.path, 'utf8');
  }
  async write(bytes) {
    try {
      step('write', this.path);
    } catch (e) {
      fs.writeFileSync(this.path, Buffer.from(bytes).subarray(0, bytes.length >> 1));   // torn write
      throw e;
    }
    fs.writeFileSync(this.path, typeof bytes === 'string' ? bytes : Buffer.from(bytes));
  }
  rename(name) {
    step('rename', this.path);
    const to = path.join(path.dirname(this.path), name);
    if (fs.existsSync(to)) throw new Error(`rename target exists: ${name}`);
    fs.renameSync(this.path, to);
    this.path = to;
  }
  delete() {
    step('delete', this.path);
    fs.rmSync(this.path);
  }
}

export class Directory extends Entry {
  get exists() {
    return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
  }
  create(opts = {}) {
    if (this.exists && opts.idempotent) return;
    fs.mkdirSync(this.path, { recursive: !!opts.intermediates });
  }
  delete() {
    step('rmdir', this.path);
    fs.rmSync(this.path, { recursive: true, force: true });
  }
  list() {
    return fs
      .readdirSync(this.path, { withFileTypes: true })
      .map((d) => (d.isDirectory() ? new Directory(this.path, d.name) : new File(this.path, d.name)));
  }
}

export const Paths = {
  document: new Directory(base, 'Documents'),
  cache: new Directory(base, 'Caches'),
};
Paths.document.create({ intermediates: true, idempotent: true });
Paths.cache.create({ intermediates: true, idempotent: true });
