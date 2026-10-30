/**
 * The device's colour scheme as a palette key. `useColorScheme` reports
 * `'unspecified'` when the device has no preference (and on the web build's
 * server pass), which is not a key in any palette — light is the answer there.
 *
 * https://docs.expo.dev/guides/color-schemes/
 */
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useScheme(): 'light' | 'dark' {
  const scheme = useColorScheme();
  return scheme === 'unspecified' ? 'light' : scheme;
}
