/**
 * The provider abstraction (§7.1).
 *
 * All provider access goes through this interface. No AeroDataBox response
 * shape may leak into the domain model: everything below is expressed in
 * `@flightbuddy/shared` types or in types declared here.
 *
 * Phase 1 implemented `lookupFlight` and `getAirportFeedHealth`. Phase 2 wave 3
 * wires the alert methods into the worker (subscription lifecycle, §7.6);
 * `getCreditBalance` is wave 4's, and `refillCredits` is never called by code
 * (ADR 0003 decision 3: the owner refills by hand).
 */
import type { FlightCandidate } from '@flightbuddy/shared';

/**
 * Health of one of an airport's data feeds.
 *
 * Mirrors AeroDataBox's `FeedServiceStatus` because the values are genuinely
 * the domain's: an airport whose live feed is `Degraded` is still live-tracked,
 * one whose feed is `Down` is not, and the difference decides the tracking tier.
 */
export const FEED_STATUSES = [
  'OK',
  'OKPartial',
  'Degraded',
  'Down',
  'Unavailable',
  'Unknown',
] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];

/** Feed statuses that mean the feed is actually delivering data right now. */
const UP_STATUSES: ReadonlySet<FeedStatus> = new Set<FeedStatus>(['OK', 'OKPartial', 'Degraded']);

/** True when a feed is up, even if degraded or only covering some flights. */
export function isFeedUp(status: FeedStatus): boolean {
  return UP_STATUSES.has(status);
}

/**
 * What the provider knows about one airport's coverage (§7.3).
 *
 * `hasLiveCoverage` is the single question tracking-tier assignment asks: live
 * status updates and webhook alerts only exist where there is a live or ADS-B
 * feed. `schedules` being up on its own is the `scheduled` tier.
 */
export interface FeedHealth {
  /** ICAO code the health was fetched for, uppercased. */
  icao: string;
  /** Static schedules: number, airline, planned times, origin/destination. */
  schedules: FeedStatus;
  /** Live status/time updates: revised times, status, gate, terminal. */
  liveUpdates: FeedStatus;
  /** ADS-B derived updates: call-sign, registration, runway times. */
  adsb: FeedStatus;
  /** True when live updates or ADS-B are up — the condition for the `live` tier. */
  hasLiveCoverage: boolean;
  /** True when any feed at all is up. False means the provider has nothing. */
  hasAnyCoverage: boolean;
  /** Oldest local date with flight data, `YYYY-MM-DD`, when reported. */
  minAvailableLocalDate: string | null;
  /** Newest local date with flight data, `YYYY-MM-DD`, when reported. */
  maxAvailableLocalDate: string | null;
}

/**
 * Retry policy for one alert subscription (ADR 0003 decision 2).
 *
 * AeroDataBox bills 1 credit per flight item per delivery *attempt*, so every
 * retry is paid for. The receiver answers 200 before processing, which means a
 * retry only ever covers our own outage.
 */
export interface SubscribeAlertsOptions {
  /** 0, 1 or 2. Defaults to `DEFAULT_MAX_DELIVERY_RETRIES` (1). */
  maxDeliveryRetries?: number;
}

/** ADR 0003 decision 2. */
export const DEFAULT_MAX_DELIVERY_RETRIES = 1;

/**
 * One alert subscription as the provider reports it.
 *
 * Deliberately carries **no subscriber URL**: the URL registered with the provider
 * contains the receiver's secret token, so it is never parsed out of a response,
 * never returned, and never logged (PHASE2_PLAN §5).
 */
export interface AlertSubscription {
  /** Lower-cased GUID; the value stored in `flights.alert_subscription_id`. */
  subscriptionId: string;
  isActive: boolean;
  /** When the provider created it, UTC ISO-8601, or `null` if unparseable. */
  createdAtUtc: string | null;
  /** The subscribed subject as the provider echoes it, e.g. `"B6 1411"`. Not personal data. */
  flightNumber: string;
}

/**
 * One accepted webhook delivery, in domain types (§7.6).
 *
 * `legs` are the notification items mapped through the same mapper as a lookup.
 * The provider's free-text `notificationSummary` / `notificationRemark` are
 * dropped during parsing and have no field here: they are never logged, stored
 * or shown (webhook-notification-schema.md).
 */
export interface AlertDelivery {
  /** Lower-cased GUID of the subscription that fired. */
  subscriptionId: string;
  /** Balance after this delivery, when the provider included one (§7.6). */
  creditsRemaining: number | null;
  /**
   * Mapped legs. `trackingTier` is the mapper's placeholder (`scheduled`): a
   * delivery carries no feed health, so the caller keeps the stored tier.
   */
  legs: FlightCandidate[];
  /** Items that could not be expressed as a candidate (no IATA code, no zone). */
  unmappedCount: number;
  /**
   * Field paths (e.g. `flights[0].status`) whose integer enum was outside the
   * spec's table and was read as `Unknown`. Paths only — never the value — so a
   * caller can log them as they are.
   */
  unrecognisedEnumFields: string[];
}

/**
 * The provider contract (§7.1).
 *
 * `lookupFlight` returns every leg a number operates on that date — a number
 * can operate several (§8.12) — and an empty array when the provider has no
 * such flight. It never throws for "not found"; it throws `ProviderError` and
 * its subclasses for transport and protocol failures.
 *
 * Phase 2 (ADR 0003) extended the alert surface: `subscribeAlerts` takes the
 * retry policy, and `listSubscriptions` exists because subscriptions never
 * expire, so the hourly reconcile job has to see them all.
 */
export interface FlightDataProvider {
  /**
   * @param number Flight designator as the user typed it, e.g. `"DL 1234"`.
   * @param dateLocal Local departure date at the origin, `YYYY-MM-DD` (§6.3).
   */
  lookupFlight(number: string, dateLocal: string): Promise<FlightCandidate[]>;
  getAirportFeedHealth(icao: string): Promise<FeedHealth>;
  /**
   * Subscribe to alerts for every occurrence of a flight number (§7.6).
   *
   * @param flightNumber The **operating** designator (codeshare resolved, §7.2).
   * @param url The public receiver URL. It carries a secret token: implementations
   *   must never put it in an error, a log line or a return value.
   */
  subscribeAlerts(
    flightNumber: string,
    url: string,
    options?: SubscribeAlertsOptions,
  ): Promise<{ subscriptionId: string }>;
  /** Delete a subscription. Already gone is success, not an error. */
  unsubscribeAlerts(subscriptionId: string): Promise<void>;
  /** Every subscription on the account; `[]` when there are none. */
  listSubscriptions(): Promise<AlertSubscription[]>;
  getCreditBalance(): Promise<number>;
  refillCredits(credits: number): Promise<number>;
}
