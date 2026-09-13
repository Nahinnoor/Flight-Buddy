/**
 * The flight card. One component for every place a flight is shown: pinned at
 * the top of the dashboard, listed below it, and as the confirmation card in
 * the add-flight flow.
 *
 * It takes a normalised `FlightCardData` rather than a row or a candidate,
 * because the add-flight screen has a `FlightCandidate` (camelCase, from the
 * provider) and the dashboard has a `flights` row plus its `trip_segments`
 * marketing number (snake_case, from Postgres). Two adapters, one renderer —
 * the alternative is two cards that drift.
 *
 * What it is required to show, and why:
 *
 * - The **user's own** flight number first, the operating carrier second and
 *   only when they differ (§7.2). Swapping them silently is the single fastest
 *   way to make someone believe you looked up the wrong flight.
 * - Times airport-local **with a zone label**, via `formatAirportLocal` (§8.4).
 *   Never the device's zone: 3:45 PM at JFK means nothing rendered in CEST.
 * - **Not live-tracked** whenever the tier is not `live` (§7.3), so nobody
 *   waits on a gate-change push that is never coming.
 * - A staleness hint when the data has stopped refreshing inside the 24-hour
 *   window (§8.8) — old data presented as current is worse than no data.
 */
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  delayMinutes,
  durationMinutes,
  formatAirportLocal,
  type FlightCandidate,
  type FlightStatus,
  type TrackingTier,
} from '@flightbuddy/shared';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useCountdown } from '@/hooks/use-countdown';
import { useTheme } from '@/hooks/use-theme';
import {
  DELAY_HIGHLIGHT_MINUTES,
  flightNumbers,
  formatDelay,
  formatDuration,
  isLiveTracked,
  stalenessHint,
  statusLabel,
  statusTone,
  type StatusTone,
} from '@/lib/flight-display';
import type { SegmentView } from '@/lib/flights';

export interface FlightCardData {
  marketingCarrierIata: string | null;
  marketingFlightNumber: string | null;
  operatingCarrierIata: string;
  operatingFlightNumber: string;

  originIata: string;
  destinationIata: string;
  originTz: string;
  destinationTz: string;

  status: FlightStatus;
  trackingTier: TrackingTier;
  gate: string | null;
  terminal: string | null;

  scheduledDepartureUtc: string | null;
  estimatedDepartureUtc: string | null;
  actualDepartureUtc: string | null;
  scheduledArrivalUtc: string | null;
  estimatedArrivalUtc: string | null;
  actualArrivalUtc: string | null;

  /** `flights.updated_at`. `null` for a candidate that is not yet a row. */
  updatedAt: string | null;
}

/** A row the user is subscribed to, plus the number they typed for it. */
export function cardDataFromSegment(segment: SegmentView): FlightCardData {
  const { flight } = segment;
  return {
    marketingCarrierIata: segment.marketingCarrierIata,
    marketingFlightNumber: segment.marketingFlightNumber,
    operatingCarrierIata: flight.operating_carrier_iata,
    operatingFlightNumber: flight.operating_flight_number,
    originIata: flight.origin_iata,
    destinationIata: flight.destination_iata,
    originTz: flight.origin_tz,
    destinationTz: flight.destination_tz,
    status: flight.status,
    trackingTier: flight.tracking_tier,
    gate: flight.gate,
    terminal: flight.terminal,
    scheduledDepartureUtc: flight.scheduled_departure_utc,
    estimatedDepartureUtc: flight.estimated_departure_utc,
    actualDepartureUtc: flight.actual_departure_utc,
    scheduledArrivalUtc: flight.scheduled_arrival_utc,
    estimatedArrivalUtc: flight.estimated_arrival_utc,
    actualArrivalUtc: flight.actual_arrival_utc,
    updatedAt: flight.updated_at,
  };
}

/** A lookup result, before it has been added. */
export function cardDataFromCandidate(candidate: FlightCandidate): FlightCardData {
  return {
    marketingCarrierIata: candidate.marketingCarrierIata,
    marketingFlightNumber: candidate.marketingFlightNumber,
    operatingCarrierIata: candidate.operatingCarrierIata,
    operatingFlightNumber: candidate.operatingFlightNumber,
    originIata: candidate.originIata,
    destinationIata: candidate.destinationIata,
    originTz: candidate.originTz,
    destinationTz: candidate.destinationTz,
    status: candidate.status,
    trackingTier: candidate.trackingTier,
    gate: candidate.gate,
    terminal: candidate.terminal,
    scheduledDepartureUtc: candidate.scheduledDepartureUtc,
    estimatedDepartureUtc: candidate.estimatedDepartureUtc,
    actualDepartureUtc: candidate.actualDepartureUtc,
    scheduledArrivalUtc: candidate.scheduledArrivalUtc,
    estimatedArrivalUtc: candidate.estimatedArrivalUtc,
    actualArrivalUtc: candidate.actualArrivalUtc,
    updatedAt: null,
  };
}

function Pill({ label, tone }: { label: string; tone: StatusTone }) {
  const theme = useTheme();
  const surface = {
    neutral: theme.neutralSurface,
    positive: theme.positiveSurface,
    warning: theme.warningSurface,
    critical: theme.criticalSurface,
  }[tone];
  const color = {
    neutral: theme.neutralText,
    positive: theme.positiveText,
    warning: theme.warningText,
    critical: theme.criticalText,
  }[tone];

  return (
    <View style={[styles.pill, { backgroundColor: surface }]}>
      <ThemedText type="smallBold" style={[styles.pillText, { color }]}>
        {label}
      </ThemedText>
    </View>
  );
}

/**
 * One end of the journey. When an estimate differs from the schedule, both are
 * shown with the scheduled one struck through — a single "6:40 PM" gives the
 * user no way to tell a moved flight from one that was always at 6:40.
 */
function TimeRow({
  label,
  airportIata,
  scheduledUtc,
  estimatedUtc,
  actualUtc,
  tz,
}: {
  label: string;
  airportIata: string;
  scheduledUtc: string | null;
  estimatedUtc: string | null;
  actualUtc: string | null;
  tz: string;
}) {
  const theme = useTheme();

  if (scheduledUtc === null && estimatedUtc === null && actualUtc === null) {
    return (
      <View style={styles.timeRow}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.timeLabel}>
          {label} {airportIata}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Time unknown
        </ThemedText>
      </View>
    );
  }

  const current = actualUtc ?? estimatedUtc ?? scheduledUtc;
  const shifted =
    scheduledUtc !== null &&
    current !== null &&
    new Date(current).getTime() !== new Date(scheduledUtc).getTime();

  return (
    <View style={styles.timeRow}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.timeLabel}>
        {label} {airportIata}
      </ThemedText>
      <View style={styles.timeValues}>
        {shifted && scheduledUtc !== null ? (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={[styles.struck, { textDecorationColor: theme.textSecondary }]}
          >
            {formatAirportLocal(scheduledUtc, tz)}
          </ThemedText>
        ) : null}
        {current !== null ? (
          <ThemedText type="smallBold">{formatAirportLocal(current, tz)}</ThemedText>
        ) : null}
      </View>
    </View>
  );
}

export interface FlightCardProps {
  data: FlightCardData;
  /** `pinned` is the user's next flight: bigger type, countdown shown. */
  variant?: 'pinned' | 'listed';
  /** Extra line under the header, e.g. a trip label or leg number. */
  caption?: string | null;
}

function FlightCardComponent({ data, variant = 'listed', caption = null }: FlightCardProps) {
  const theme = useTheme();
  const isPinned = variant === 'pinned';

  const { primary, operatedBy } = flightNumbers(data);
  const departure =
    data.actualDepartureUtc ?? data.estimatedDepartureUtc ?? data.scheduledDepartureUtc;
  const arrival = data.actualArrivalUtc ?? data.estimatedArrivalUtc ?? data.scheduledArrivalUtc;

  const countdown = useCountdown(isPinned ? departure : null);
  const delay = delayMinutes(
    data.scheduledDepartureUtc,
    data.actualDepartureUtc ?? data.estimatedDepartureUtc,
  );
  const duration =
    departure !== null && arrival !== null
      ? formatDuration(durationMinutes(departure, arrival))
      : null;
  const stale = stalenessHint(data.updatedAt, data.scheduledDepartureUtc);

  const delayText = formatDelay(delay);
  const delayIsBig = delay !== null && delay > DELAY_HIGHLIGHT_MINUTES;

  const facts = [
    data.gate !== null ? `Gate ${data.gate}` : null,
    data.terminal !== null ? `Terminal ${data.terminal}` : null,
    duration,
  ].filter((fact): fact is string => fact !== null);

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        isPinned && styles.cardPinned,
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <ThemedText type={isPinned ? 'subtitle' : 'default'} style={styles.number}>
            {primary}
          </ThemedText>
          {operatedBy !== null ? (
            <ThemedText type="small" themeColor="textSecondary">
              {operatedBy}
            </ThemedText>
          ) : null}
        </View>
        <Pill label={statusLabel(data.status)} tone={statusTone(data.status)} />
      </View>

      {caption !== null ? (
        <ThemedText type="small" themeColor="textSecondary">
          {caption}
        </ThemedText>
      ) : null}

      <ThemedText type={isPinned ? 'subtitle' : 'default'} style={styles.route}>
        {data.originIata} → {data.destinationIata}
      </ThemedText>

      {isPinned && countdown !== null ? (
        <ThemedText type="default" style={[styles.countdown, { color: theme.accent }]}>
          {countdown.isPast ? `Departed ${countdown.label}` : `Departs ${countdown.label}`}
        </ThemedText>
      ) : null}

      <View style={styles.times}>
        <TimeRow
          label="Departs"
          airportIata={data.originIata}
          scheduledUtc={data.scheduledDepartureUtc}
          estimatedUtc={data.estimatedDepartureUtc}
          actualUtc={data.actualDepartureUtc}
          tz={data.originTz}
        />
        <TimeRow
          label="Arrives"
          airportIata={data.destinationIata}
          scheduledUtc={data.scheduledArrivalUtc}
          estimatedUtc={data.estimatedArrivalUtc}
          actualUtc={data.actualArrivalUtc}
          tz={data.destinationTz}
        />
      </View>

      {facts.length > 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          {facts.join(' · ')}
        </ThemedText>
      ) : null}

      {delayText !== null && delay !== 0 ? (
        <ThemedText
          type={delayIsBig ? 'smallBold' : 'small'}
          style={{ color: delayIsBig ? theme.criticalText : theme.textSecondary }}
        >
          {delayText}
        </ThemedText>
      ) : null}

      {!isLiveTracked(data.trackingTier) || stale !== null ? (
        <View style={styles.badges}>
          {!isLiveTracked(data.trackingTier) ? (
            <Pill label="Not live-tracked" tone="neutral" />
          ) : null}
          {stale !== null ? <Pill label={stale} tone="warning" /> : null}
        </View>
      ) : null}
    </View>
  );
}

export const FlightCard = memo(FlightCardComponent);

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  cardPinned: {
    padding: Spacing.four,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  headerText: {
    flex: 1,
    gap: Spacing.half,
  },
  number: {
    letterSpacing: 0.5,
  },
  route: {
    fontWeight: '600',
  },
  countdown: {
    fontWeight: '700',
  },
  times: {
    gap: Spacing.one,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  timeLabel: {
    flexShrink: 0,
  },
  timeValues: {
    flexShrink: 1,
    alignItems: 'flex-end',
  },
  struck: {
    textDecorationLine: 'line-through',
  },
  pill: {
    borderRadius: 999,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  pillText: {
    fontSize: 12,
    lineHeight: 16,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
});
