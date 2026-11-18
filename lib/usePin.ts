import { useCallback, useRef, useState } from 'react';

/** Shortest PIN the lock screen accepts (vaults set up under older rules may use 4 or 6). */
export const PIN_MIN = 4;
/**
 * Shortest PIN setup accepts: 8 digits is 100,000,000 combinations. Every guess has to run on
 * this phone (hardware key, attempt delay), but someone who gets that far gets 100 times further
 * with a 6-digit PIN.
 */
export const SETUP_PIN_MIN = 8;
export const PIN_MAX = 12;

/**
 * The digits live in a fixed Uint8Array held in a ref; React state only knows how many.
 * take() hands out a copy and zeros the buffer, so the PIN exists for as short a time as
 * JavaScript allows. (Hermes can still keep garbage around — see README.)
 */
export function usePin() {
  const buf = useRef(new Uint8Array(PIN_MAX));
  const len = useRef(0);
  const [count, setCount] = useState(0);

  const push = useCallback((digit: number) => {
    if (len.current >= PIN_MAX) return;
    buf.current[len.current++] = 48 + digit;   // ASCII '0'..'9'
    setCount(len.current);
  }, []);

  const pop = useCallback(() => {
    if (len.current === 0) return;
    buf.current[--len.current] = 0;
    setCount(len.current);
  }, []);

  const clear = useCallback(() => {
    buf.current.fill(0);
    len.current = 0;
    setCount(0);
  }, []);

  /**
   * Digits entered right now. Check this, not `count`, before acting on the PIN: `count` is the
   * last rendered value, and a Confirm tapped within a frame of the last digit (fast fingers, a
   * busy JS thread) would otherwise see one digit too few and be silently ignored.
   */
  const size = useCallback(() => len.current, []);

  /** Returns the PIN bytes and clears the buffer. */
  const take = useCallback((): Uint8Array => {
    const out = buf.current.slice(0, len.current);
    buf.current.fill(0);
    len.current = 0;
    setCount(0);
    return out;
  }, []);

  return { count, size, push, pop, clear, take };
}
