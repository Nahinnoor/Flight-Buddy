/**
 * The active palette. `useColorScheme` reports `'unspecified'` when the device
 * has no preference (and on the web build's server pass), which is not a key in
 * `Colors` — light is the answer there.
 *
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme() {
  const scheme = useColorScheme();
  const theme = scheme === 'unspecified' ? 'light' : scheme;

  return Colors[theme];
}
