/**
 * The small cards under the pinned flight: one per group, and one per flight
 * in the "later" and "past" lists.
 *
 * None of them is tappable in this pass. The group page (§3.6) is Phase 3, so
 * there is nowhere to go — and a chevron or a pressed state would promise a
 * destination that does not exist. They are plain Views, read by VoiceOver as
 * one element each.
 */
import { StyleSheet, View } from 'react-native';
import { formatAirportLocal, localDateAtAirport } from '@flightbuddy/shared';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { SegmentView } from '@/lib/dashboard-model';
import {
  departureAnchor,
  flightNumbers,
  formatLocalDateShort,
  statusLabel,
} from '@/lib/flight-display';

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
      {children}
    </View>
  );
}

/** A group's name (or destination) and the countdown to your own departure. */
export function GroupCard({
  label,
  detail,
  emphasis = 'accent',
}: {
  label: string;
  detail: string;
  /** `muted` for states that are not a countdown ("Waiting for approval"). */
  emphasis?: 'accent' | 'muted';
}) {
  const theme = useTheme();
  return (
    <Card label={`${label}. ${detail}`}>
      <ThemedText type="default" style={styles.title} numberOfLines={1}>
        {label}
      </ThemedText>
      <ThemedText
        type="smallBold"
        style={{ color: emphasis === 'accent' ? theme.accent : theme.textSecondary }}>
        {detail}
      </ThemedText>
    </Card>
  );
}

function numberOf(segment: SegmentView): string {
  return flightNumbers({
    marketingCarrierIata: segment.marketingCarrierIata,
    marketingFlightNumber: segment.marketingFlightNumber,
    operatingCarrierIata: segment.flight.operating_carrier_iata,
    operatingFlightNumber: segment.flight.operating_flight_number,
  }).primary;
}

/**
 * `ZA 233 · JFK → CDG` over `Sep 26 · 6:05 PM EDT`. Airport-local with a zone
 * label (§8.4), from the same anchor as every countdown.
 */
export function UpcomingFlightRow({ segment }: { segment: SegmentView }) {
  const { flight } = segment;
  const anchor = departureAnchor({
    actualDepartureUtc: flight.actual_departure_utc,
    estimatedDepartureUtc: flight.estimated_departure_utc,
    scheduledDepartureUtc: flight.scheduled_departure_utc,
  });
  const when =
    anchor === null
      ? 'Time unknown'
      : `${formatLocalDateShort(localDateAtAirport(anchor, flight.origin_tz))} · ${formatAirportLocal(
          anchor,
          flight.origin_tz,
        )}`;
  const title = `${numberOf(segment)} · ${flight.origin_iata} → ${flight.destination_iata}`;

  return (
    <Card label={`${title}. Departs ${when}`}>
      <ThemedText type="default" style={styles.title}>
        {title}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {when}
      </ThemedText>
    </Card>
  );
}

/** An archived flight: number, route, local date and how it ended. */
export function PastFlightRow({ segment }: { segment: SegmentView }) {
  const { flight } = segment;
  const title = `${numberOf(segment)} · ${flight.origin_iata} → ${flight.destination_iata}`;
  // An archived row's status is only worth saying when it is an outcome: a
  // `scheduled` row the backstop retired never reported one (§8.9).
  const outcome =
    flight.status === 'landed' || flight.status === 'cancelled' || flight.status === 'diverted'
      ? ` · ${statusLabel(flight.status)}`
      : '';
  const detail = `${formatLocalDateShort(flight.departure_date_local)}${outcome}`;

  return (
    <Card label={`${title}. ${detail}`}>
      <ThemedText type="default" style={styles.title}>
        {title}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {detail}
      </ThemedText>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
    gap: Spacing.half,
  },
  title: {
    fontWeight: '600',
  },
});
