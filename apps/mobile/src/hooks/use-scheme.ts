/**
 * The active colour scheme (the device's, or the Settings override) as a palette
 * key. `useColorScheme` reports `'unspecified'` when the device has no
 * preference, which is not a key in any palette — light is the answer there.
 *
 * https://docs.expo.dev/guides/color-schemes/
 */
import { useColorScheme } from '@/hooks/use-color-scheme';

/** Used by `useTheme`, `useIllustration` and `usePassport`. */
export function useScheme(): 'light' | 'dark' {
  const scheme = useColorScheme();
  return scheme === 'unspecified' ? 'light' : scheme;
}
