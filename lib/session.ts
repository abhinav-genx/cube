import { useSyncExternalStore } from 'react';
import type { Opened } from './vault';

/**
 * The only place the open vault's key lives. Nothing here touches disk.
 * lock() zeros the key; auto-lock fires after IDLE_MS without a touch, and the root layout
 * also locks when the app goes to the background — unless a picker/share sheet is open.
 */
const IDLE_MS = 90_000;
/** How long a picker or share sheet may keep the vault open while the app is in the background. */
const MAX_SUSPEND_MS = 120_000;

let session: Opened | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
// One token per open picker/share sheet. lock() forgets them all, so a picker whose promise never
// settles (Android killed its activity) cannot keep auto-lock switched off for later sessions.
let suspensions = new Set<object>();
let suspendedSince = 0;   // when the outermost picker/share sheet opened

const suspended = () => suspensions.size > 0;
function suspendedTooLong(): boolean {
  return suspended() && Date.now() - suspendedSince > MAX_SUSPEND_MS;
}
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getSession(): Opened | null {
  return session;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSession(): Opened | null {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

export function startSession(opened: Opened): void {
  lock();
  session = opened;
  touch();
  emit();
}

export function lock(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  suspensions = new Set();
  if (session) {
    session.fileKey.fill(0);
    session = null;
    emit();
  }
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(check, ms);
}

function check(): void {
  timer = null;
  if (!session) return;
  if (!suspended() || suspendedTooLong()) {
    lock();
    return;
  }
  // A picker is up: look again when the idle time or the picker's allowance runs out, whichever
  // comes first (not a whole idle period later).
  const left = MAX_SUSPEND_MS - (Date.now() - suspendedSince) + 1;
  schedule(Math.max(1, Math.min(IDLE_MS, left)));
}

/** Call on any user interaction while a vault is open; restarts the idle timer. */
export function touch(): void {
  if (!session) return;
  schedule(IDLE_MS);
}

/**
 * Pickers and share sheets put the app in the background; don't lock during them — for up to
 * MAX_SUSPEND_MS. Someone who leaves the app with a picker open and comes back later finds the
 * vault locked (and whatever they picked is not added).
 */
export async function withAutoLockSuspended<T>(fn: () => Promise<T>): Promise<T> {
  const token = {};
  if (!suspended()) suspendedSince = Date.now();
  suspensions.add(token);
  try {
    return await fn();
  } finally {
    if (suspensions.has(token)) {   // not already ended by a lock
      const tooLong = suspendedTooLong();
      suspensions.delete(token);
      if (tooLong) lock();
      else touch();
    }
  }
}

/**
 * For the return to the foreground: locks if a picker kept the vault open longer than allowed
 * (timers may not run while the app is in the background). True when it locked.
 */
export function lockIfAwayTooLong(): boolean {
  if (!session || !suspendedTooLong()) return false;
  lock();
  return true;
}

/** True while a picker or share sheet is up and still within its allowance. */
export function isAutoLockSuspended(): boolean {
  return suspended() && !suspendedTooLong();
}
