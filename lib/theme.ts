// Palette drawn from the plant: frost on the trichomes, sage and leaf greens, deep pine,
// and one warm resin accent reserved for destructive or attention-worthy moments.
export const colors = {
  frost: '#ECF1EA',   // background
  mist: '#DDE5DA',    // pressed keys, rows
  sage: '#8FA38B',    // secondary text, hairlines
  leaf: '#24472E',    // primary text, primary buttons
  pine: '#15301D',    // deepest green
  resin: '#B9893B',   // accent, used sparingly
  paper: '#FFFFFF',
} as const;

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
