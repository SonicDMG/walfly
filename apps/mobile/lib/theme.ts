/**
 * Walfly Design System — theme tokens
 *
 * Dark-first. Amber on Midnight.
 * "The moments you were there for."
 */

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export const colors = {
  // Backgrounds
  midnight:    '#0D0D0F',   // primary background
  obsidian:    '#141416',   // surface / card background
  charcoal:    '#1E1E22',   // elevated surface (modals, inputs)
  border:      '#2A2A2F',   // subtle dividers

  // Amber — the amber fossil: moments preserved forever
  amber:       '#F5A623',   // primary accent
  amberDim:    '#C4801A',   // pressed / secondary
  amberGlow:   '#F5A62326', // rings, halos, shadows
  amberSubtle: '#F5A62312', // badge fills, tinted backgrounds

  // Text
  cream:       '#F5EDD6',   // primary text on dark
  mist:        '#9B9AA3',   // secondary / muted text
  fog:         '#55545D',   // placeholder / disabled

  // Status
  success:     '#4CAF7D',
  successSubtle: '#4CAF7D18',
  error:       '#FF5757',
  errorSubtle: '#FF575718',
  warning:     '#F5A623',   // reuse amber for warning — same palette

  // Absolute
  white:       '#FFFFFF',
  black:       '#000000',
} as const;

export type ColorToken = keyof typeof colors;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const fonts = {
  // Playfair Display: editorial serif — warmth, timelessness, classic weight
  // Loaded via expo-font. Fallback: Georgia → serif
  display:  'PlayfairDisplay_700Bold',
  title:    'PlayfairDisplay_600SemiBold',

  // Inter: neutral, legible, system-native feel
  // Loaded via expo-font. Fallback: -apple-system → system
  body:     'Inter_400Regular',
  bodyMed:  'Inter_500Medium',
  bold:     'Inter_600SemiBold',
} as const;

export const fontSizes = {
  xs:   11,
  sm:   13,
  base: 15,
  md:   17,
  lg:   20,
  xl:   24,
  xxl:  28,
  disp: 36,
} as const;

export const lineHeights = {
  tight:  1.2,
  snug:   1.35,
  normal: 1.5,
  loose:  1.7,
} as const;

export const letterSpacings = {
  tight:  -0.5,
  normal:  0,
  wide:    0.5,
  wider:   1,
} as const;

// ---------------------------------------------------------------------------
// Spacing (4-point base grid)
// ---------------------------------------------------------------------------

export const spacing = {
  px:   1,
  xxs:  4,
  xs:   8,
  sm:  12,
  md:  16,
  lg:  24,
  xl:  32,
  xxl: 48,
  '3xl': 64,
} as const;

// ---------------------------------------------------------------------------
// Radius
// ---------------------------------------------------------------------------

export const radius = {
  sm:   6,
  md:  12,
  lg:  18,
  xl:  24,
  full: 9999,
} as const;

// ---------------------------------------------------------------------------
// Shadows (iOS elevation)
// ---------------------------------------------------------------------------

export const shadow = {
  sm: {
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: colors.amber,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 6,
  },
  glow: {
    shadowColor: colors.amber,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 20,
    elevation: 10,
  },
} as const;
