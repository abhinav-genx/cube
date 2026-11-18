import type { ComponentType, Ref } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Cube's native module (modules/cube-native). Null where it is not linked (for example, tests).
 * The "keyed step" binds PIN guesses to this phone: HMAC with an Android Keystore key, or ECDH
 * with a Secure Enclave key on iOS. Either way the key never leaves the secure hardware.
 */
export type CubeNative = {
  /** True where the module is linked (Android and iOS). */
  hardwareKeysAvailable(): boolean;
  hasKey(alias: string): boolean;
  /** (Re)creates the key. Throws E_NO_LOCK_SCREEN or E_NO_SECURE_HARDWARE. */
  createKey(alias: string, requireAuth: boolean, requireHardware: boolean): void;
  deleteKey(alias: string): void;
  /** Shows the system prompt if the key needs it; authorises the next mac(). Rejects E_AUTH_*. */
  authenticate(alias: string, title: string): Promise<void>;
  /** Writes the keyed step of `data` into out (32 bytes): Android HMAC, iOS hashed ECDH. */
  mac(alias: string, data: Uint8Array, out: Uint8Array): void;
  /** iOS: exclude a file or folder from backups. Android: no-op. */
  excludeFromBackup(uri: string): void;
  /** True where openImage, openText and the export functions work (iOS; Android, every supported version). */
  nativePreviewAvailable(): boolean;
  /**
   * Decrypts a vault blob and decodes it as an image entirely in native memory, so the
   * decrypted file never enters JavaScript. format 1: v1 blob, vault key; 2: chunked, file key.
   * Returns a handle for CubeImageView.
   */
  openImage(uri: string, key: Uint8Array, format: 1 | 2): number;
  /** Decrypts a text file natively (up to maxBytes) for CubeImageView. Returns a handle. */
  openText(uri: string, key: Uint8Array, format: 1 | 2, maxBytes: number): number;
  /** Releases (and on Android wipes) an image or text opened with openImage/openText. */
  closeImage(handle: number): void;
  /** Copies the key into native memory for an export; returns an id for runExport. */
  prepareExport(uri: string, key: Uint8Array, format: 1 | 2): number;
  /** Decrypts the prepared file into destUri (a file:// URI) off the JS thread. */
  runExport(id: number, destUri: string): Promise<void>;
  /** Copies a new file's key into native memory for a photo import; returns an id for runImport. */
  prepareImport(key: Uint8Array): number;
  /**
   * Reads the picked photo at srcUri (file:// or, on Android, content://), removes its location and
   * camera details (the same bytes as lib/strip.ts), encrypts it as a v2 blob and writes it to
   * destUri, off the JS thread. The photo never enters JavaScript.
   */
  runImport(id: number, srcUri: string, destUri: string): Promise<{ size: number; blobBytes: number }>;
  /**
   * Android: registers a file for sharing without a readable copy (decrypted into a pipe as the
   * receiving app reads it); returns a token for runShare. Shares end after 2 minutes or endShares().
   */
  prepareShare?(uri: string, key: Uint8Array, format: 1 | 2, name: string, mime: string, size: number): string;
  /** Android: opens the share sheet for a prepared share; resolves when the user comes back. */
  runShare?(token: string, name: string, mime: string): Promise<void>;
  /** Android: ends every share and wipes their keys. */
  endShares?(): void;
  /** Android: the active keyboard, and whether it is a third-party app. iOS and unknown: null. */
  keyboardInfo(): { thirdParty: boolean; name: string } | null;
};

const CubeNative = requireOptionalNativeModule<CubeNative>('CubeNative');
export default CubeNative;

type CubeViewProps = ViewProps & { handle: number; textColor?: string; fontSize?: number };
let imageView: ComponentType<CubeViewProps> | null = null;
/** The native view that shows an image or text opened with openImage/openText. */
export function CubeImageView(): ComponentType<CubeViewProps> {
  imageView ??= requireNativeViewManager<CubeViewProps>('CubeNative');
  return imageView;
}

/** What a ref to CubeSecureField offers. */
export type SecureFieldRef = {
  /** The passphrase as UTF-8 byte values (NFC); the field empties itself. Never a JS string. */
  take(): Promise<number[]>;
  focus(): Promise<void>;
};

export type SecureFieldProps = ViewProps & {
  ref?: Ref<SecureFieldRef>;
  placeholder?: string;
  placeholderColor?: string;
  textColor?: string;
  fontSize?: number;
  editable?: boolean;
  autoFocus?: boolean;
  onLengthChange?: (e: NativeSyntheticEvent<{ length: number }>) => void;
  onSubmit?: () => void;
  onFocusChange?: (e: NativeSyntheticEvent<{ focused: boolean }>) => void;
};

let secureField: ComponentType<SecureFieldProps> | null = null;
/** The native passphrase field (CubeSecureFieldModule), or null where it is not linked. */
export function CubeSecureField(): ComponentType<SecureFieldProps> | null {
  if (!requireOptionalNativeModule('CubeSecureField')) return null;
  secureField ??= requireNativeViewManager<SecureFieldProps>('CubeSecureField');
  return secureField;
}
