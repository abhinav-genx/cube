import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

// Palette drawn from the plant: frost on the trichomes, sage and leaf greens, deep pine,
// and one warm resin accent reserved for destructive or attention-worthy moments. Each name is a
// role, so the dark palette keeps the names: frost is always the background (and the text on a
// primary button), leaf the primary text and primary buttons, and so on.
export type Palette = {
  frost: string;   // background
  mist: string;    // pressed keys, rows
  sage: string;    // secondary text, hairlines
  leaf: string;    // primary text, primary buttons
  pine: string;    // a pressed primary button
  resin: string;   // accent, used sparingly
  paper: string;
};

export const light: Palette = {
  frost: '#ECF1EA',
  mist: '#DDE5DA',
  sage: '#8FA38B',
  leaf: '#24472E',
  pine: '#15301D',
  resin: '#B9893B',
  paper: '#FFFFFF',
};

/** The same roles at night: a deep pine background, pale leaf text, a brighter resin. */
export const dark: Palette = {
  frost: '#0F1A13',
  mist: '#1F2D24',
  sage: '#8A9E86',
  leaf: '#D3E3CE',
  pine: '#B2C9AB',
  resin: '#D9A956',
  paper: '#16221A',
};

/** The light palette, for code outside components (components use useColors, which follows the system). */
export const colors = light;

/** The palette for the system's light or dark appearance; components re-render when it changes. */
export function useColors(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Styles made from the current palette, rebuilt only when the appearance changes. */
export function useStyles<T>(make: (colors: Palette) => T): T {
  const c = useColors();
  return useMemo(() => make(c), [c, make]);
}

export const font = {
  regular: 'InstrumentSans_400Regular',
  medium: 'InstrumentSans_500Medium',
  semibold: 'InstrumentSans_600SemiBold',
} as const;

// Type scale (Elements of Typographic Style, ratio ~1.25)
export const type = {
  display: { fontFamily: font.medium, fontSize: 34, lineHeight: 40, letterSpacing: -0.6 },
  title: { fontFamily: font.semibold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  body: { fontFamily: font.regular, fontSize: 17, lineHeight: 25 },
  bodyMedium: { fontFamily: font.medium, fontSize: 17, lineHeight: 25 },
  small: { fontFamily: font.regular, fontSize: 14, lineHeight: 20 },
  key: { fontFamily: font.regular, fontSize: 30, lineHeight: 36, fontVariant: ['tabular-nums'] as const },
} as const;

export const space = { xs: 4, s: 8, m: 16, l: 24, xl: 40, xxl: 64 } as const;

export const radius = { key: 999, row: 12 } as const;
