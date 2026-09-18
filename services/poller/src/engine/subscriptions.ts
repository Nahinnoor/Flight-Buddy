/**
 * The alert subscription lifecycle (§7.6, ADR 0003), worker side.
 *
 * | When | What |
 * |---|---|
 * | A `live` flight's poll lands at or after the window opening (`webhookWindowOpensAt`: scheduled arrival − 24 h + 30 min, ADR 0005), webhooks on | subscribe (or join an existing subscription), store the id; the ladder then returns the backup cadence |
 * | Landed + 30 min (the archiving poll) | unsubscribe if no other active row shares it, clear the id, archive |
 * | Hourly | `reconcile.ts` deletes what nothing claims and detaches what the provider lost |
 *
 * ## One subscription per operating number, shared
 *
 * A subscription is keyed by flight number with **no date** (§7.6): it fires for
 * every leg and every day that number operates. Two active rows with the same
 * operating number — the five legs of a multi-leg `AS 65`, or today's and
 * tomorrow's `DL 47` inside overlapping windows — would otherwise each open their
 * own and every delivery would arrive (and be billed) once per row. So a row
 * joins an existing subscription held by another active row with the same
 * operating number, and the webhook drain matches each delivered item to its row
 * by origin and origin-local date.
 *
 * ## Failure is always "stay on the ladder"
 *
 * A failed subscribe leaves `alert_subscription_id` null, so the ladder keeps the
 * flight on the failover cadence and the next poll tries again. A failed
 * unsubscribe never blocks an archive; the hourly reconcile deletes the leftover.
 * Logs carry the flight id, the subscription id and our error class name — never
 * the webhook URL, which contains the receiver's secret token.
 *
 * `flightbuddy_worker` has UPDATE on `flights`; nothing here deletes anything.
 */
import { DEFAULT_MAX_DELIVERY_RETRIES, type FlightDataProvider } from '@flightbuddy/flight-provider';
import type { FlightCandidate } from '@flightbuddy/shared';

import type { Pool } from '../db';
import type { Logger } from '../logger';
import { LADDER_BOUNDARIES, departureAnchor } from './ladder';
import { ENGINE_TYPES, type FlightRow } from './types';

/**
 * Another active row with the same operating number that already holds a
 * subscription. The oldest wins, so every joiner converges on the same id.
 */
export const FIND_SHARED_SUBSCRIPTION_SQL = `select alert_subscription_id
  from public.flights
 where archived_at is null
   and alert_subscription_id is not null
   and operating_carrier_iata = $1
   and operating_flight_number = $2
   and id <> $3
 order by alert_subscribed_at nulls last, id
 limit 1`;

/** Attach a subscription, only if the row has none (never overwrite one). */
export const STORE_SUBSCRIPTION_SQL = `update public.flights
   set alert_subscription_id = $2,
       alert_subscribed_at = $3
 where id = $1
   and alert_subscription_id is null
returning id`;

/** Other active rows sharing a subscription: unsubscribing is only safe at zero. */
export const COUNT_OTHER_HOLDERS_SQL = `select count(*)::int as holders
  from public.flights
 where alert_subscription_id = $1
   and archived_at is null
   and id <> $2`;

/** Detach a subscription from one row, only if it is still the one we think. */
export const CLEAR_SUBSCRIPTION_SQL = `update public.flights
   set alert_subscription_id = null,
       alert_subscribed_at = null
 where id = $1
   and alert_subscription_id = $2`;

/** ADR 0003 decision 2, passed explicitly so the request never relies on a default. */
export const MAX_DELIVERY_RETRIES = DEFAULT_MAX_DELIVERY_RETRIES;

/** What the lifecycle needs. A subset of the poll's dependencies. */
export interface SubscriptionDeps {
  pool: Pool;
  provider: FlightDataProvider;
  rateLimiter: { acquire(): Promise<void> };
  logger: Logger;
}

/** 30 minutes after the previous day's occurrence is scheduled to land (ADR 0005). */
export const WINDOW_OPENS_AFTER_PREVIOUS_LANDING_MS = 30 * 60_000;

function toMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The instant the webhook window opens (ADR 0005): **30 minutes after yesterday's
 * occurrence of this number is scheduled to land**, i.e.
 * `scheduled_arrival_utc − 24 h + 30 min` — equivalently T-24 h plus the
 * scheduled duration plus 30 minutes. JFK–LAX (~6 h) opens ~17.5 h out; a 16 h
 * long-haul ~7.5 h out.
 *
 * Why not T-24 h: a subscription is keyed by number with no date (§7.6), so at
 * T-24 h the previous day's same-numbered flight is departing and every alert it
 * sends — takeoff, en-route updates, landing — is billed to us before our own
 * flight has sent anything. The drain ignores those deliveries (they match no
 * tracked row), but the credits are already spent.
 *
 * - **No scheduled arrival, or one not after the scheduled departure:** T-24 h on
 *   the ladder's departure anchor, as before — subscribe early rather than never.
 * - **Never later than departure** (the anchor): a pathological duration still
 *   subscribes before the plane leaves.
 * - The ladder's T-24 h boundary does not move. Between T-24 h and this instant an
 *   unsubscribed `live` flight is on the failover ladder (hourly more than 6 h
 *   out), which covers the gap by polling.
 *
 * Built on **scheduled** times: yesterday's flight landing late can still bill us
 * its landing alert (and anything after it). That is an accepted approximation —
 * the previous occurrence's real arrival is not something we track.
 */
export function webhookWindowOpensAt(fresh: FlightCandidate): number | null {
  const departure = departureAnchor({
    tracking_tier: fresh.trackingTier,
    status: fresh.status,
    scheduled_departure_utc: fresh.scheduledDepartureUtc,
    estimated_departure_utc: fresh.estimatedDepartureUtc,
    actual_departure_utc: fresh.actualDepartureUtc,
    scheduled_arrival_utc: fresh.scheduledArrivalUtc,
    estimated_arrival_utc: fresh.estimatedArrivalUtc,
    actual_arrival_utc: fresh.actualArrivalUtc,
    alert_subscription_id: null,
  });
  if (departure === null) return null;

  const fallback = departure - LADDER_BOUNDARIES.TWENTY_FOUR_HOURS;
  const scheduledDeparture = toMs(fresh.scheduledDepartureUtc) ?? departure;
  const scheduledArrival = toMs(fresh.scheduledArrivalUtc);
  if (scheduledArrival === null || scheduledArrival <= scheduledDeparture) return fallback;

  const opensAt =
    scheduledArrival - LADDER_BOUNDARIES.TWENTY_FOUR_HOURS + WINDOW_OPENS_AFTER_PREVIOUS_LANDING_MS;
  return Math.min(opensAt, departure);
}

/**
 * Could this flight ever want a subscription? `live` tier only (§7.3: `scheduled`
 * and `manual` never subscribe), and not once it is over — a cancelled or landed
 * flight has nothing left to alert on.
 */
export function isSubscribable(fresh: FlightCandidate): boolean {
  return (
    fresh.trackingTier === 'live' && fresh.status !== 'cancelled' && fresh.actualArrivalUtc === null
  );
}

/**
 * Should this poll open a subscription now? Pure; the caller checks that webhooks
 * are on.
 *
 * @param currentSubscriptionId The row's `alert_subscription_id`.
 */
export function shouldSubscribe(
  fresh: FlightCandidate,
  currentSubscriptionId: string | null,
  now: Date,
): boolean {
  if (currentSubscriptionId !== null) return false;
  if (!isSubscribable(fresh)) return false;
  const opensAt = webhookWindowOpensAt(fresh);
  return opensAt !== null && now.getTime() >= opensAt;
}

/**
 * Pull a pre-window poll forward to the moment the window opens.
 *
 * Before T-24 h the 48–24 h band polls every 4 h, and after it the failover band
 * polls hourly, so without this a flight would be subscribed up to four hours (or
 * one hour) after the window opens. Only applies to a flight that will want a
 * subscription; everything else keeps the ladder's answer.
 */
export function clampToWindowOpening(next: Date, fresh: FlightCandidate, now: Date): Date {
  if (!isSubscribable(fresh)) return next;
  const opensAt = webhookWindowOpensAt(fresh);
  if (opensAt === null || opensAt <= now.getTime()) return next;
  return opensAt < next.getTime() ? new Date(opensAt) : next;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Subscribe a flight (or join the subscription its operating number already has)
 * and store the id on its row.
 *
 * @returns the subscription id now on the row, or `null` if anything failed — in
 *   which case the flight stays on the failover ladder and the next poll retries.
 *   Never throws.
 */
export async function openSubscription(
  deps: SubscriptionDeps & { webhookUrl: string },
  flight: Pick<FlightRow, 'id' | 'operating_carrier_iata' | 'operating_flight_number'>,
  now: Date,
): Promise<string | null> {
  // `char(2)` is blank-padded; the provider and the comparison both want it trimmed.
  const carrier = flight.operating_carrier_iata.trim();
  const number = flight.operating_flight_number.trim();

  try {
    const shared = await deps.pool.query<{ alert_subscription_id: string }>({
      text: FIND_SHARED_SUBSCRIPTION_SQL,
      values: [carrier, number, flight.id],
      types: ENGINE_TYPES,
    });

    let subscriptionId = shared.rows[0]?.alert_subscription_id ?? null;
    const reused = subscriptionId !== null;

    if (subscriptionId === null) {
      // Subscribing is a provider request like any other: it takes a limiter slot.
      await deps.rateLimiter.acquire();
      const created = await deps.provider.subscribeAlerts(`${carrier}${number}`, deps.webhookUrl, {
        maxDeliveryRetries: MAX_DELIVERY_RETRIES,
      });
      subscriptionId = created.subscriptionId;
    }

    const stored = await deps.pool.query<{ id: string }>({
      text: STORE_SUBSCRIPTION_SQL,
      values: [flight.id, subscriptionId, now],
      types: ENGINE_TYPES,
    });

    if (stored.rows.length === 0) {
      // Something attached a subscription to this row first. If we just created
      // one, nothing claims it and the hourly reconcile deletes it.
      deps.logger.warn(
        { flightId: flight.id, subscriptionId, reused },
        'flight already had an alert subscription; ours is left for reconcile',
      );
      return null;
    }

    deps.logger.info(
      { flightId: flight.id, subscriptionId, reused },
      'alert subscription opened (§7.6)',
    );
    return subscriptionId;
  } catch (error) {
    deps.logger.warn(
      { flightId: flight.id, errorName: nameOf(error) },
      'alert subscription failed; flight stays on the failover ladder',
    );
    return null;
  }
}

/**
 * Detach a flight from its subscription at archive time, unsubscribing when it
 * was the last active holder.
 *
 * An unsubscribe failure is logged and swallowed — the archive must proceed, and
 * reconcile deletes a subscription no active row claims. A database failure
 * throws, so the caller's poll records a failure and retries the archive.
 */
export async function closeSubscription(
  deps: SubscriptionDeps,
  flightId: string,
  subscriptionId: string,
): Promise<void> {
  const others = await deps.pool.query<{ holders: number }>({
    text: COUNT_OTHER_HOLDERS_SQL,
    values: [subscriptionId, flightId],
    types: ENGINE_TYPES,
  });
  const holders = others.rows[0]?.holders ?? 0;

  if (holders === 0) {
    try {
      await deps.rateLimiter.acquire();
      await deps.provider.unsubscribeAlerts(subscriptionId);
      deps.logger.info({ flightId, subscriptionId }, 'alert subscription closed (§7.6)');
    } catch (error) {
      deps.logger.warn(
        { flightId, subscriptionId, errorName: nameOf(error) },
        'unsubscribe failed; archiving anyway, reconcile will delete it',
      );
    }
  } else {
    deps.logger.info(
      { flightId, subscriptionId, holders },
      'alert subscription still shared; detaching this flight only',
    );
  }

  await deps.pool.query({
    text: CLEAR_SUBSCRIPTION_SQL,
    values: [flightId, subscriptionId],
    types: ENGINE_TYPES,
  });
}
