// Fake modules/cube-native: HMAC-SHA256 keys in memory, with per-use authorisation like the
// Android Keystore key (one mac() per authenticate() when the key requires auth).
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripImageMetadata } from '../../lib/strip.ts';
import { RtfCleaner, stripDocumentMetadata, stripSvg } from '../../lib/docmeta.ts';
import { stripMediaMetadata } from '../../lib/mediameta.ts';
import { encryptChunked } from '../../lib/vault.ts';

export const state = {
  hw: true,
  keys: new Map(),
  authCalls: 0,
  macCalls: 0,
  authError: null,     // e.g. 'E_AUTH_CANCELLED'
  createError: null,   // e.g. 'E_NO_LOCK_SCREEN'
  excluded: [],
  imports: new Map(),
  nextImport: 1,
  importError: null,
};
export function resetNative() {
  Object.assign(state, { hw: true, authCalls: 0, macCalls: 0, authError: null, createError: null, excluded: [], importError: null });
  state.imports.clear();
  state.keys.clear();
}
const err = (code) => Object.assign(new Error(code), { code });

const CubeNative = {
  hardwareKeysAvailable: () => state.hw,
  hasKey: (alias) => state.keys.has(alias),
  createKey(alias, requireAuth, requireHardware) {
    if (state.createError) throw err(state.createError);
    state.keys.set(alias, { secret: randomBytes(32), requireAuth, requireHardware, grants: 0 });
  },
  deleteKey: (alias) => void state.keys.delete(alias),
  async authenticate(alias) {
    state.authCalls++;
    if (state.authError) throw err(state.authError);
    const k = state.keys.get(alias);
    if (!k) throw err('E_NO_KEY');
    k.grants = 1;   // a new prompt replaces any unused grant
  },
  mac(alias, data, out) {
    const k = state.keys.get(alias);
    if (!k) throw err('E_NO_KEY');
    if (k.requireAuth) {
      if (k.grants < 1) throw err('E_AUTH_REQUIRED');
      k.grants--;
    }
    state.macCalls++;
    out.set(createHmac('sha256', k.secret).update(data).digest());
  },
  excludeFromBackup: (uri) => void state.excluded.push(uri),
  nativePreviewAvailable: () => false,
  // Import: the same steps as CubeNativeModule (clean by kind, then encrypt as v2), done in JS here.
  prepareImport(key) {
    const id = state.nextImport++;
    state.imports.set(id, key.slice());
    return id;
  },
  async runImport(id, srcUri, destUri, kind = 'image') {
    const key = state.imports.get(id);
    state.imports.delete(id);
    if (state.importError) throw err(state.importError);
    state.lastKind = kind;
    const raw = new Uint8Array(fs.readFileSync(fileURLToPath(srcUri)));
    const rtf = (b) => {
      const c = new RtfCleaner();
      const head = c.push(b);
      const tail = c.finish();
      return Buffer.concat([head, tail]);
    };
    const clean = kind === 'image' ? stripImageMetadata(raw) : kind === 'raw' ? raw : kind === 'rtf' ? new Uint8Array(rtf(raw))
      : kind === 'svg' ? stripSvg(raw) : kind === 'media' ? stripMediaMetadata(raw) : stripDocumentMetadata(raw);
    const blob = encryptChunked(key, clean);
    fs.writeFileSync(fileURLToPath(destUri), blob);
    return { size: clean.length, blobBytes: blob.length };
  },
  openImage: () => { throw err('E_UNSUPPORTED'); },
  closeImage: () => {},
};
export default CubeNative;
export const CubeImageView = () => null;
