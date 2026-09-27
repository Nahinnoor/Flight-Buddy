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
    /** Text and icons drawn on an `accent` fill. White on this blue is 5.7:1. */
    onAccent: '#FFFFFF',
    /** Drop shadow under raised controls (the tab bar's add button). */
    shadow: '#000000',
    neutralText: '#3E4149',
    neutralSurface: '#ECEDF0',
    positiveText: '#11663D',
    positiveSurface: '#DFF3E7',
    warningText: '#8A4B00',
    warningSurface: '#FDECD6',
    criticalText: '#9E2117',
    criticalSurface: '#FCE3E0',
    /** A pale wash of `accent`: the level chip, the flight-log plane chip. */
    accentSurface: '#E3EEFB',
    /**
     * Three decorative tints, each a `*Text` icon colour on its `*Surface`.
     * They tell the Profile insight rows apart and mean nothing about a
     * flight, so they are deliberately not the status tones above. Every
     * pair clears 4.5:1 (teal was darkened from the design's #1D7A62, which
     * measured 4.48:1).
     */
    orangeText: '#B24A22',
    orangeSurface: '#FDE9E0',
    tealText: '#1A735C',
    tealSurface: '#DDF2EB',
    yellowText: '#8A5A00',
    yellowSurface: '#FBF0D4',
    /**
     * Avatar fills for people's initials, cycled in order; blue uses
     * `accent` / `onAccent`. `onAvatar` is the initials colour on orange, teal
     * and yellow: 5.7, 5.3 and 8.3:1 in light (near-black), 8.3, 9.2 and
     * 12.2:1 in dark (black). Red takes `onAvatarRed`: white on #D8362A is
     * 4.7:1 in light, black on #FF6A5C is 7.5:1 in dark.
     */
    avatarOrange: '#E8734A',
    avatarTeal: '#37A085',
    avatarYellow: '#E0AC33',
    avatarRed: '#D8362A',
    onAvatar: '#1B1B1F',
    onAvatarRed: '#FFFFFF',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
    border: '#33353A',
    accent: '#67A8FF',
    /**
     * Black, not white: this accent is a light blue, and white on it is 2.4:1.
     * Black on it is 8.6:1.
     */
    onAccent: '#000000',
    shadow: '#000000',
    neutralText: '#C7CAD1',
    neutralSurface: '#25262A',
    positiveText: '#6FD79C',
    positiveSurface: '#122A1E',
    warningText: '#F2B25C',
    warningSurface: '#2E2113',
    criticalText: '#FF8C80',
    criticalSurface: '#301715',
    accentSurface: '#10223A',
    orangeText: '#F5A07F',
    orangeSurface: '#33201A',
    tealText: '#6FD7B6',
    tealSurface: '#12291F',
    yellowText: '#EDBF52',
    yellowSurface: '#2E2513',
    avatarOrange: '#F0875C',
    avatarTeal: '#4FBE9D',
    avatarYellow: '#EDBF52',
    avatarRed: '#FF6A5C',
    onAvatar: '#000000',
    onAvatarRed: '#000000',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * Colours that exist only inside drawn artwork.
 *
 * Kept apart from `Colors` on purpose. The tokens above carry *meaning* — an
 * app-wide accent, and four status tones a flight card reads from. Artwork
 * needs a globe, some land, a trail and a red map pin, and none of those mean
 * anything about a flight. Binding the pin to `criticalText` in particular
 * would be a trap: that token says "cancelled or delayed", so the first time
 * somebody retunes the cancelled-flight red, the brand illustration would
 * change with it for no reason anyone could find.
 *
 * Both schemes are listed, so one drawing recolours rather than shipping a
 * second asset. Contrast was checked against the scheme's own background:
 * `globeEdge` clears 3:1 on white (the ocean fill alone does not, so the rim
 * is what defines the silhouette), and in dark the ocean itself clears 3:1 on
 * black. `figureInk` stays dark in both schemes because a figure's head is
 * half over the fuselage and half over open sky — on the pale dark-mode
 * fuselage the outline is the only thing separating skin from body.
 */
export const Illustration = {
  light: {
    /** Soft halo behind the globe, separating it from the page. */
    sky: '#EAF3FE',
    globeOcean: '#BFDCF8',
    globeLand: '#77C79A',
    globeGraticule: '#9FC9EE',
    globeEdge: '#5C90C2',
    /** The dashed route line. */
    trail: '#3C5C88',
    /** Departure markers sitting on the globe. */
    originRing: '#FFFFFF',
    originDot: '#2F4664',
    planeBody: '#2F4664',
    planeWing: '#51688C',
    /** Window openings, and the cockpit glass. */
    planeWindow: '#141F33',
    figureSkin: '#F4C79C',
    /** Outlines, eyes and smiles. */
    figureInk: '#141F33',
    figureShirtOne: '#E8734A',
    figureShirtTwo: '#37A085',
    figureShirtThree: '#E0AC33',
    /** The destination pin. Deliberately not `criticalText`. */
    pin: '#D8362A',
    pinCore: '#FFFFFF',
    pinShadow: '#5C8CB8',
  },
  dark: {
    sky: '#0C1722',
    globeOcean: '#35608A',
    globeLand: '#3E8C63',
    globeGraticule: '#5B87AE',
    globeEdge: '#53809F',
    trail: '#8FB4E4',
    originRing: '#0E1A28',
    originDot: '#DCE5F2',
    planeBody: '#D7E2F2',
    planeWing: '#A4B7D2',
    planeWindow: '#3A4A63',
    figureSkin: '#F4C79C',
    figureInk: '#1A2537',
    figureShirtOne: '#F0875C',
    figureShirtTwo: '#4FBE9D',
    figureShirtThree: '#EDBF52',
    pin: '#FF6A5C',
    pinCore: '#1A1416',
    pinShadow: '#0C1C2C',
  },
} as const;

export type IllustrationColor = keyof typeof Illustration.light &
  keyof typeof Illustration.dark;

/**
 * Both schemes widen to this. Not `typeof Illustration.light`: `as const` gives
 * every value a literal type, and the dark palette would then fail to be one.
 */
export type IllustrationPalette = Record<IllustrationColor, string>;

/**
 * The Profile passport cover. Like `Illustration`, these exist only inside
 * one drawing — a navy booklet with gold lettering — and carry no meaning
 * about a flight, so they live apart from `Colors`. The cover is dark in both
 * schemes (it is a passport, not a surface), slightly deeper in dark mode so
 * it does not glow against a black page. Contrast on `cover`: `coverInk`
 * 12.4:1 / 15.6:1, `coverSub` 7.2:1 / 7.7:1, `gold` 7.7:1 / 9.1:1, and the
 * initials (drawn in `cover` on `photo`) 11.1:1 / 12.7:1.
 */
export const Passport = {
  light: {
    cover: '#1F3553',
    /** Primary text on the cover. */
    coverInk: '#FFFFFF',
    /** Field labels, the stat captions and the machine-readable lines. */
    coverSub: '#B9C6D8',
    /** The FLIGHTBUDDY … PASSPORT line and the dashed trail. */
    gold: '#F1C65B',
    /** Globe outline and the rule above the totals. Decorative, no contrast target. */
    coverLine: '#34507A',
    /** The photo tile behind the initials. */
    photo: '#EAF3FE',
  },
  dark: {
    cover: '#15243A',
    coverInk: '#FFFFFF',
    coverSub: '#A9B8CC',
    gold: '#EDBF52',
    coverLine: '#2A4262',
    photo: '#DCE9F8',
  },
} as const;

export type PassportColor = keyof typeof Passport.light & keyof typeof Passport.dark;
export type PassportPalette = Record<PassportColor, string>;

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
