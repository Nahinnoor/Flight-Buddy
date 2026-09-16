/**
 * The polling ladder (§7.4), as one pure function.
 *
 * Everything here is arithmetic on **absolute UTC instants**. No `Intl`, no
 * airport zone, no `departure_date_local`, and above all no server-local time
 * (§8.4). That is what makes the DST and date-line cases uninteresting: a US
 * spring-forward inside the window shortens the *wall-clock* gap to departure but
 * not the real one, and a flight whose local date differs from its UTC date is
 * placed by its `scheduled_departure_utc` like every other flight.
 *
 * ## The two ladders
 *
 * | Time to departure | Interval |
 * |---|---|
 * | > 7 days                | weekly |
 * | 7 days – 48 h           | daily |
 * | 48 – 24 h               | every 4 h |
 * | **T-24 h → arrival**    | **webhooks, no polling** — `live` tier, once subscribed |
 * | *failover* 24 – 6 h     | hourly |
 * | *failover* 6 – 1.25 h   | every 15 min |
 * | *failover* T-75 min → wheels up | every 5 min |
 * | *failover* in flight    | every 30 min |
 * | *failover* final 45 min of flight | every 10 min |
 *
 * The failover rows apply **permanently** to `scheduled`-tier flights, and to
 * `live`-tier flights for as long as they are not subscribed.
 *
 * ## The wave-3 seam
 *
 * Wave 3 builds subscriptions. Until it does, a `live`-tier flight inside T-24 h
 * has no webhook to fall back on, so **it keeps polling on the failover ladder** —
 * stopping now would mean a silent 24-hour blind spot on exactly the flights that
 * matter most. `webhooksEnabled` (default `false`) is the switch: with it on, a
 * `live` flight that holds an `alert_subscription_id` returns `null`, which is the
 * "set `next_poll_at = NULL`" of §7.6. Subscribing is still wave 3's job; this
 * function only decides what to do once the id is there.
 *
 * ## Boundaries
 *
 * Every band is "greater than the lower edge, up to and including the upper edge",
 * read from the coarse end down, so a boundary instant always takes the *finer*
 * cadence. `T-24 h` exactly is hourly (and hands over to webhooks); `T-7 days`
 * exactly is daily.
 */
import type { TrackingTier } from '@flightbuddy/shared';

import type { FlightRow } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Ladder intervals, named so the tests read like the table above. */
export const LADDER_INTERVALS = {
  WEEKLY: 7 * DAY,
  DAILY: DAY,
  EVERY_4H: 4 * HOUR,
  HOURLY: HOUR,
  EVERY_15M: 15 * MINUTE,
  EVERY_5M: 5 * MINUTE,
  IN_FLIGHT: 30 * MINUTE,
  FINAL_APPROACH: 10 * MINUTE,
} as const;

/** Band edges, measured as time remaining to the departure anchor. */
export const LADDER_BOUNDARIES = {
  SEVEN_DAYS: 7 * DAY,
  FORTY_EIGHT_HOURS: 48 * HOUR,
  TWENTY_FOUR_HOURS: 24 * HOUR,
  SIX_HOURS: 6 * HOUR,
  /** 1.25 h. Chosen over "30 min before boarding" because boarding time is the least reliable field the API has (§7.4). */
  SEVENTY_FIVE_MINUTES: 75 * MINUTE,
  /** The last stretch of the flight, measured back from the arrival anchor. */
  FINAL_45_MINUTES: 45 * MINUTE,
} as const;

/** Landing is observed, then the flight is stopped and archived 30 min later (§7.6). */
export const ARCHIVE_AFTER_LANDING_MS = 30 * MINUTE;

/** ±10 % (§7.4), so flights added together do not clump into a burst (§8.3). */
export const JITTER_FRACTION = 0.1;

/** The fields the ladder reads. A `FlightRow` satisfies it; tests build it directly. */
export interface LadderFlight {
  tracking_tier: TrackingTier;
  status: FlightRow['status'];
  scheduled_departure_utc: string | null;
  estimated_departure_utc: string | null;
  actual_departure_utc: string | null;
  scheduled_arrival_utc: string | null;
  estimated_arrival_utc: string | null;
  actual_arrival_utc: string | null;
  alert_subscription_id: string | null;
}

export interface LadderOptions {
  /**
   * Wave-3 seam. `false` (the default) keeps every `live`-tier flight on the
   * failover ladder inside T-24 h, because nothing is subscribed yet.
   */
  webhooksEnabled?: boolean;
  /**
   * Backup cadence for a subscribed flight inside the alert window (ADR 0004).
   * `undefined` restores §7.6's literal "no polling at all" behaviour.
   */
  webhookBackupIntervalMs?: number | undefined;
}

function toMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The instant a leg is expected to happen: actual if it happened, otherwise the
 * later of scheduled and estimated.
 *
 * "Estimated if later" and not "estimated whenever present" because an estimate
 * that runs *early* must not pull the cadence forward past the schedule — the
 * aircraft can still leave on time.
 */
function anchor(
  scheduled: string | null,
  estimated: string | null,
  actual: string | null,
): number | null {
  const actualMs = toMs(actual);
  if (actualMs !== null) return actualMs;

  const scheduledMs = toMs(scheduled);
  const estimatedMs = toMs(estimated);
  if (scheduledMs === null) return estimatedMs;
  if (estimatedMs === null) return scheduledMs;
  return Math.max(scheduledMs, estimatedMs);
}

/** The departure instant the ladder is anchored to. */
export function departureAnchor(flight: LadderFlight): number | null {
  return anchor(
    flight.scheduled_departure_utc,
    flight.estimated_departure_utc,
    flight.actual_departure_utc,
  );
}

/** The arrival instant the in-flight bands are anchored to. */
export function arrivalAnchor(flight: LadderFlight): number | null {
  return anchor(
    flight.scheduled_arrival_utc,
    flight.estimated_arrival_utc,
    flight.actual_arrival_utc,
  );
}

/**
 * Apply ±`JITTER_FRACTION` to an interval.
 *
 * `rng()` in `[0, 1)` maps linearly onto `[0.9, 1.1)` of the interval. Exported so
 * the caller can assert the spread without reimplementing it.
 */
export function applyJitter(intervalMs: number, rng: () => number): number {
  const factor = 1 + (rng() * 2 - 1) * JITTER_FRACTION;
  return Math.round(intervalMs * factor);
}

/**
 * The bare interval for a flight at `now`, before jitter. `null` means "do not
 * poll": `manual` tier, or a subscribed `live` flight once wave 3 is on.
 *
 * Exported for the tests, which assert the band a boundary instant lands in
 * without having to undo the jitter.
 */
export function ladderIntervalMs(
  flight: LadderFlight,
  now: Date,
  options: LadderOptions = {},
): number | null {
  // `manual` flights carry user-entered times and no provider data at all (§7.3).
  if (flight.tracking_tier === 'manual') return null;

  const nowMs = now.getTime();
  const departure = departureAnchor(flight);
  const arrival = arrivalAnchor(flight);
  const departed = toMs(flight.actual_departure_utc) !== null;
  const landedAt = toMs(flight.actual_arrival_utc);

  // Landing observed: one last step at landed + 30 min, which is the pass that
  // archives it (§7.6). Deliberately un-jittered — a negative jitter would archive
  // early, and there is no burst to spread out, this being a single terminal poll.
  if (landedAt !== null) {
    return Math.max(landedAt + ARCHIVE_AFTER_LANDING_MS - nowMs, 0);
  }

  const toDeparture = departure === null ? null : departure - nowMs;

  // Pre-window bands. They do not depend on tier or subscription: nothing is
  // subscribed this far out, because a subscription bleeds credits daily on a
  // flight nobody is watching yet (§7.6).
  if (toDeparture !== null) {
    if (toDeparture > LADDER_BOUNDARIES.SEVEN_DAYS) return LADDER_INTERVALS.WEEKLY;
    if (toDeparture > LADDER_BOUNDARIES.FORTY_EIGHT_HOURS) return LADDER_INTERVALS.DAILY;
    if (toDeparture > LADDER_BOUNDARIES.TWENTY_FOUR_HOURS) return LADDER_INTERVALS.EVERY_4H;
  }

  // Inside T-24 h. A subscribed `live` flight is the webhook's job from here to
  // arrival; everything else stays on the failover ladder.
  //
  // §7.6 says `next_poll_at = NULL` here. We keep a slow backup poll instead
  // (ADR 0004): the receiver runs on a Render free web service, which can take
  // about a minute to wake after a restart, and AeroDataBox gives up after 10 s.
  // A delivery lost that way would otherwise never be noticed, because nothing
  // else looks at the flight during the window. Two hours costs ~24 units per
  // flight per day and bounds how long a missed gate change can hide.
  if (
    (options.webhooksEnabled ?? false) &&
    flight.tracking_tier === 'live' &&
    flight.alert_subscription_id !== null
  ) {
    return options.webhookBackupIntervalMs ?? null;
  }

  if (departed) {
    // In flight. The final 45 minutes tighten up because that is when a diversion
    // or a gate assignment at the destination actually appears.
    const toArrival = arrival === null ? null : arrival - nowMs;
    if (toArrival !== null && toArrival <= LADDER_BOUNDARIES.FINAL_45_MINUTES) {
      return LADDER_INTERVALS.FINAL_APPROACH;
    }
    return LADDER_INTERVALS.IN_FLIGHT;
  }

  if (toDeparture === null) {
    // No departure time at all — a `manual`-ish row that is not `manual` tier, or a
    // provider response missing both schedule and estimate. Nothing places it on
    // the ladder, so take the coarsest band that still refreshes it. The archive
    // backstop is what eventually retires it.
    return LADDER_INTERVALS.DAILY;
  }

  if (toDeparture > LADDER_BOUNDARIES.SIX_HOURS) return LADDER_INTERVALS.HOURLY;
  if (toDeparture > LADDER_BOUNDARIES.SEVENTY_FIVE_MINUTES) return LADDER_INTERVALS.EVERY_15M;
  // T-75 min → wheels up. Stays here past the scheduled time: a flight that has not
  // reported wheels-up is precisely the one worth watching every five minutes.
  return LADDER_INTERVALS.EVERY_5M;
}

/**
 * When to poll this flight next, or `null` to stop polling it.
 *
 * @param flight The flight as it is *after* the current poll wrote its fresh values.
 * @param now The current instant. Absolute; never derived from a local clock reading.
 * @param rng Injected uniform `[0, 1)` source for the ±10 % jitter.
 * @param options `webhooksEnabled` is wave 3's switch (see the module note).
 */
export function nextPollAt(
  flight: LadderFlight,
  now: Date,
  rng: () => number = Math.random,
  options: LadderOptions = {},
): Date | null {
  const interval = ladderIntervalMs(flight, now, options);
  if (interval === null) return null;

  // The terminal landed + 30 min step is a deadline, not a cadence: jittering it
  // down would archive before the 30 minutes are up.
  const jittered = toMs(flight.actual_arrival_utc) !== null ? interval : applyJitter(interval, rng);

  return new Date(now.getTime() + jittered);
}
