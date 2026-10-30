/** The active illustration palette, resolved the way `useTheme` resolves its own. */

import { Illustration, type IllustrationPalette } from '@/constants/theme';
import { useScheme } from '@/hooks/use-scheme';

/** Used by the welcome artwork and the Profile level card. */
export function useIllustration(): IllustrationPalette {
  return Illustration[useScheme()];
}
