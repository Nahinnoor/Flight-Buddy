/**
 * The active illustration palette, resolved exactly the way `useTheme` resolves
 * the interface palette: `useColorScheme` reports `'unspecified'` when the
 * device has no preference, which is not a key in `Illustration`, and light is
 * the answer there.
 */

import { Illustration, type IllustrationPalette } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useIllustration(): IllustrationPalette {
  const scheme = useColorScheme();
  const theme = scheme === 'unspecified' ? 'light' : scheme;

  return Illustration[theme];
}
