/**
 * A small rounded label in one of the status tones: a flight's status, "Not
 * live-tracked", "Coming soon". The word carries the meaning, so the colour is
 * never the only signal.
 */
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing, TONE_COLORS, type Tone } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function Pill({ label, tone }: { label: string; tone: Tone }) {
  const theme = useTheme();
  const { surface, text } = TONE_COLORS[tone];

  return (
    <View style={[styles.pill, { backgroundColor: theme[surface] }]}>
      <ThemedText type="smallBold" style={[styles.pillText, { color: theme[text] }]}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: 999,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  pillText: {
    fontSize: 12,
    lineHeight: 16,
  },
});
