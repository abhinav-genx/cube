// Release builds are signed with the project's own release key when one is given, never with
// Android's public debug key (anyone could sign an "update" with that). The key stays outside the
// repository; the build reads where it is and its passwords from environment variables:
//   CUBE_RELEASE_STORE_FILE, CUBE_RELEASE_STORE_PASSWORD, CUBE_RELEASE_KEY_ALIAS, CUBE_RELEASE_KEY_PASSWORD
// Without them a release build stops instead of quietly falling back to the debug key.
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_CONFIG = `
        release {
            if (System.getenv('CUBE_RELEASE_STORE_FILE')) {
                storeFile file(System.getenv('CUBE_RELEASE_STORE_FILE'))
                storePassword System.getenv('CUBE_RELEASE_STORE_PASSWORD')
                keyAlias System.getenv('CUBE_RELEASE_KEY_ALIAS')
                keyPassword System.getenv('CUBE_RELEASE_KEY_PASSWORD')
            }
        }`;

const GUARD = `
// Cube: never ship a release signed with the debug key (plugins/withReleaseSigning.js)
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.name.toLowerCase().contains('release') && (it.name.startsWith('package') || it.name.startsWith('assemble') || it.name.startsWith('bundle')) } && !System.getenv('CUBE_RELEASE_STORE_FILE')) {
        throw new GradleException('Release builds need CUBE_RELEASE_STORE_FILE and the other CUBE_RELEASE_* variables (see plugins/withReleaseSigning.js).')
    }
}
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let s = cfg.modResults.contents;
    if (!s.includes("System.getenv('CUBE_RELEASE_STORE_FILE')")) {
      s = s.replace(/(signingConfigs \{\n\s+debug \{[^}]*\})/, `$1${RELEASE_CONFIG}`);
      s = s.replace(/(release \{\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/, '$1signingConfig signingConfigs.release');
      s += GUARD;
    }
    cfg.modResults.contents = s;
    return cfg;
  });
};
