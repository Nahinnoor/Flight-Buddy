/**
 * The active passport-cover palette, resolved exactly the way `useTheme` and
 * `useIllustration` resolve theirs: `'unspecified'` means light.
 */

import { Passport, type PassportPalette } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function usePassport(): PassportPalette {
  const scheme = useColorScheme();
  const theme = scheme === 'unspecified' ? 'light' : scheme;

  return Passport[theme];
}
