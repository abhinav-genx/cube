// Minimal Android UI driver for Cube's end-to-end tests: adb + uiautomator, no extra deps.
// Cube's window is FLAG_SECURE (screenshots are black) and accessibility services that are not
// shell-privileged see nothing, so this reads the UI through `uiautomator dump` (shell user).
import { execFileSync } from 'node:child_process';

export const PKG = 'app.cube.vault';
const SERIAL = process.env.ANDROID_SERIAL ?? 'emulator-5554';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function adb(...args) {
  return adbWithin(120_000, ...args);
}
/** adb with a time limit: a command that hangs (uiautomator sometimes does) throws instead of stalling the run. */
export function adbWithin(timeout, ...args) {
  return execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, timeout, killSignal: 'SIGKILL' });
}
export const sh = (cmd) => adb('shell', cmd);
export const runAs = (cmd) => sh(`run-as ${PKG} sh -c '${cmd}'`);

const attr = (s, name) => {
  const m = s.match(new RegExp(` ${name}="([^"]*)"`));
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n') : '';
};

/** Every node on screen: { text, desc, id, pkg, clickable, cx, cy, bounds }. */
export function dump() {
  let xml = '';
  for (let i = 0; i < 3 && !xml.includes('<hierarchy'); i++) {
    try {
      xml = adbWithin(40_000, 'shell', 'uiautomator dump /sdcard/cube-ui.xml >/dev/null 2>&1; cat /sdcard/cube-ui.xml');
    } catch {
      xml = '';
      try {
        adbWithin(10_000, 'shell', 'pkill -f uiautomator');   // a dump that hung: clear it before the next try
      } catch {
        // nothing to stop
      }
    }
  }
  return [...xml.matchAll(/<node [^>]*>/g)].map(([n]) => {
    const [x1, y1, x2, y2] = attr(n, 'bounds').match(/\d+/g).map(Number);
    return {
      text: attr(n, 'text'), desc: attr(n, 'content-desc'), id: attr(n, 'resource-id'), pkg: attr(n, 'package'),
      cls: attr(n, 'class'), clickable: attr(n, 'clickable') === 'true', enabled: attr(n, 'enabled') === 'true',
      cx: (x1 + x2) >> 1, cy: (y1 + y2) >> 1, bounds: [x1, y1, x2, y2],
    };
  });
}

const matches = (n, q) => (q instanceof RegExp ? q.test(n.text) || q.test(n.desc) : n.text === q || n.desc === q);
export const screenText = (nodes = dump()) => nodes.map((n) => n.text || n.desc).filter(Boolean);
export const has = (q, nodes = dump()) => nodes.some((n) => matches(n, q));

export async function waitFor(q, { timeout = 15_000, gone = false } = {}) {
  const end = Date.now() + timeout;
  let nodes = [];
  while (Date.now() < end) {
    nodes = dump();
    const found = nodes.find((n) => matches(n, q));
    if (gone ? !found : found) return found ?? true;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${gone ? 'absence of ' : ''}${q}; screen: ${JSON.stringify(screenText(nodes).slice(0, 40))}`);
}

export async function tap(q, opts) {
  if (!(typeof q === 'object' && 'cx' in q) && dismissDevBanner()) await sleep(800);
  const n = typeof q === 'object' && 'cx' in q ? q : await waitFor(q, opts);
  sh(`input tap ${n.cx} ${n.cy}`);
  return n;
}
export const longPress = (n, ms = 900) => sh(`input swipe ${n.cx} ${n.cy} ${n.cx} ${n.cy} ${ms}`);

/** Types a PIN on Cube's shuffled keypad (debug builds label each key) and taps Confirm. */
export async function enterPin(digits, { confirm = true } = {}) {
  await waitFor('Confirm');
  const nodes = dump();
  const key = (label) => nodes.find((n) => n.desc === label && n.clickable);
  const taps = [...digits].map((d) => key(d)).concat(confirm ? [key('Confirm')] : []);
  if (taps.some((t) => !t)) throw new Error('keypad not labelled (release build?)');
  sh(taps.map((t) => `input tap ${t.cx} ${t.cy}`).join('; '));
}

/** Types into the focused field. */
export function typeText(text) {
  sh(`input text '${text.replace(/ /g, '%s').replace(/'/g, "'\\''")}'`);
}

/** Starts Cube and waits until its window has focus (retries: a start right after a
 *  force-stop is occasionally dropped by the emulator). */
export function launch() {
  for (let i = 0; i < 4; i++) {
    sh(`am start -W -n ${PKG}/.MainActivity >/dev/null 2>&1; true`);
    for (let j = 0; j < 10; j++) {
      if (focused().includes(PKG)) return;
      execFileSync('sleep', ['1']);
    }
  }
  throw new Error(`Cube did not come to the front: ${focused()}`);
}

/** Debug builds show a dev-warning banner at the bottom that can cover buttons; close it. */
export function dismissDevBanner(nodes = dump()) {
  const banner = nodes.find((n) => n.desc.startsWith('!, ') || n.text === 'Open debugger to view warnings.');
  if (!banner) return false;
  const row = nodes.find((n) => n.desc.startsWith('!, ')) ?? banner;
  sh(`input tap ${row.bounds[2] - 60} ${row.cy}`);   // the × at its right end
  return true;
}
export function stop() {
  sh(`am force-stop ${PKG}`);
}
export const focused = () => sh('dumpsys window | grep mCurrentFocus').trim();
