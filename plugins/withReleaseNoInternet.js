// Cube makes no network connections (SRS IF-22), so release builds drop the INTERNET permission
// that React Native's template declares. Debug builds keep it: they load JavaScript from Metro.
// Writes android/app/src/release/AndroidManifest.xml, which only the release build type merges.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.INTERNET" tools:node="remove"/>
</manifest>
`;

module.exports = function withReleaseNoInternet(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'release');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'AndroidManifest.xml'), MANIFEST);
      return cfg;
    },
  ]);
};
