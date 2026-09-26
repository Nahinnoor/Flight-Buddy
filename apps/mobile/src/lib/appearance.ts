/**
 * The appearance preference: follow the system, or force light or dark.
 *
 * Pure, no imports: the provider (`src/providers/appearance-provider.tsx`)
 * does the storage and the native call, and this file decides what a stored
 * value means. Tested by `appearance.test.ts`.
 */

export type AppearancePreference = 'system' | 'light' | 'dark';

export const APPEARANCE_PREFERENCES: readonly AppearancePreference[] = ['system', 'light', 'dark'];

/** Device-only storage key. The value is one of the three words; no secret. */
export const APPEARANCE_STORAGE_KEY = 'flightbuddy.appearance';

export const APPEARANCE_LABELS: Record<AppearancePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Whatever came out of storage — nothing, a value from an older build, or
 * something corrupt — reads as `system`, the default.
 */
export function parseAppearancePreference(stored: string | null | undefined): AppearancePreference {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/**
 * The value React Native's `Appearance.setColorScheme` takes. `unspecified`
 * removes the override, so the app follows the system again.
 */
export function colorSchemeOverride(
  preference: AppearancePreference,
): 'light' | 'dark' | 'unspecified' {
  return preference === 'system' ? 'unspecified' : preference;
}
