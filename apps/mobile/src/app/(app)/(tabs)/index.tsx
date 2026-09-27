/**
 * Dashboard (§3.5).
 *
 * Top to bottom:
 *
 * 1. **The main flight**: the soonest one that has not landed, on the full
 *    flight card with its countdown. A flight in the air stays pinned until it
 *    lands; on a multi-leg trip that is the current leg, then the next.
 * 2. **One compact card per active group**, soonest departure first, each with
 *    a countdown to the user's own first leg in that group — or, when the user
 *    is in no active group, **their most recent archived flights** in that same
 *    space, with a link to the full list on Profile.
 * 3. Any other upcoming legs, compactly, so nothing the user added drops out
 *    of sight.
 *
 * Three queries, loaded side by side, each with its own loading and error
 * state. Every rule about what shows lives in `dashboard-model.ts`.
 *
 * Notifications (Phase 2, wave 5): a flight alert that arrives while the app
 * is open reloads everything here, as does coming back from the background. A
 * tap on a flight alert lands here (`use-notification-taps.ts`); after a
 * reload, if that flight is the pinned card or one of the later rows it is
 * scrolled into view and outlined for a few seconds. Anywhere else — archived,
 * not the user's — the tap just leaves them on this screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  AppState,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { TAB_SCREEN_BOTTOM_INSET } from '@/components/app-tab-bar';
import { GroupCard, PastFlightRow, UpcomingFlightRow } from '@/components/compact-cards';
import { cardDataFromSegment, FlightCard } from '@/components/flight-card';
import {
  Section,
  SectionEmpty,
  SectionError,
  SectionLoading,
  sectionState,
  TextButton,
} from '@/components/section';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useRemote } from '@/hooks/use-remote';
import { useTheme } from '@/hooks/use-theme';
import { buildDashboard, groupCountdownText, isAirborne } from '@/lib/dashboard-model';
import {
  clearFlightHighlight,
  getFlightAlertState,
  subscribeFlightAlerts,
} from '@/lib/flight-alert-store';
import { fetchMySegments, fetchPastSegments } from '@/lib/flights';
import { fetchMyMemberships } from '@/lib/groups';
import { highlightTargetFor, type HighlightTarget } from '@/lib/notification-tap';
import { useSession } from '@/providers/session-provider';

/** How long a notified flight stays outlined. */
const HIGHLIGHT_MS = 3_000;

export default function DashboardScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { userId } = useSession();
  // Group countdowns are minute-grained; the pinned card keeps its own clock.
  const now = useNow(30_000);

  const segments = useRemote(
    useMemo(() => (userId === null ? null : () => fetchMySegments(userId)), [userId]),
    'Could not load your flights.',
  );
  const memberships = useRemote(
    useMemo(() => (userId === null ? null : () => fetchMyMemberships(userId)), [userId]),
    'Could not load your groups.',
  );
  const past = useRemote(
    useMemo(() => (userId === null ? null : () => fetchPastSegments(userId)), [userId]),
    'Could not load your past flights.',
  );

  const [isRefreshing, setIsRefreshing] = useState(false);
  const { reload: reloadSegments } = segments;
  const { reload: reloadMemberships } = memberships;
  const { reload: reloadPast } = past;

  const reloadAll = useCallback(
    () => Promise.all([reloadSegments(), reloadMemberships(), reloadPast()]),
    [reloadSegments, reloadMemberships, reloadPast],
  );

  // Refetch on focus, so closing the add-flight sheet shows the new flight
  // without a manual pull.
  useFocusEffect(
    useCallback(() => {
      void reloadAll();
    }, [reloadAll]),
  );

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await reloadAll();
    setIsRefreshing(false);
  }, [reloadAll]);

  // ---- notifications ----

  const alerts = useSyncExternalStore(subscribeFlightAlerts, getFlightAlertState);

  // A flight alert arrived with the app open: show the change.
  const seenRefresh = useRef(alerts.refreshSeq);
  useEffect(() => {
    if (alerts.refreshSeq === seenRefresh.current) return;
    seenRefresh.current = alerts.refreshSeq;
    void reloadAll();
  }, [alerts.refreshSeq, reloadAll]);

  // Back from the background: alerts delivered while the app was suspended
  // reached no listener, so the cards may be stale.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void reloadAll();
    });
    return () => subscription.remove();
  }, [reloadAll]);

  // A tapped flight alert: reload first, so the decision (and the card) is
  // on fresh data, then outline the flight for a few seconds.
  const [highlighted, setHighlighted] = useState<{ flightId: string; seq: number } | null>(null);
  const highlightRequest = alerts.highlight;
  useEffect(() => {
    if (highlightRequest === null) return;
    let cancelled = false;
    void reloadAll().then(() => {
      if (cancelled) return;
      setHighlighted(highlightRequest);
      clearFlightHighlight(highlightRequest.seq);
    });
    return () => {
      cancelled = true;
    };
  }, [highlightRequest, reloadAll]);

  useEffect(() => {
    if (highlighted === null) return;
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  const model = useMemo(
    () => buildDashboard({ segments: segments.data, memberships: memberships.data, past: past.data }, now),
    [segments.data, memberships.data, past.data, now],
  );

  const segmentsState = sectionState(segments.data, segments.error);

  const target = useMemo<HighlightTarget>(
    () =>
      segmentsState === 'ready'
        ? highlightTargetFor(highlighted?.flightId ?? null, model.main, model.later)
        : null,
    [segmentsState, highlighted, model],
  );
  const highlightSeq = highlighted?.seq ?? null;

  // Scrolling needs the row's position, which only exists after layout; so it
  // is attempted when the target is known and again from each onLayout, once
  // per highlight.
  const scrollRef = useRef<ScrollView>(null);
  const laterSectionY = useRef<number | null>(null);
  const laterRowY = useRef(new Map<string, number>());
  const scrolledFor = useRef<number | null>(null);

  const scrollToTarget = useCallback((to: HighlightTarget, seq: number | null) => {
    if (to === null || seq === null || scrolledFor.current === seq) return;
    let y: number | null = 0;
    if (to.where === 'later') {
      const section = laterSectionY.current;
      const row = laterRowY.current.get(to.segmentId);
      y = section === null || row === undefined ? null : section + row;
    }
    if (y === null) return;
    scrolledFor.current = seq;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - Spacing.three), animated: true });
    AccessibilityInfo.announceForAccessibility('Showing the flight from your notification.');
  }, []);

  useEffect(() => {
    scrollToTarget(target, highlightSeq);
  }, [target, highlightSeq, scrollToTarget]);

  const onLaterSectionLayout = (event: LayoutChangeEvent) => {
    laterSectionY.current = event.nativeEvent.layout.y;
    scrollToTarget(target, highlightSeq);
  };
  const onLaterRowLayout = (segmentId: string) => (event: LayoutChangeEvent) => {
    laterRowY.current.set(segmentId, event.nativeEvent.layout.y);
    if (target?.segmentId === segmentId) scrollToTarget(target, highlightSeq);
  };
  const membershipsState = sectionState(memberships.data, memberships.error);
  const pastState = sectionState(past.data, past.error);

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void onRefresh()}
            tintColor={theme.textSecondary}
          />
        }>
        <View style={styles.inner}>
          {model.isEmpty ? (
            <EmptyDashboard />
          ) : (
            <>
              {/* 1. The main flight. */}
              <Section
                title={model.main !== null && isAirborne(model.main.flight) ? 'In the air' : 'Next flight'}>
                {segmentsState === 'loading' ? <SectionLoading label="Loading your flights" /> : null}
                {segmentsState === 'error' ? (
                  <SectionError
                    message={segments.error ?? ''}
                    onRetry={() => void segments.reload()}
                  />
                ) : null}
                {segmentsState === 'ready' && model.main !== null ? (
                  <HighlightFrame active={target?.where === 'main'}>
                    <FlightCard
                      data={cardDataFromSegment(model.main)}
                      variant="pinned"
                      caption={model.main.tripLabel}
                    />
                  </HighlightFrame>
                ) : null}
                {segmentsState === 'ready' && model.main === null ? (
                  <SectionEmpty>No upcoming flights. Tap + below to add one.</SectionEmpty>
                ) : null}
              </Section>

              {/* 2. Groups, or — with none — past flights. */}
              {membershipsState !== 'ready' ? (
                <Section title="Your groups">
                  {membershipsState === 'loading' ? (
                    <SectionLoading label="Loading your groups" />
                  ) : (
                    <SectionError
                      message={memberships.error ?? ''}
                      onRetry={() => void memberships.reload()}
                    />
                  )}
                </Section>
              ) : null}

              {model.space === 'groups' ? (
                <Section title="Your groups">
                  {model.groups.map((card) => (
                    <GroupCard
                      key={card.membershipId}
                      label={card.label}
                      detail={groupCountdownText(card.countdown, now)}
                      emphasis={card.countdown.kind === 'upcoming' ? 'accent' : 'muted'}
                    />
                  ))}
                </Section>
              ) : null}

              {model.space === 'past' && (pastState !== 'ready' || model.pastPreview.length > 0) ? (
                <Section
                  title="Past flights"
                  action={
                    pastState === 'ready' ? (
                      <TextButton
                        label="See all"
                        accessibilityHint="Opens the full list on your profile"
                        onPress={() => router.navigate('/profile')}
                      />
                    ) : null
                  }>
                  {pastState === 'loading' ? <SectionLoading label="Loading past flights" /> : null}
                  {pastState === 'error' ? (
                    <SectionError message={past.error ?? ''} onRetry={() => void past.reload()} />
                  ) : null}
                  {pastState === 'ready'
                    ? model.pastPreview.map((segment) => (
                        <PastFlightRow key={segment.segmentId} segment={segment} />
                      ))
                    : null}
                </Section>
              ) : null}

              {/* 3. Everything else still ahead. */}
              {model.later.length > 0 ? (
                <View onLayout={onLaterSectionLayout}>
                  <Section title="Later flights">
                    {model.later.map((segment) => (
                      <HighlightFrame
                        key={segment.segmentId}
                        active={target?.where === 'later' && target.segmentId === segment.segmentId}
                        onLayout={onLaterRowLayout(segment.segmentId)}>
                        <UpcomingFlightRow segment={segment} />
                      </HighlightFrame>
                    ))}
                  </Section>
                </View>
              ) : null}
            </>
          )}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

/**
 * An accent outline drawn over a card, for the flight a notification was
 * about. Absolutely positioned, so switching it on moves nothing.
 */
function HighlightFrame({
  active,
  onLayout,
  children,
}: {
  active: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View onLayout={onLayout}>
      {children}
      {active ? <View style={[styles.highlight, { borderColor: theme.accent }]} /> : null}
    </View>
  );
}

/**
 * Nothing at all yet: say what FlightBuddy does and point at the one thing to
 * do next, which is the + in the tab bar directly below this text.
 */
function EmptyDashboard() {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      <SymbolView name="airplane.departure" tintColor={theme.accent} size={44} fallback={null} />
      <ThemedText type="subtitle" style={styles.emptyTitle} accessibilityRole="header">
        No flights yet
      </ThemedText>
      <ThemedText type="default" themeColor="textSecondary" style={styles.emptyBody}>
        Tap + below and enter your flight number and date. FlightBuddy tracks the rest — gate,
        terminal, delays, the lot.
      </ThemedText>
      <SymbolView name="arrow.down" tintColor={theme.textSecondary} size={22} fallback={null} />
    </View>
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
    flexGrow: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.three,
    gap: Spacing.four,
  },
  highlight: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: Spacing.three,
    borderWidth: 2,
    pointerEvents: 'none',
  },
  empty: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: Spacing.three,
    paddingTop: Spacing.five,
  },
  emptyTitle: {
    fontSize: 24,
    lineHeight: 32,
    textAlign: 'center',
  },
  emptyBody: {
    maxWidth: 420,
    textAlign: 'center',
  },
});
