#!/usr/bin/env node
// Refuses to build a store or preview release with software keys. EXPO_PUBLIC_SOFTWARE_KEYS=1
// removes the hardware binding and the biometric/passcode gate (lib/vault.ts), so a build made
// with it is only for emulators and cloud test phones.
//
// Runs on EAS automatically (package.json "eas-build-pre-install"). For local release builds:
//   CUBE_RELEASE=1 node scripts/check-release.js && npx expo run:android --variant release
const softwareKeys = process.env.EXPO_PUBLIC_SOFTWARE_KEYS === '1';
const profile = process.env.EAS_BUILD_PROFILE;            // set by EAS Build
const testProfiles = new Set(['emulator', 'development']);
const isRelease = profile ? !testProfiles.has(profile) : process.env.CUBE_RELEASE === '1';

if (softwareKeys && isRelease) {
  console.error(
    `check-release: EXPO_PUBLIC_SOFTWARE_KEYS=1 is set for ${profile ? `EAS profile "${profile}"` : 'a release build'}.\n` +
      'That build would keep its keys in software with no biometric or passcode gate. ' +
      'Unset it, or build with the "emulator" profile for test devices.',
  );
  process.exit(1);
}
console.log(`check-release: ok (${profile ?? (isRelease ? 'local release' : 'local')}, software keys ${softwareKeys ? 'on' : 'off'})`);
