/**
 * Profile tab: your FlightBuddy passport.
 *
 * Top to bottom:
 *
 * 1. A large "Profile" title with an Edit button (opens Account).
 * 2. **The passport cover**: name, level, home base, member-since and the four
 *    lifetime totals.
 * 3. **Frequent flyer level**: the altitude chart.
 * 4. **Flying with friends**, this year: buddies, group trips and up to three
 *    insights — or an invitation to the Groups tab.
 * 5. **Flight log**: the three most recent flights taken, "See all" → the
 *    Flight log screen.
 * 6. A row to Account (name, email and sign out).
 *
 * Three queries, side by side, each with its own loading and error state:
 * the profile (name, member-since), every one of your own legs (the totals,
 * level and log) and your groups' trips (friends). Every number is computed
 * in `profile-stats.ts`, where the definitions live and are tested.
 *
 * Nothing here writes. Names shown are plain text only.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TAB_SCREEN_BOTTOM_INSET } from '@/components/app-tab-bar';
import { FriendsCard, FriendsEmpty, FriendsHeading } from '@/components/profile/friends-card';
import { FlightLogGroup, FlightLogRow } from '@/components/profile/flight-log-row';
import { LevelCard } from '@/components/profile/level-card';
import { PassportCard } from '@/components/profile/passport-card';
import { SectionEmpty, SectionError, SectionLoading, sectionState } from '@/components/section';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useRemote } from '@/hooks/use-remote';
import { useTheme } from '@/hooks/use-theme';
import { deviceTimeZone } from '@/lib/device-time';
import { fetchAllMySegments } from '@/lib/flights';
import { fetchGroupTrips } from '@/lib/friends';
import { fetchProfile } from '@/lib/profile';
import {
  buildFriendsStats,
  buildProfileStats,
  flightLogEntry,
  formatMemberSince,
} from '@/lib/profile-stats';
import { useSession } from '@/providers/session-provider';

/** Flights shown on Profile before "See all". */
const LOG_PREVIEW = 3;

export default function ProfileScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const now = useNow(60_000);

  const profile = useRemote(
    useMemo(() => (userId === null ? null : () => fetchProfile(userId)), [userId]),
    'Could not load your profile.',
  );
  const segments = useRemote(
    useMemo(() => (userId === null ? null : () => fetchAllMySegments(userId)), [userId]),
    'Could not load your flights.',
  );
  const friends = useRemote(
    useMemo(() => (userId === null ? null : () => fetchGroupTrips(userId)), [userId]),
    'Could not load your group trips.',
  );
  const { reload: reloadProfile } = profile;
  const { reload: reloadSegments } = segments;
  const { reload: reloadFriends } = friends;

  const reloadAll = useCallback(
    () => Promise.all([reloadProfile(), reloadSegments(), reloadFriends()]),
    [reloadProfile, reloadSegments, reloadFriends],
  );

  // On focus, so a rename on Account or a flight that just landed shows up.
  useFocusEffect(
    useCallback(() => {
      void reloadAll();
    }, [reloadAll]),
  );

  const [isRefreshing, setIsRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await reloadAll();
    setIsRefreshing(false);
  }, [reloadAll]);

  const timeZone = deviceTimeZone();
  const stats = useMemo(
    () => (segments.data === null ? null : buildProfileStats(segments.data, now)),
    [segments.data, now],
  );
  const friendStats = useMemo(
    () => (friends.data === null ? null : buildFriendsStats(friends.data, now, timeZone)),
    [friends.data, now, timeZone],
  );
  const log = useMemo(
    () => (stats === null ? [] : stats.taken.slice(0, LOG_PREVIEW).map(flightLogEntry)),
    [stats],
  );

  const segmentsState = sectionState(segments.data, segments.error);
  const passportState =
    profile.error !== null || segments.error !== null
      ? 'error'
      : profile.data === null || stats === null
        ? 'loading'
        : 'ready';
  const friendsState = sectionState(friends.data, friends.error);
  const openAccount = () => router.push('/account');

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + Spacing.three }]}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void onRefresh()}
            tintColor={theme.textSecondary}
          />
        }>
        <View style={styles.inner}>
          {/* 1. Title and Edit. */}
          <View style={styles.header}>
            <Text
              style={[styles.largeTitle, { color: theme.text }]}
              accessibilityRole="header"
              maxFontSizeMultiplier={1.3}>
              Profile
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit profile"
              onPress={openAccount}
              style={({ pressed }) => [
                styles.roundButton,
                { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.6 : 1 },
              ]}>
              <SymbolView name="pencil" tintColor={theme.text} size={20} fallback={null} />
            </Pressable>
          </View>

          {/* 2–3. Passport and level. */}
          {passportState === 'loading' ? <SectionLoading label="Loading your passport" /> : null}
          {passportState === 'error' ? (
            <SectionError
              message={profile.error ?? segments.error ?? ''}
              onRetry={() => void Promise.all([reloadProfile(), reloadSegments()])}
            />
          ) : null}
          {passportState === 'ready' && profile.data !== null && stats !== null ? (
            <>
              <PassportCard
                data={{
                  displayName: profile.data.displayName,
                  level: stats.level,
                  homeBase: stats.homeBase,
                  memberSince: formatMemberSince(profile.data.createdAt, timeZone),
                  flights: stats.flights,
                  airports: stats.airports,
                  countries: stats.countries,
                  miles: stats.miles,
                }}
              />
              <LevelCard level={stats.level} />
            </>
          ) : null}

          {/* 4. Flying with friends. */}
          <View style={styles.section}>
            <FriendsHeading />
            {friendsState === 'loading' ? <SectionLoading label="Loading your group trips" /> : null}
            {friendsState === 'error' ? (
              <SectionError message={friends.error ?? ''} onRetry={() => void reloadFriends()} />
            ) : null}
            {friendStats !== null && friendsState === 'ready' ? (
              friendStats.groupTrips > 0 ? (
                <FriendsCard stats={friendStats} />
              ) : (
                <FriendsEmpty onOpenGroups={() => router.navigate('/groups')} />
              )
            ) : null}
          </View>

          {/* 5. Flight log. */}
          <View style={styles.section}>
            <View style={styles.logHeading}>
              <ThemedText style={styles.sectionTitle} accessibilityRole="header">
                Flight log
              </ThemedText>
              {stats !== null && stats.flights > LOG_PREVIEW ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`See all ${stats.flights} flights`}
                  onPress={() => router.push('/flight-log')}
                  hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                  style={({ pressed }) => [styles.seeAll, { opacity: pressed ? 0.6 : 1 }]}>
                  <Text style={[styles.seeAllText, { color: theme.accent }]}>
                    See all {stats.flights}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {segmentsState === 'loading' ? <SectionLoading label="Loading your flights" /> : null}
            {segmentsState === 'error' ? (
              <SectionError message={segments.error ?? ''} onRetry={() => void reloadSegments()} />
            ) : null}
            {segmentsState === 'ready' && log.length === 0 ? (
              <SectionEmpty>Flights move here after they land.</SectionEmpty>
            ) : null}
            {log.length > 0 ? (
              <FlightLogGroup>
                {log.map((entry, i) => (
                  <FlightLogRow key={entry.key} entry={entry} first={i === 0} />
                ))}
              </FlightLogGroup>
            ) : null}
          </View>

          {/* 6. Account. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Name, email and sign out"
            accessibilityHint="Opens your account"
            onPress={openAccount}
            style={({ pressed }) => [
              styles.accountRow,
              { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.6 : 1 },
            ]}>
            <SymbolView name="person" tintColor={theme.text} size={20} fallback={null} />
            <ThemedText style={styles.accountText}>Name, email and sign out</ThemedText>
            <SymbolView name="chevron.right" tintColor={theme.textSecondary} size={16} fallback={null} />
          </Pressable>
        </View>
      </ScrollView>
      {/* No navigation bar on this tab, so nothing would otherwise stop the
          content scrolling up under the clock. */}
      <View
        pointerEvents="none"
        style={[styles.statusBar, { height: insets.top, backgroundColor: theme.background }]}
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
    paddingBottom: TAB_SCREEN_BOTTOM_INSET,
  },
  statusBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  inner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    gap: Spacing.four,
  },
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  largeTitle: {
    flexShrink: 1,
    fontSize: 34,
    lineHeight: 41,
    fontWeight: '700',
  },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    gap: 10,
  },
  logHeading: {
    minHeight: 25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  sectionTitle: {
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '700',
  },
  seeAll: {
    minHeight: 44,
    justifyContent: 'center',
    marginVertical: -10,
  },
  seeAllText: {
    fontSize: 15,
    fontWeight: '600',
  },
  accountRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
  },
  accountText: {
    flex: 1,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '600',
    paddingVertical: Spacing.three,
  },
});
