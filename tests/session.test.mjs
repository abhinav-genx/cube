import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import {
  getSession, isAutoLockSuspended, lock, lockIfAwayTooLong, startSession, subscribe, touch, withAutoLockSuspended,
} from '../lib/session.ts';

const key = () => new Uint8Array(32).fill(9);
const flush = () => new Promise((r) => setImmediate(r));
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
afterEach(() => {
  lock();
  mock.timers.reset();
});

describe('session', () => {
  test('lock() zeroes the key and notifies listeners', () => {
    const k = key();
    let calls = 0;
    const off = subscribe(() => calls++);
    startSession({ vault: 1, fileKey: k });
    assert.equal(getSession().vault, 1);
    lock();
    assert.equal(getSession(), null);
    assert.ok(k.every((b) => b === 0));
    assert.equal(calls, 2);
    off();
  });

  test('starting a session zeroes the previous key', () => {
    const k1 = key();
    startSession({ vault: 0, fileKey: k1 });
    startSession({ vault: 1, fileKey: key() });
    assert.ok(k1.every((b) => b === 0));
  });

  test('locks after 90 s idle; touch() restarts the clock', () => {
    startSession({ vault: 0, fileKey: key() });
    mock.timers.tick(80_000);
    touch();
    mock.timers.tick(80_000);
    assert.ok(getSession(), 'still open 80 s after the last touch');
    mock.timers.tick(10_001);
    assert.equal(getSession(), null);
  });

  test('a picker may keep the vault open past the idle limit, up to 2 minutes', async () => {
    startSession({ vault: 0, fileKey: key() });
    let done;
    const p = withAutoLockSuspended(() => new Promise((r) => (done = r)));
    assert.ok(isAutoLockSuspended());
    mock.timers.tick(100_000);
    assert.ok(getSession(), 'idle timer does not fire while the picker is up');
    assert.equal(lockIfAwayTooLong(), false);
    done('picked');
    assert.equal(await p, 'picked');
    assert.ok(getSession());
    assert.equal(isAutoLockSuspended(), false);
  });

  test('a picker open longer than 2 minutes locks the vault at 2 minutes, not an idle period later', async () => {
    startSession({ vault: 0, fileKey: key() });
    let done;
    const p = withAutoLockSuspended(() => new Promise((r) => (done = r)));
    mock.timers.tick(90_000);   // (step the clock: tick() jumps Date to its end before firing timers)
    assert.ok(getSession(), 'still open while the picker is within its allowance');
    mock.timers.tick(30_002);
    assert.equal(getSession(), null);
    done();
    await p;
    await flush();
    assert.equal(getSession(), null);
  });

  test('coming back after the timers were frozen in the background still finds it locked', async () => {
    startSession({ vault: 0, fileKey: key() });
    const p = withAutoLockSuspended(() => new Promise(() => {}));   // never settles
    mock.timers.setTime(Date.now() + 121_000);   // the clock moved; no timer ran
    assert.equal(lockIfAwayTooLong(), true);
    assert.equal(getSession(), null);
    void p;
  });

  test('a picker that never settles does not keep auto-lock off for the next session', async () => {
    startSession({ vault: 0, fileKey: key() });
    void withAutoLockSuspended(() => new Promise(() => {}));   // Android killed the picker's activity
    assert.equal(isAutoLockSuspended(), true);
    lock();
    startSession({ vault: 0, fileKey: key() });
    assert.equal(isAutoLockSuspended(), false, 'background lock works again');
    mock.timers.tick(90_001);
    assert.equal(getSession(), null, 'idle lock works again');
  });

  test('an expired suspension no longer counts as suspended', () => {
    startSession({ vault: 0, fileKey: key() });
    void withAutoLockSuspended(() => new Promise(() => {}));
    mock.timers.setTime(Date.now() + 121_000);
    assert.equal(isAutoLockSuspended(), false);
  });

  test('a picker that throws still ends the suspension', async () => {
    startSession({ vault: 0, fileKey: key() });
    await assert.rejects(withAutoLockSuspended(async () => { throw new Error('cancelled'); }), /cancelled/);
    assert.equal(isAutoLockSuspended(), false);
    assert.ok(getSession());
  });
});
