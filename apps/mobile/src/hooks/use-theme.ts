/** The active interface palette (`useScheme` resolves "no preference" to light). */

import { Colors } from '@/constants/theme';
import { useScheme } from '@/hooks/use-scheme';

/** The colours the screens and shared components style themselves with. */
export function useTheme() {
  return Colors[useScheme()];
}
