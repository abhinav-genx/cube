import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';
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
  /** True where openImage works (iOS; Android 9+). */
  nativePreviewAvailable(): boolean;
  /**
   * Decrypts a vault blob and decodes it as an image entirely in native memory, so the
   * decrypted file never enters JavaScript. Returns a handle for CubeImageView.
   */
  openImage(uri: string, fileKey: Uint8Array): number;
  /** Releases (and on Android wipes) an image opened with openImage. */
  closeImage(handle: number): void;
};

const CubeNative = requireOptionalNativeModule<CubeNative>('CubeNative');
export default CubeNative;

let imageView: ComponentType<ViewProps & { handle: number }> | null = null;
/** The native view that shows an image opened with openImage. */
export function CubeImageView(): ComponentType<ViewProps & { handle: number }> {
  imageView ??= requireNativeViewManager<ViewProps & { handle: number }>('CubeNative');
  return imageView;
}
