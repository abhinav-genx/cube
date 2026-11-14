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

  test('coming back after more than 2 minutes in a picker finds the vault locked', async () => {
    startSession({ vault: 0, fileKey: key() });
    let done;
    const p = withAutoLockSuspended(() => new Promise((r) => (done = r)));
    mock.timers.tick(90_000);   // (step the clock: tick() jumps Date to its end before firing timers)
    mock.timers.tick(31_000);
    assert.ok(getSession(), 'timers did not run in the background');
    assert.equal(lockIfAwayTooLong(), true);
    assert.equal(getSession(), null);
    done();
    await p;
    await flush();
    assert.equal(getSession(), null);
  });

  test('a picker that throws still ends the suspension', async () => {
    startSession({ vault: 0, fileKey: key() });
    await assert.rejects(withAutoLockSuspended(async () => { throw new Error('cancelled'); }), /cancelled/);
    assert.equal(isAutoLockSuspended(), false);
    assert.ok(getSession());
  });
});
