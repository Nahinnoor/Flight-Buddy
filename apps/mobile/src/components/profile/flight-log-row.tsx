/**
 * One flight you have taken — `JFK → LAX` over `Sep 7 · XY 123 · 5h 20m`,
 * with how it ended in a pill — and the rounded group those rows sit in, on
 * both the Profile preview and the full Flight log.
 *
 * Rows are not tappable (there is no flight detail screen yet), so each is one
 * plain element to VoiceOver. The pill always carries its own word, so its
 * colour is never the only signal.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import type { ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { FlightLogEntry, PillTone } from '@/lib/profile-stats';

const PILL_COLORS: Record<PillTone, [ThemeColor, ThemeColor]> = {
  neutral: ['neutralSurface', 'neutralText'],
  positive: ['positiveSurface', 'positiveText'],
  warning: ['warningSurface', 'warningText'],
  critical: ['criticalSurface', 'criticalText'],
};

/** The rounded card a run of rows sits in. */
export function FlightLogGroup({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <View style={[styles.group, { backgroundColor: theme.backgroundElement }]}>{children}</View>;
}

export function FlightLogRow({ entry, first }: { entry: FlightLogEntry; first: boolean }) {
  const theme = useTheme();
  const [surface, ink] = PILL_COLORS[entry.pill.tone];
  return (
    <View
      accessible
      accessibilityLabel={entry.accessibilityLabel}
      style={[
        styles.row,
        !first && { borderTopWidth: 1, borderTopColor: theme.border },
      ]}>
      <View style={[styles.icon, { backgroundColor: theme.accentSurface }]}>
        <SymbolView name="airplane" tintColor={theme.accent} size={17} fallback={null} />
      </View>
      <View style={styles.text}>
        <ThemedText style={styles.route} numberOfLines={1}>
          {entry.route}
        </ThemedText>
        <ThemedText style={styles.meta} themeColor="textSecondary">
          {entry.meta}
        </ThemedText>
      </View>
      <View style={[styles.pill, { backgroundColor: theme[surface] }]}>
        <Text style={[styles.pillText, { color: theme[ink] }]} maxFontSizeMultiplier={1.5} numberOfLines={1}>
          {entry.pill.label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  icon: {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  route: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '600',
  },
  meta: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400',
  },
  pill: {
    flexShrink: 0,
    minHeight: 24,
    paddingHorizontal: 9,
    borderRadius: 12,
    justifyContent: 'center',
  },
  pillText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
});
