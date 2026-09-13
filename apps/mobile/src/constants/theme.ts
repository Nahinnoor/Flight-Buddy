/**
 * Colour, type and spacing tokens. Two palettes, resolved per scheme by
 * `useTheme`; nothing in a screen reaches for a hex value directly.
 */

import '@/global.css';

import { Platform } from 'react-native';

/**
 * Neutral greys, plus the four status tones a flight card needs.
 *
 * Each tone is a pair: a saturated `*Text` colour that carries the meaning, and
 * a muted `*Surface` behind it. Status is never signalled by colour alone —
 * every pill also carries its own word ("Delayed", "Cancelled") — so the pair
 * only has to clear contrast, not do the communicating on its own.
 */
export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
    border: '#DDDEE3',
    accent: '#0B63CE',
    neutralText: '#3E4149',
    neutralSurface: '#ECEDF0',
    positiveText: '#11663D',
    positiveSurface: '#DFF3E7',
    warningText: '#8A4B00',
    warningSurface: '#FDECD6',
    criticalText: '#9E2117',
    criticalSurface: '#FCE3E0',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
    border: '#33353A',
    accent: '#67A8FF',
    neutralText: '#C7CAD1',
    neutralSurface: '#25262A',
    positiveText: '#6FD79C',
    positiveSurface: '#122A1E',
    warningText: '#F2B25C',
    warningSurface: '#2E2113',
    criticalText: '#FF8C80',
    criticalSurface: '#301715',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

/** Keeps text measure sane if this ever runs on an iPad or the web build. */
export const MaxContentWidth = 800;
