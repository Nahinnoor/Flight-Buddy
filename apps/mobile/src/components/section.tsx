/**
 * The building blocks every signed-in screen's sections share: a heading, a
 * loading row, an error notice with a retry, and a quiet "nothing here" line.
 * Each section of a screen loads on its own, so each shows its own state —
 * a failed groups query must not blank the flight above it.
 */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  /** Optional control on the heading's right, e.g. "See all". */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <ThemedText type="smallBold" themeColor="textSecondary" accessibilityRole="header">
          {title.toUpperCase()}
        </ThemedText>
        {action}
      </View>
      {children}
    </View>
  );
}

export function SectionLoading({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View style={styles.loading} accessible accessibilityLabel={label}>
      <ActivityIndicator color={theme.textSecondary} />
    </View>
  );
}

export function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.notice, { backgroundColor: theme.criticalSurface }]}>
      <ThemedText type="small" style={{ color: theme.criticalText }}>
        {message}
      </ThemedText>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        hitSlop={Spacing.three}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, alignSelf: 'flex-start' })}>
        <ThemedText type="smallBold" style={{ color: theme.criticalText }}>
          Try again
        </ThemedText>
      </Pressable>
    </View>
  );
}

export function SectionEmpty({ children }: { children: ReactNode }) {
  return (
    <ThemedText type="small" themeColor="textSecondary">
      {children}
    </ThemedText>
  );
}

/** A text-only link-style button with a 44pt target. */
export function TextButton({
  label,
  onPress,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      <ThemedText type="smallBold" style={{ color: theme.accent }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

/** Loading → error → content, for one section. */
export function sectionState<T>(value: T | null, error: string | null): 'loading' | 'error' | 'ready' {
  if (error !== null) return 'error';
  if (value === null) return 'loading';
  return 'ready';
}

const styles = StyleSheet.create({
  section: {
    gap: Spacing.two,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  loading: {
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  notice: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
});
