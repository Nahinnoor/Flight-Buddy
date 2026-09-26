/**
 * Settings tab: notifications, appearance, and the app version.
 *
 * - **Quiet hours** is `profiles.quiet_hours_enabled`, written under RLS
 *   (`profiles_update_self`). Push itself is wave 5 and not built, so the
 *   screen says the notifications arrive with the next update.
 * - **Appearance** is device-only (`AppearanceProvider`), default System.
 * - In a development build running mock mode, a mock-data switch appears so
 *   every dashboard state can be seen without rebuilding. It never renders in
 *   a real-data or release build.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';

import { TAB_SCREEN_BOTTOM_INSET } from '@/components/app-tab-bar';
import { Section, SectionError, SectionLoading, sectionState } from '@/components/section';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useRemote } from '@/hooks/use-remote';
import { useTheme } from '@/hooks/use-theme';
import {
  APPEARANCE_LABELS,
  APPEARANCE_PREFERENCES,
  type AppearancePreference,
} from '@/lib/appearance';
import { MOCK_API } from '@/lib/env';
import { MOCK_SCENARIO_LABELS, MOCK_SCENARIOS, type MockScenario } from '@/lib/mock/fixtures';
import { getMockScenario, setMockScenario } from '@/lib/mock/store';
import { fetchProfile, setQuietHours } from '@/lib/profile';
import { useAppearance } from '@/providers/appearance-provider';
import { useSession } from '@/providers/session-provider';

export default function SettingsScreen() {
  const theme = useTheme();
  const { userId } = useSession();
  const { preference, setPreference } = useAppearance();

  const profile = useRemote(
    useMemo(() => (userId === null ? null : () => fetchProfile(userId)), [userId]),
    'Could not load your settings.',
  );
  const { reload } = profile;
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  // Optimistic: the switch moves at once, and moves back if the write fails.
  const [quietOverride, setQuietOverride] = useState<boolean | null>(null);
  const [quietError, setQuietError] = useState<string | null>(null);
  const [isSavingQuiet, setIsSavingQuiet] = useState(false);
  const quietHours = quietOverride ?? profile.data?.quietHoursEnabled ?? true;

  const toggleQuietHours = useCallback(
    async (next: boolean) => {
      if (userId === null) return;
      setQuietOverride(next);
      setQuietError(null);
      setIsSavingQuiet(true);
      try {
        await setQuietHours(userId, next);
        await reload();
      } catch (caught) {
        setQuietError(caught instanceof Error ? caught.message : 'Could not save that setting.');
      } finally {
        setQuietOverride(null);
        setIsSavingQuiet(false);
      }
    },
    [reload, userId],
  );

  const state = sectionState(profile.data, profile.error);
  const version = Constants.expoConfig?.version ?? 'unknown';
  const build = Constants.nativeBuildVersion;

  return (
    <ThemedView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.inner}>
          <Section title="Notifications">
            {state === 'loading' ? <SectionLoading label="Loading your settings" /> : null}
            {state === 'error' ? (
              <SectionError message={profile.error ?? ''} onRetry={() => void reload()} />
            ) : null}
            {state === 'ready' ? (
              <View style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                <View style={styles.switchRow}>
                  <View style={styles.switchText}>
                    <ThemedText type="default" style={styles.rowTitle}>
                      Quiet hours
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      Other members&apos; updates wait until a day or two before the flight they
                      are about. Cancellations always come through, and your own flight always
                      notifies.
                    </ThemedText>
                  </View>
                  <Switch
                    value={quietHours}
                    disabled={isSavingQuiet}
                    onValueChange={(next) => void toggleQuietHours(next)}
                    trackColor={{ true: theme.accent, false: theme.backgroundSelected }}
                    accessibilityLabel="Quiet hours"
                  />
                </View>
                {quietError !== null ? (
                  <ThemedText type="small" style={{ color: theme.criticalText }} accessibilityLiveRegion="polite">
                    {quietError}
                  </ThemedText>
                ) : null}
              </View>
            ) : null}
            <ThemedText type="small" themeColor="textSecondary">
              Notifications themselves arrive with the next update of FlightBuddy. This setting is
              saved now and will apply then.
            </ThemedText>
          </Section>

          <Section title="Appearance">
            <OptionGroup
              label="Appearance"
              options={APPEARANCE_PREFERENCES}
              labels={APPEARANCE_LABELS}
              value={preference}
              onChange={(next: AppearancePreference) => setPreference(next)}
            />
            <ThemedText type="small" themeColor="textSecondary">
              System follows your iPhone&apos;s setting. Stored on this device only.
            </ThemedText>
          </Section>

          {__DEV__ && MOCK_API ? <MockScenarioSection /> : null}

          <Section title="About">
            <View
              accessible
              accessibilityLabel={`App version ${version}${build ? `, build ${build}` : ''}`}
              style={[styles.card, styles.aboutRow, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
              <ThemedText type="default">Version</ThemedText>
              <ThemedText type="default" themeColor="textSecondary">
                {build ? `${version} (${build})` : version}
              </ThemedText>
            </View>
          </Section>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

/** A segmented choice: `radiogroup` of `radio`s, each 44pt tall. */
function OptionGroup<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (next: T) => void;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.segments, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
      {options.map((option) => {
        const selected = option === value;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityLabel={labels[option]}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option)}
            style={({ pressed }) => [
              styles.segment,
              {
                backgroundColor: selected ? theme.accent : 'transparent',
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <ThemedText
              type="smallBold"
              style={{ color: selected ? theme.onAccent : theme.text }}>
              {labels[option]}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Dev + mock only. Pull to refresh (or switch tabs) to see the change. */
function MockScenarioSection() {
  const [scenario, setScenario] = useState<MockScenario>(getMockScenario());
  return (
    <Section title="Mock data (dev only)">
      <OptionGroup
        label="Mock data scenario"
        options={MOCK_SCENARIOS}
        labels={MOCK_SCENARIO_LABELS}
        value={scenario}
        onChange={(next) => {
          setMockScenario(next);
          setScenario(next);
        }}
      />
    </Section>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingBottom: TAB_SCREEN_BOTTOM_INSET,
  },
  inner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.three,
    gap: Spacing.four,
  },
  card: {
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  switchText: {
    flex: 1,
    gap: Spacing.one,
  },
  rowTitle: {
    fontWeight: '600',
  },
  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 50,
    paddingVertical: 0,
  },
  segments: {
    flexDirection: 'row',
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.one,
    gap: Spacing.one,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    borderRadius: Spacing.two + Spacing.one,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
