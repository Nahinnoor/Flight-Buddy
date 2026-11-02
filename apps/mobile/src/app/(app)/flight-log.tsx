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
import { useMemo } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { FlightLogRow } from '@/components/profile/flight-log-row';
import { SectionEmpty, SectionStatus, sectionState } from '@/components/section';
import { ThemedView } from '@/components/themed-view';
import { ContentColumn, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useRefreshControl } from '@/hooks/use-refresh-control';
import { useReloadOnFocus } from '@/hooks/use-reload-on-focus';
import { useUserRemote } from '@/hooks/use-remote';
import { useTheme } from '@/hooks/use-theme';
import { fetchAllMySegments } from '@/lib/flights';
import { flightLogEntry, flightsTaken } from '@/lib/profile-stats';
import { useSession } from '@/providers/session-provider';

export default function FlightLogScreen() {
  const theme = useTheme();
  const { userId } = useSession();
  const now = useNow(60_000);

  const segments = useUserRemote(userId, fetchAllMySegments, 'Could not load your flights.');
  const { reload } = segments;

  useReloadOnFocus(reload);
  const refreshControl = useRefreshControl(reload);

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
        refreshControl={refreshControl}
        ListEmptyComponent={
          <View style={styles.notice}>
            <SectionStatus remote={segments} loadingLabel="Loading your flights" />
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
    ...ContentColumn,
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
