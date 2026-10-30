/** The active passport-cover palette, resolved the way `useTheme` resolves its own. */

import { Passport, type PassportPalette } from '@/constants/theme';
import { useScheme } from '@/hooks/use-scheme';

export function usePassport(): PassportPalette {
  return Passport[useScheme()];
}
