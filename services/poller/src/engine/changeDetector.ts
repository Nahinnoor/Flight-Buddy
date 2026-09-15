/**
 * Pure change detection: the row we have against the leg the provider just
 * returned, in, typed `flight_events` out (§9, §8.2).
 *
 * ## The one rule that matters
 *
 * **Compare against the last known value, not against a threshold.** §8.2 names
 * duplicate notifications from a poll/webhook race as a known failure mode, and the
 * `notification_deliveries` unique key is only the *backstop*. The real guard is
 * here: re-polling an unchanged flight must produce nothing at all, so that every
 * event row corresponds to a real transition. That is why a delay is measured as
 * movement past the **previous** departure time rather than lateness against the
 * schedule — otherwise a 40-minute delay would re-fire on every poll for hours.
 *
 * ## Idempotence of the state events
 *
 * `departed`, `landed`, `cancelled` and `diverted` each fire on the *edge* into
 * that state, computed from a predicate over the whole row rather than from one
 * field. A flight that reports `status: 'departed'` on one poll and an
 * `actual_departure_utc` on the next has departed once, not twice.
 *
 * Provider values are **data**: they are read into typed fields, compared, and
 * stored as JSON. Nothing here interpolates them into SQL, a shell, a log line or
 * a prompt (§5, §12.7).
 */
import { delayMinutes, type FlightCandidate, type FlightStatus } from '@flightbuddy/shared';

import type { FlightRow } from './types';

/** The `flight_events.event_type` values §9 notifies on. */
export const FLIGHT_EVENT_TYPES = [
  'cancelled',
  'diverted',
  'delay',
  'gate_change',
  'departed',
  'landed',
] as const;
export type FlightEventType = (typeof FLIGHT_EVENT_TYPES)[number];

/** `flight_events.source`. The poller only ever writes `'poll'`. */
export type FlightEventSource = 'poll' | 'webhook';

/** One detected transition, ready to become a `flight_events` row. */
export interface DetectedEvent {
  type: FlightEventType;
  /** What we believed before this poll. `null` when there was nothing to believe. */
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown>;
  source: FlightEventSource;
}

/** The previous-row fields the detector reads. A `FlightRow` satisfies it. */
export type PreviousFlight = Pick<
  FlightRow,
  | 'status'
  | 'gate'
  | 'terminal'
  | 'scheduled_departure_utc'
  | 'estimated_departure_utc'
  | 'actual_departure_utc'
  | 'scheduled_arrival_utc'
  | 'estimated_arrival_utc'
  | 'actual_arrival_utc'
>;

export interface DetectChangesOptions {
  /** §9 and PHASE2_PLAN §8.5: "delay over 30 minutes". */
  delayThresholdMinutes?: number;
  /** Defaults to `'poll'`; wave 3's webhook processor passes `'webhook'`. */
  source?: FlightEventSource;
}

export const DEFAULT_DELAY_THRESHOLD_MINUTES = 30;

/** Statuses that mean the aircraft is no longer at the origin gate. */
const DEPARTED_STATUSES: ReadonlySet<FlightStatus> = new Set<FlightStatus>([
  'departed',
  'en_route',
  'diverted',
  'landed',
]);

/** Statuses that mean the aircraft is down. */
const ARRIVED_STATUSES: ReadonlySet<FlightStatus> = new Set<FlightStatus>(['landed']);

/** Order events are emitted in, so a batch is deterministic and diffable. */
const EMIT_ORDER: readonly FlightEventType[] = FLIGHT_EVENT_TYPES;

function hasDeparted(status: FlightStatus, actualDeparture: string | null): boolean {
  return actualDeparture !== null || DEPARTED_STATUSES.has(status);
}

function hasArrived(status: FlightStatus, actualArrival: string | null): boolean {
  return actualArrival !== null || ARRIVED_STATUSES.has(status);
}

/**
 * The departure time we currently believe: actual if it happened, else estimated,
 * else scheduled.
 *
 * Unlike the ladder's anchor this takes the estimate even when it runs *early* —
 * the question here is "has the number we would show the user moved", and an
 * estimate pulled forward is exactly such a move (it just is not a delay).
 */
function believedDeparture(
  scheduled: string | null,
  estimated: string | null,
  actual: string | null,
): string | null {
  return actual ?? estimated ?? scheduled;
}

function millis(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Diff a stored flight against a freshly looked-up leg.
 *
 * @param previous The row as claimed, before this poll's ingest.
 * @param fresh The matching leg the provider just returned.
 * @returns Zero or more events, in `FLIGHT_EVENT_TYPES` order. Empty for an
 *   unchanged flight — the property the whole duplicate-notification guard rests on.
 */
export function detectChanges(
  previous: PreviousFlight,
  fresh: FlightCandidate,
  options: DetectChangesOptions = {},
): DetectedEvent[] {
  const source = options.source ?? 'poll';
  const threshold = options.delayThresholdMinutes ?? DEFAULT_DELAY_THRESHOLD_MINUTES;
  const found = new Map<FlightEventType, DetectedEvent>();

  const add = (
    type: FlightEventType,
    previousValue: Record<string, unknown> | null,
    newValue: Record<string, unknown>,
  ): void => {
    found.set(type, { type, previousValue, newValue, source });
  };

  // --- cancellation ---------------------------------------------------------
  if (previous.status !== 'cancelled' && fresh.status === 'cancelled') {
    add('cancelled', { status: previous.status }, { status: fresh.status });
    // A cancelled flight's gate vanishing and its times going stale are not
    // separate news. One event, so one notification.
    return [found.get('cancelled') as DetectedEvent];
  }

  // --- diversion ------------------------------------------------------------
  if (previous.status !== 'diverted' && fresh.status === 'diverted') {
    add(
      'diverted',
      { status: previous.status, destinationIata: null },
      { status: fresh.status, destinationIata: fresh.destinationIata },
    );
  }

  // --- delay ----------------------------------------------------------------
  // Movement past the *last known* departure time, not lateness against the
  // schedule: a flight that is already 40 minutes late and stays there is not news.
  const previousDeparture = believedDeparture(
    previous.scheduled_departure_utc,
    previous.estimated_departure_utc,
    previous.actual_departure_utc,
  );
  const freshDeparture = believedDeparture(
    fresh.scheduledDepartureUtc,
    fresh.estimatedDepartureUtc,
    fresh.actualDepartureUtc,
  );
  const previousMs = millis(previousDeparture);
  const freshMs = millis(freshDeparture);

  if (previousMs !== null && freshMs !== null) {
    const movedMinutes = Math.round((freshMs - previousMs) / 60_000);
    if (movedMinutes > threshold) {
      add(
        'delay',
        {
          departureUtc: previousDeparture,
          delayMinutes: delayMinutes(previous.scheduled_departure_utc, previousDeparture),
        },
        {
          departureUtc: freshDeparture,
          movedByMinutes: movedMinutes,
          // What the UI shows: lateness against the published schedule.
          delayMinutes: delayMinutes(fresh.scheduledDepartureUtc, freshDeparture),
        },
      );
    }
  }

  // --- gate -----------------------------------------------------------------
  // Only a gate we actually have. The provider dropping a gate it previously
  // reported is missing data, not a reassignment, and sending someone to "gate
  // null" is worse than saying nothing.
  if (fresh.gate !== null && fresh.gate !== previous.gate) {
    add(
      'gate_change',
      { gate: previous.gate, terminal: previous.terminal },
      { gate: fresh.gate, terminal: fresh.terminal },
    );
  }

  // --- departure ------------------------------------------------------------
  const wasAirborne = hasDeparted(previous.status, previous.actual_departure_utc);
  const isAirborne = hasDeparted(fresh.status, fresh.actualDepartureUtc);
  if (!wasAirborne && isAirborne) {
    add(
      'departed',
      { status: previous.status, actualDepartureUtc: previous.actual_departure_utc },
      { status: fresh.status, actualDepartureUtc: fresh.actualDepartureUtc },
    );
  }

  // --- arrival --------------------------------------------------------------
  const wasDown = hasArrived(previous.status, previous.actual_arrival_utc);
  const isDown = hasArrived(fresh.status, fresh.actualArrivalUtc);
  if (!wasDown && isDown) {
    add(
      'landed',
      { status: previous.status, actualArrivalUtc: previous.actual_arrival_utc },
      { status: fresh.status, actualArrivalUtc: fresh.actualArrivalUtc },
    );
  }

  return EMIT_ORDER.flatMap((type) => {
    const event = found.get(type);
    return event === undefined ? [] : [event];
  });
}
