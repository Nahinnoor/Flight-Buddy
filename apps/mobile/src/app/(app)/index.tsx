/**
 * Dashboard.
 *
 * The user's next flight pinned at the top with a live countdown (§3.5), every
 * other leg below it, earliest first. One Supabase query for all of it
 * (`fetchMySegments`) — the N+1 that §8.11 warns about for the group page shows
 * up here first, the moment someone has a two-leg trip.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useFocusEffect, useRouter } from 'expo-router';

import { cardDataFromSegment, FlightCard } from '@/components/flight-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fetchMySegments, pickNextSegment, type SegmentView } from '@/lib/flights';
import { useSession } from '@/providers/session-provider';

export default function DashboardScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { userId, displayName, signOut } = useSession();

  const [segments, setSegments] = useState<SegmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (userId === null) return;
      if (mode === 'refresh') setIsRefreshing(true);
      try {
        setSegments(await fetchMySegments(userId));
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not load your flights.');
      } finally {
        if (mode === 'refresh') setIsRefreshing(false);
      }
    },
    [userId],
  );

  // A failed sign-out leaves the session in place (supabase-js only clears it
  // when the server revoke succeeds or says the session is already gone), so
  // the user must be told, or the button reads as doing nothing.
  const handleSignOut = useCallback(async () => {
    try {
      await signOut();
    } catch (caught) {
      Alert.alert(
        'Could not sign out',
        caught instanceof Error ? caught.message : 'Check your connection and try again.',
      );
    }
  }, [signOut]);

  // Refetch on focus, so returning from add-flight shows the new segment
  // without a manual pull. `useCallback` keeps this from re-running per render.
  useFocusEffect(
    useCallback(() => {
      void load('initial');
    }, [load]),
  );

  const { next, rest } = useMemo(() => {
    if (segments === null) return { next: null, rest: [] as SegmentView[] };
    const pinned = pickNextSegment(segments);
    return {
      next: pinned,
      rest: segments.filter((segment) => segment.segmentId !== pinned?.segmentId),
    };
  }, [segments]);

  const isLoading = segments === null && error === null;

  return (
    <ThemedView style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              onPress={() => void handleSignOut()}
              hitSlop={Spacing.two}
            >
              <ThemedText type="small" style={{ color: theme.accent }}>
                Sign out
              </ThemedText>
            </Pressable>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={() => void load('refresh')} />
        }
      >
        <SafeAreaView edges={['bottom']} style={styles.inner}>
          {displayName !== null ? (
            <ThemedText type="small" themeColor="textSecondary">
              Signed in as {displayName}
            </ThemedText>
          ) : null}

          {isLoading ? (
            <View style={styles.centre}>
              <ActivityIndicator color={theme.text} />
            </View>
          ) : null}

          {error !== null ? (
            <View style={[styles.notice, { backgroundColor: theme.criticalSurface }]}>
              <ThemedText type="small" style={{ color: theme.criticalText }}>
                {error}
              </ThemedText>
              <Pressable accessibilityRole="button" onPress={() => void load('refresh')}>
                <ThemedText type="smallBold" style={{ color: theme.criticalText }}>
                  Try again
                </ThemedText>
              </Pressable>
            </View>
          ) : null}

          {next !== null ? (
            <View style={styles.section}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                NEXT FLIGHT
              </ThemedText>
              <FlightCard
                data={cardDataFromSegment(next)}
                variant="pinned"
                caption={next.tripLabel}
              />
            </View>
          ) : null}

          {rest.length > 0 ? (
            <View style={styles.section}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                {rest.length === 1 ? 'OTHER LEG' : 'OTHER LEGS'}
              </ThemedText>
              {rest.map((segment) => (
                <FlightCard
                  key={segment.segmentId}
                  data={cardDataFromSegment(segment)}
                  caption={segment.tripLabel ?? `Leg ${segment.sequenceNumber}`}
                />
              ))}
            </View>
          ) : null}

          {segments !== null && segments.length === 0 ? (
            <View style={styles.empty}>
              <ThemedText type="subtitle" style={styles.emptyTitle}>
                No flights yet
              </ThemedText>
              <ThemedText type="default" themeColor="textSecondary" style={styles.emptyBody}>
                Add your flight number and date and FlightBuddy will track the rest — gate,
                terminal, delays, the lot.
              </ThemedText>
            </View>
          ) : null}
        </SafeAreaView>
      </ScrollView>

      <SafeAreaView edges={['bottom']} style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add flight"
          onPress={() => router.push('/add-flight')}
          style={({ pressed }) => [
            styles.primaryButton,
            { backgroundColor: theme.accent, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <ThemedText type="default" style={styles.primaryLabel}>
            Add flight
          </ThemedText>
        </Pressable>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  inner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.three,
    gap: Spacing.four,
  },
  section: {
    gap: Spacing.two,
  },
  centre: {
    paddingVertical: Spacing.six,
    alignItems: 'center',
  },
  notice: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  empty: {
    paddingTop: Spacing.five,
    gap: Spacing.two,
  },
  emptyTitle: {
    fontSize: 24,
    lineHeight: 32,
  },
  emptyBody: {
    maxWidth: 420,
  },
  footer: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  primaryButton: {
    height: 50,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: {
    color: '#ffffff',
    fontWeight: '700',
  },
});
