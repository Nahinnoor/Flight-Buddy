/**
 * One flight, one poll (§7.5).
 *
 * ```
 * rate limit → lookup by OPERATING number + departure_date_local
 *            → match the leg on origin_iata
 *            → ingestFlight            (rule 7: the only writer of flight data)
 *            → detectChanges           (§8.2: against the last known value)
 *            → insert flight_events
 *            → (wave 3) subscribe at the window opening (ADR 0005), or unsubscribe at landed + 30 min
 *            → next_poll_at from the ladder, last_polled_at, failures reset
 * ```
 *
 * ## Things this file is careful about
 *
 * **The lookup uses the operating number, not the marketing one.** The row's
 * canonical identity already is the operating flight (§7.2), and querying the
 * marketing number would return schedule data with no live status.
 *
 * **A missing leg is a failure, not a cancellation.** If the provider stops
 * returning the flight — a feed gap, a number retired mid-season, a bad day at
 * RapidAPI — the honest answer is "we do not know", and §8.8 says to back off and
 * surface staleness. Writing `cancelled` would push a notification saying someone's
 * flight is cancelled because a third party had an outage.
 *
 * **Back-off.** Each consecutive failure doubles the flight's own ladder interval,
 * capped at 6 h. From the fifth consecutive failure the flight also waits at least
 * until its next natural ladder step, which parks a far-future flight entirely
 * instead of grinding at the cap.
 *
 * **Logs carry ids.** `flightId`, counters, and our own error class name — never a
 * provider body, never a URL with a key in it, never a user (§5, §10). `ProviderError`
 * carries a truncated response body, which is exactly why the error object itself
 * is never handed to the logger.
 */
import {
  FlightIngestError,
  ingestFlight,
  lookupCandidates,
  type FlightsWriter,
  type FeedHealthCache,
  type FlightDataProvider,
} from '@flightbuddy/flight-provider';
import type { FlightCandidate } from '@flightbuddy/shared';

import type { Pool } from '../db';
import type { Logger } from '../logger';
import { detectChanges, type DetectedEvent, type FlightEventType } from './changeDetector';
import {
  ARCHIVE_AFTER_LANDING_MS,
  LADDER_INTERVALS,
  applyJitter,
  ladderIntervalMs,
  nextPollAt,
  type LadderFlight,
} from './ladder';
import { insertFlightEvents, recordPollFailure, recordPollSuccess } from './repository';
import {
  isSubscribable,
  clampToWindowOpening,
  closeSubscription,
  openSubscription,
  shouldSubscribe,
} from './subscriptions';
import type { FlightRow } from './types';

/** §8.8. At this many consecutive failures the flight stops being retried eagerly. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** No back-off ever exceeds this, however long the failure streak. */
export const MAX_BACKOFF_MS = 6 * 60 * 60_000;

export interface PollDependencies {
  pool: Pool;
  provider: FlightDataProvider;
  /** `createPgFlightsWriter(...)` — the worker has a `pg` pool and no Supabase key. */
  writer: FlightsWriter;
  rateLimiter: { acquire(): Promise<void> };
  logger: Logger;
  /** Injected for tests. Defaults to the wall clock. */
  now?: () => Date;
  /** Injected for tests. Drives the ladder's ±10 % jitter. */
  rng?: () => number;
  /**
   * Webhooks on (`WEBHOOK_URL` set). Passed to the ladder, and with `webhookUrl`
   * it lets a `live` flight subscribe once its window opens (§7.6, ADR 0005).
   */
  webhooksEnabled?: boolean;
  /** The receiver URL including its secret token. Never logged. Absent = never subscribe. */
  webhookUrl?: string;
  /**
   * Backup cadence for a subscribed flight inside the alert window (ADR 0004).
   * Undefined = §7.6's literal "no polling at all".
   */
  webhookBackupIntervalMs?: number | undefined;
  feedHealthCache?: FeedHealthCache;
}

export type PollFailureReason =
  /** The provider call threw: transport, timeout, 429, 5xx, unparseable body. */
  | 'provider_error'
  /** The provider answered, but no leg of that number left our origin airport. */
  | 'leg_missing'
  /** The write itself failed. The provider data is fine; the database is not. */
  | 'write_failed';

export interface PollSuccess {
  kind: 'updated';
  flightId: string;
  events: FlightEventType[];
  eventIds: string[];
  nextPollAt: Date | null;
  archived: boolean;
}

export interface PollFailure {
  kind: 'failed';
  flightId: string;
  reason: PollFailureReason;
  failureCount: number;
  nextPollAt: Date | null;
  /** True once the flight has stopped being retried eagerly (§8.8). */
  backedOff: boolean;
}

export type PollOutcome = PollSuccess | PollFailure;

/** The operating designator the provider is queried with, e.g. `"KL1405"`. */
export function operatingDesignator(
  flight: Pick<FlightRow, 'operating_carrier_iata' | 'operating_flight_number'>,
): string {
  // `char(2)`/`char(3)` columns are blank-padded, so trim before concatenating.
  return `${flight.operating_carrier_iata.trim()}${flight.operating_flight_number.trim()}`;
}

/**
 * The ladder's view of a flight, built from the values the provider just returned.
 * Exported for the webhook drain, which schedules from a delivered leg the same way.
 */
export function ladderViewOf(flight: FlightRow, fresh: FlightCandidate): LadderFlight {
  return {
    tracking_tier: fresh.trackingTier,
    status: fresh.status,
    scheduled_departure_utc: fresh.scheduledDepartureUtc,
    estimated_departure_utc: fresh.estimatedDepartureUtc,
    actual_departure_utc: fresh.actualDepartureUtc,
    scheduled_arrival_utc: fresh.scheduledArrivalUtc,
    estimated_arrival_utc: fresh.estimatedArrivalUtc,
    actual_arrival_utc: fresh.actualArrivalUtc,
    // Subscription state lives on the row, not in a provider response.
    alert_subscription_id: flight.alert_subscription_id,
  };
}

/**
 * When to try again after a failed poll.
 *
 * Doubles the flight's own ladder interval per consecutive failure, capped at 6 h,
 * with the usual ±10 % jitter so a provider outage does not resynchronise every
 * flight onto one instant. From `MAX_CONSECUTIVE_FAILURES` the result is also
 * pushed out to at least the flight's next natural ladder step.
 *
 * Exported because the back-off policy is worth asserting on its own.
 */
export function backoffPollAt(
  flight: FlightRow,
  now: Date,
  failureCount: number,
  rng: () => number,
  options: { webhooksEnabled?: boolean } = {},
): Date {
  // A flight the ladder says not to poll can still be here: its lease was claimed
  // before wave 3 turned webhooks on for it. An hour is the coarsest failover band
  // and a safe floor to double from.
  const base = ladderIntervalMs(flight, now, options) ?? LADDER_INTERVALS.HOURLY;

  const doubled = base * 2 ** Math.max(failureCount, 1);
  const capped = Math.min(doubled, MAX_BACKOFF_MS);
  let at = now.getTime() + applyJitter(capped, rng);

  if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
    // "Stop polling until the next ladder step": whichever is later.
    const step = nextPollAt(flight, now, rng, options);
    if (step !== null) at = Math.max(at, step.getTime());
  }

  return new Date(at);
}

/** Record a failure and return the outcome. Never touches `archived_at` (§8.8). */
async function fail(
  flight: FlightRow,
  deps: PollDependencies,
  now: Date,
  rng: () => number,
  reason: PollFailureReason,
  errorName: string,
): Promise<PollFailure> {
  const failureCount = flight.poll_failure_count + 1;
  const backedOff = failureCount >= MAX_CONSECUTIVE_FAILURES;
  const next = backoffPollAt(flight, now, failureCount, rng, {
    webhooksEnabled: deps.webhooksEnabled ?? false,
  });

  await recordPollFailure(deps.pool, {
    flightId: flight.id,
    nextPollAt: next,
    polledAt: now,
    failureCount,
  });

  // Ids and counters only. `errorName` is one of our own class names, not a message.
  deps.logger.warn(
    { flightId: flight.id, failureCount, reason, errorName, backedOff },
    backedOff ? 'poll failed; flight backed off (§8.8)' : 'poll failed',
  );

  return { kind: 'failed', flightId: flight.id, reason, failureCount, nextPollAt: next, backedOff };
}

/**
 * Poll one claimed flight and write everything that follows from it.
 *
 * The caller has already leased the flight and committed that lease. This function
 * never throws for a provider or write failure — those become a `PollFailure` and a
 * back-off — so one bad flight cannot end a pass. A database that will not accept
 * the failure write itself does throw, because at that point the pass is over anyway.
 */
export async function pollAndUpdate(
  flight: FlightRow,
  deps: PollDependencies,
): Promise<PollOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const rng = deps.rng ?? Math.random;
  const webhooksEnabled = deps.webhooksEnabled ?? false;

  // 1 req/s across the whole worker (§7.8). Taken before the call, not before the
  // claim, so a batch's leases are all committed while the calls trickle out.
  await deps.rateLimiter.acquire();

  let candidates: FlightCandidate[];
  try {
    candidates = await lookupCandidates(
      deps.provider,
      {
        flightNumber: operatingDesignator(flight),
        // The local date at the ORIGIN airport, which is what the provider keys
        // on (§6.3). Kept as the `YYYY-MM-DD` text Postgres stored.
        dateLocal: flight.departure_date_local,
      },
      {
        ...(deps.feedHealthCache === undefined ? {} : { feedHealthCache: deps.feedHealthCache }),
        // A silent degrade here is how every flight stayed `scheduled` and
        // nothing ever subscribed (§7.3). ICAO and error class only.
        onFeedHealthError: (icao, error) => {
          deps.logger.warn(
            { flightId: flight.id, icao, errorName: nameOf(error) },
            'feed health unavailable: flight stays on the scheduled tier',
          );
        },
      },
    );
  } catch (error) {
    return fail(flight, deps, now, rng, 'provider_error', nameOf(error));
  }

  // Match the leg, never `[0]`: one number can operate several legs on one date
  // (§8.12), and only the one leaving our origin is this row.
  const fresh = candidates.find((leg) => leg.originIata === flight.origin_iata);
  if (fresh === undefined) {
    return fail(flight, deps, now, rng, 'leg_missing', 'LegNotReturned');
  }

  let events: DetectedEvent[];
  let eventIds: string[];
  let next: Date | null;
  let archivedAt: Date | null = null;

  try {
    // Rule 7 (§12.7): flight data is written here and nowhere else. The writer is
    // the worker's `pg` implementation; the row it builds is identical to the API's.
    const ingested = await ingestFlight(fresh, deps.writer, { now: () => now });
    if (ingested.flightId !== flight.id) {
      // The canonical key is the same four values we queried with, so this cannot
      // normally happen. Worth a line if it ever does — ids only.
      deps.logger.warn(
        { flightId: flight.id, ingestedFlightId: ingested.flightId },
        'ingest resolved to a different flight row',
      );
    }

    // §8.2: against the last known value, so an unchanged flight yields nothing.
    events = detectChanges(flight, fresh);
    eventIds = await insertFlightEvents(deps.pool, flight.id, events);

    // Landed + 30 min: stop and archive (§7.4, §7.6). Observed landing only — the
    // 6-hour backstop covers a flight that never reports one (§8.9).
    const landedAt = fresh.actualArrivalUtc === null ? null : new Date(fresh.actualArrivalUtc);
    const archiveDue =
      landedAt !== null && now.getTime() >= landedAt.getTime() + ARCHIVE_AFTER_LANDING_MS;

    if (archiveDue) {
      // Unsubscribe first; a provider failure is logged and the archive proceeds —
      // the hourly reconcile deletes anything left behind. Done whether or not
      // webhooks are on now: a subscription opened while they were must not leak.
      if (flight.alert_subscription_id !== null) {
        await closeSubscription(deps, flight.id, flight.alert_subscription_id);
      }
      archivedAt = now;
      next = null;
    } else {
      let subscriptionId = flight.alert_subscription_id;
      const webhookUrl = webhooksEnabled ? deps.webhookUrl : undefined;

      // The mirror of subscribing: a row that still holds a subscription but is
      // no longer subscribable — tier dropped back to `scheduled` because an
      // airport's feed health could not be read, or the flight was cancelled —
      // must let it go. Subscriptions never expire (§7.6) and bill per delivery
      // (§7.7), and the hourly reconcile cannot catch this one: the row still
      // claims the id and the provider still delivers it. Without this the
      // flight would be polled *and* billed for alerts nobody acts on.
      if (subscriptionId !== null && !isSubscribable(fresh)) {
        deps.logger.info(
          { flightId: flight.id, trackingTier: fresh.trackingTier, status: fresh.status },
          'flight is no longer subscribable: closing its alert subscription',
        );
        await closeSubscription(deps, flight.id, subscriptionId);
        subscriptionId = null;
      }

      // Window opening (§7.6, ADR 0005: yesterday's same flight has landed + 30 min):
      // a `live` flight with no subscription gets one. On failure
      // the id stays null, the ladder keeps it on the failover cadence, and the
      // next poll tries again.
      if (webhookUrl !== undefined && shouldSubscribe(fresh, subscriptionId, now)) {
        subscriptionId = await openSubscription({ ...deps, webhookUrl }, flight, now);
      }

      next = nextPollAt(
        { ...ladderViewOf(flight, fresh), alert_subscription_id: subscriptionId },
        now,
        rng,
        {
          webhooksEnabled,
          webhookBackupIntervalMs: deps.webhookBackupIntervalMs,
        },
      );
      if (webhookUrl !== undefined && next !== null && subscriptionId === null) {
        // Land the next poll on the window opening rather than up to a band later.
        next = clampToWindowOpening(next, fresh, now);
      }
    }

    await recordPollSuccess(deps.pool, {
      flightId: flight.id,
      nextPollAt: next,
      polledAt: now,
      archivedAt,
    });
  } catch (error) {
    return fail(flight, deps, now, rng, 'write_failed', nameOf(error));
  }

  deps.logger.info(
    {
      flightId: flight.id,
      events: events.map((event) => event.type),
      archived: archivedAt !== null,
    },
    'flight polled',
  );

  return {
    kind: 'updated',
    flightId: flight.id,
    events: events.map((event) => event.type),
    eventIds,
    nextPollAt: next,
    archived: archivedAt !== null,
  };
}

/**
 * The error's class name, and nothing else.
 *
 * `ProviderError` carries a truncated response body and `FlightIngestError` carries
 * Postgres detail; neither belongs in a log line, so only the name escapes.
 */
function nameOf(error: unknown): string {
  if (error instanceof FlightIngestError) return error.name;
  if (error instanceof Error) return error.name;
  return 'UnknownError';
}
