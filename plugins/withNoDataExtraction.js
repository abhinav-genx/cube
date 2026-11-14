// allowBackup="false" stops cloud backup, but on Android 12+ it no longer stops device-to-device
// transfer (setting up a new phone from the old one). These rules exclude every storage domain
// from both, so the vault's files never leave the phone. (The master secret never could: Keystore
// keys do not migrate. This keeps even the ciphertext at home.)
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external',
  'device_root', 'device_file', 'device_database', 'device_sharedpref'];
const excludes = DOMAINS.map((d) => `    <exclude domain="${d}" path="." />`).join('\n');
const RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
${excludes}
  </cloud-backup>
  <device-transfer>
${excludes}
  </device-transfer>
</data-extraction-rules>
`;

module.exports = function withNoDataExtraction(config) {
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app) throw new Error('withNoDataExtraction: no <application> in AndroidManifest');
    app.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    return cfg;
  });
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'data_extraction_rules.xml'), RULES);
      return cfg;
    },
  ]);
};
