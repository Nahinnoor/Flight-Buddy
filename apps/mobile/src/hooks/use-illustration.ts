/** The active illustration palette, resolved the way `useTheme` resolves its own. */

import { Illustration, type IllustrationPalette } from '@/constants/theme';
import { useScheme } from '@/hooks/use-scheme';

export function useIllustration(): IllustrationPalette {
  return Illustration[useScheme()];
}
