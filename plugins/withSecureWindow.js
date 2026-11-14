// Every Cube screen is sensitive, the PIN keypad included, so Android's window gets FLAG_SECURE
// from the first frame (no screenshots, screen recording or recent-apps thumbnail) and drops
// touches that arrive through another app's overlay (tapjacking). JS also sets the flag in
// app/_layout.tsx, which is what covers iOS.
const { withMainActivity } = require('expo/config-plugins');

const MARKER = '// cube: secure window';
const CODE = `
    ${MARKER}
    window.setFlags(
      android.view.WindowManager.LayoutParams.FLAG_SECURE,
      android.view.WindowManager.LayoutParams.FLAG_SECURE,
    )
    window.decorView.filterTouchesWhenObscured = true`;

module.exports = function withSecureWindow(config) {
  return withMainActivity(config, (cfg) => {
    const src = cfg.modResults.contents;
    if (cfg.modResults.language !== 'kt') throw new Error('withSecureWindow expects a Kotlin MainActivity');
    if (!src.includes(MARKER)) {
      const anchor = 'super.onCreate(null)';
      if (!src.includes(anchor)) throw new Error('withSecureWindow: super.onCreate(null) not found in MainActivity');
      cfg.modResults.contents = src.replace(anchor, anchor + CODE);
    }
    return cfg;
  });
};
