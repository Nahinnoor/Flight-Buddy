/**
 * The provider abstraction (§7.1).
 *
 * All provider access goes through this interface. No AeroDataBox response
 * shape may leak into the domain model: everything below is expressed in
 * `@flightbuddy/shared` types or in types declared here.
 *
 * Phase 1 implements `lookupFlight` and `getAirportFeedHealth` fully. The four
 * alert/credit methods are implemented as thin HTTP wrappers so Phase 2 has
 * them ready, but nothing calls them yet — webhook lifecycle (§7.6) and the
 * credit failover (§7.7) are Phase 2 work.
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
 * The provider contract (§7.1, verbatim signatures).
 *
 * `lookupFlight` returns every leg a number operates on that date — a number
 * can operate several (§8.12) — and an empty array when the provider has no
 * such flight. It never throws for "not found"; it throws `ProviderError` and
 * its subclasses for transport and protocol failures.
 */
export interface FlightDataProvider {
  /**
   * @param number Flight designator as the user typed it, e.g. `"DL 1234"`.
   * @param dateLocal Local departure date at the origin, `YYYY-MM-DD` (§6.3).
   */
  lookupFlight(number: string, dateLocal: string): Promise<FlightCandidate[]>;
  getAirportFeedHealth(icao: string): Promise<FeedHealth>;
  subscribeAlerts(flightNumber: string, url: string): Promise<{ subscriptionId: string }>;
  unsubscribeAlerts(subscriptionId: string): Promise<void>;
  getCreditBalance(): Promise<number>;
  refillCredits(credits: number): Promise<number>;
}
