// In-memory react-native-keychain. `store` maps service -> { username, password, opts }.
export const store = new Map();
export const control = { failSet: false };
export const ACCESSIBLE = { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly' };
export const SECURITY_LEVEL = { ANY: 'ANY', SECURE_SOFTWARE: 'SECURE_SOFTWARE', SECURE_HARDWARE: 'SECURE_HARDWARE' };
export const STORAGE_TYPE = { AES_GCM_NO_AUTH: 'AES_GCM_NO_AUTH', AES_GCM: 'AES_GCM', RSA: 'RSA' };
export const ACCESS_CONTROL = { BIOMETRY_ANY_OR_DEVICE_PASSCODE: 'BiometryAnyOrDevicePasscode' };
export async function getGenericPassword(opts = {}) {
  const v = store.get(opts.service);
  return v ? { username: v.username, password: v.password, service: opts.service, storage: v.opts.storage } : false;
}
export async function setGenericPassword(username, password, opts = {}) {
  if (control.failSet) return false;
  store.set(opts.service, { username, password, opts });
  return { service: opts.service, storage: opts.storage };
}
export async function resetGenericPassword(opts = {}) {
  store.delete(opts.service);
  return true;
}
