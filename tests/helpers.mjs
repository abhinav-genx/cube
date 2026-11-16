// Shared helpers for the unit tests.
export const enc = (s) => new TextEncoder().encode(s);
export const pin = (s) => enc(s);   // a fresh array each call: unlock() zeroes what it is given

/** In-memory Disk (lib/vault.ts interface). failWrite(path) → true makes that write throw. */
export class MemDisk {
  constructor() {
    this.files = new Map();
    this.writes = [];
    this.failWrite = null;
  }
  async read(p) {
    const v = this.files.get(p);
    return v ? v.slice() : null;
  }
  async write(p, b) {
    this.writes.push(p);
    if (this.failWrite?.(p)) throw new Error(`disk error writing ${p}`);
    this.files.set(p, b.slice());
  }
  async remove(p) {
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k);
  }
  async mkdir() {}
  async list(dir) {
    return [...this.files]
      .filter(([k]) => k.startsWith(dir + '/') && !k.slice(dir.length + 1).includes('/'))
      .map(([k, v]) => ({ name: k.slice(dir.length + 1), size: v.length }));
  }
  async create(p) {
    const parts = [];
    return {
      write: async (b) => void parts.push(b.slice()),
      commit: async () => this.write(p, Buffer.concat(parts.map((x) => Buffer.from(x)))),
      abort: async () => {},
    };
  }
  async open(p) {
    const v = this.files.get(p);
    if (!v) return null;
    let at = 0;
    return {
      read: async (n) => {
        const out = v.slice(at, at + n);
        at += out.length;
        return out;
      },
      close: () => {},
    };
  }
  snapshot() {
    return new Map([...this.files].map(([k, v]) => [k, v.slice()]));
  }
  restore(snap) {
    this.files = new Map([...snap].map(([k, v]) => [k, v.slice()]));
  }
}

let n = 0;
/** A fresh copy of lib/vault.ts (its attempt counter lives in module state, like a new app process). */
export const freshVault = () => import(new URL(`../lib/vault.ts?instance=${++n}`, import.meta.url).href);

export const time = async (fn) => {
  const t0 = performance.now();
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  return { ms: performance.now() - t0, error };
};
