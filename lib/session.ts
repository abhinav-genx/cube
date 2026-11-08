import { useSyncExternalStore } from 'react';
import type { Opened } from './vault';

/**
 * The only place the open vault's key lives. Nothing here touches disk.
 * lock() zeros the key; auto-lock fires after IDLE_MS without a touch, and the root layout
 * also locks when the app goes to the background — unless a picker/share sheet is open.
 */
const IDLE_MS = 90_000;

let session: Opened | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let suspended = 0;
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
  if (session) {
    session.fileKey.fill(0);
    session = null;
    emit();
  }
}

/** Call on any user interaction while a vault is open; restarts the idle timer. */
export function touch(): void {
  if (!session) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (suspended > 0) touch();   // a picker is up — try again later
    else lock();
  }, IDLE_MS);
}

/** Pickers and share sheets put the app in the background; don't lock during them. */
export async function withAutoLockSuspended<T>(fn: () => Promise<T>): Promise<T> {
  suspended++;
  try {
    return await fn();
  } finally {
    suspended--;
    touch();
  }
}

export function isAutoLockSuspended(): boolean {
  return suspended > 0;
}
