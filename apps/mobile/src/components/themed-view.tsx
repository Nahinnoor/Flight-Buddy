import { View, type ViewProps } from 'react-native';

import { type ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

// The template also declared `lightColor` / `darkColor` props that nothing ever
// read — `type` picks a token and `useTheme` resolves it per scheme. Dropped.
export type ThemedViewProps = ViewProps & {
  type?: ThemeColor;
};

export function ThemedView({ style, type, ...otherProps }: ThemedViewProps) {
  const theme = useTheme();

  return <View style={[{ backgroundColor: theme[type ?? 'background'] }, style]} {...otherProps} />;
}
