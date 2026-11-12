// Just enough of React for lib/session.ts and lib/usePin.ts to load.
export const useSyncExternalStore = (_s, get) => get();
export const useRef = (v) => ({ current: v });
export const useState = (v) => [v, () => {}];
export const useCallback = (f) => f;
export default { useSyncExternalStore, useRef, useState, useCallback };
