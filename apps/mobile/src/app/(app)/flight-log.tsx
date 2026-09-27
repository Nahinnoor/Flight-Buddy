/**
 * Flight log (pushed from Profile's "See all", and from the dashboard's past
 * flights): every flight you have taken, most recent first, in the same rows
 * as the Profile preview. "Taken" is `profile-stats.ts`'s definition — landed
 * or past its arrival, never cancelled, one row per flight even when it sits
 * on two of your trips.
 *
 * One query (`fetchAllMySegments`), pull to refresh, and the shared section
 * states for loading, error and empty.
 */
import { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { FlightLogRow } from '@/components/profile/flight-log-row';
import { SectionEmpty, SectionError, SectionLoading, sectionState } from '@/components/section';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useRemote } from '@/hooks/use-remote';
import { useTheme } from '@/hooks/use-theme';
import { fetchAllMySegments } from '@/lib/flights';
import { flightLogEntry, flightsTaken } from '@/lib/profile-stats';
import { useSession } from '@/providers/session-provider';

export default function FlightLogScreen() {
  const theme = useTheme();
  const { userId } = useSession();
  const now = useNow(60_000);

  const segments = useRemote(
    useMemo(() => (userId === null ? null : () => fetchAllMySegments(userId)), [userId]),
    'Could not load your flights.',
  );
  const { reload } = segments;

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const [isRefreshing, setIsRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await reload();
    setIsRefreshing(false);
  }, [reload]);

  const entries = useMemo(
    () => (segments.data === null ? [] : flightsTaken(segments.data, now).map(flightLogEntry)),
    [segments.data, now],
  );
  const state = sectionState(segments.data, segments.error);
  const last = entries.length - 1;

  return (
    <ThemedView style={styles.screen}>
      <FlatList
        data={entries}
        keyExtractor={(entry) => entry.key}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void onRefresh()}
            tintColor={theme.textSecondary}
          />
        }
        ListEmptyComponent={
          <View style={styles.notice}>
            {state === 'loading' ? <SectionLoading label="Loading your flights" /> : null}
            {state === 'error' ? (
              <SectionError message={segments.error ?? ''} onRetry={() => void reload()} />
            ) : null}
            {state === 'ready' ? <SectionEmpty>Flights move here after they land.</SectionEmpty> : null}
          </View>
        }
        renderItem={({ item, index }) => (
          // Each row draws its slice of the one rounded card, so the list can
          // stay virtualised instead of rendering every flight inside one View.
          <View
            style={[
              styles.slice,
              { backgroundColor: theme.backgroundElement },
              index === 0 && styles.sliceFirst,
              index === last && styles.sliceLast,
            ]}>
            <FlightLogRow entry={item} first={index === 0} />
          </View>
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.three,
    paddingBottom: Spacing.five,
  },
  notice: {
    gap: Spacing.two,
  },
  slice: {
    paddingHorizontal: 14,
  },
  sliceFirst: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  sliceLast: {
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
});
