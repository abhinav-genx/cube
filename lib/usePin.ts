import { useCallback, useRef, useState } from 'react';

export const PIN_MIN = 4;
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

  /** Returns the PIN bytes and clears the buffer. */
  const take = useCallback((): Uint8Array => {
    const out = buf.current.slice(0, len.current);
    buf.current.fill(0);
    len.current = 0;
    setCount(0);
    return out;
  }, []);

  return { count, push, pop, clear, take };
}
