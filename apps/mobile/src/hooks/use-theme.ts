/** The active interface palette (`useScheme` resolves "no preference" to light). */

import { Colors } from '@/constants/theme';
import { useScheme } from '@/hooks/use-scheme';

export function useTheme() {
  return Colors[useScheme()];
}
