/**
 * Tracking tiers (§7.3).
 *
 * Alerts and live data only exist where the provider has a live or ADS-B feed,
 * so the tier is decided at add time from the feed health of both ends. It
 * lives on the flight row, which is what keeps one untrackable member from
 * degrading anyone else's tracking.
 */
import type { TrackingTier } from '@flightbuddy/shared';

import type { FeedHealth, FlightDataProvider } from './provider';

/**
 * The tier a flight gets from its two airports.
 *
 * | Result | Condition |
 * |---|---|
 * | `live` | Origin **and** destination have a live or ADS-B feed |
 * | `scheduled` | Anything less, including unknown feed health |
 *
 * Never returns `manual`. That tier means the provider had no flight at all,
 * which this function cannot observe — it is the caller's decision, made when
 * a lookup comes back empty and the user enters times by hand (§6.3).
 *
 * Missing feed health degrades to `scheduled` rather than optimistically
 * assuming coverage: a `live` flight that never receives an alert looks broken,
 * a `scheduled` one that could have been live just polls a little more.
 */
export function assignTrackingTier(
  originFeeds: FeedHealth | null | undefined,
  destinationFeeds: FeedHealth | null | undefined,
): TrackingTier {
  if (originFeeds === null || originFeeds === undefined) return 'scheduled';
  if (destinationFeeds === null || destinationFeeds === undefined) return 'scheduled';
  return originFeeds.hasLiveCoverage && destinationFeeds.hasLiveCoverage ? 'live' : 'scheduled';
}

/** Feed health barely moves; re-asking on every add is wasted quota. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface FeedHealthCacheOptions {
  /** Entry lifetime. Defaults to 24 hours. */
  ttlMs?: number;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * A 24-hour in-memory cache of feed health, keyed by ICAO.
 *
 * Process-local and deliberately so: it is a quota optimisation, not a source
 * of truth, and a worker restart losing it costs one request per airport.
 */
export interface FeedHealthCache {
  /** Cached health for `icao`, fetching through `provider` on a miss. */
  get(icao: string, provider: FlightDataProvider): Promise<FeedHealth>;
  /** Entries currently held, expired ones excluded. Testing and metrics. */
  size(): number;
  clear(): void;
}

interface CacheEntry {
  value: FeedHealth;
  expiresAt: number;
}

export function createFeedHealthCache(options: FeedHealthCacheOptions = {}): FeedHealthCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();
  // Concurrent adds for the same airport share one request rather than racing.
  const inFlight = new Map<string, Promise<FeedHealth>>();

  function live(key: string): FeedHealth | null {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async get(icao: string, provider: FlightDataProvider): Promise<FeedHealth> {
      const key = icao.trim().toUpperCase();
      const cached = live(key);
      if (cached !== null) return cached;

      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;

      const request = provider
        .getAirportFeedHealth(key)
        .then((value) => {
          entries.set(key, { value, expiresAt: now() + ttlMs });
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, request);
      return request;
    },

    size(): number {
      for (const key of [...entries.keys()]) live(key);
      return entries.size;
    },

    clear(): void {
      entries.clear();
      inFlight.clear();
    },
  };
}
