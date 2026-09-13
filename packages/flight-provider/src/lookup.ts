/**
 * Lookup: a typed flight number and a date in, every leg out.
 *
 * This is the entry point behind `POST /v1/flights/lookup` (ADR 0001). It does
 * three things the raw provider call does not: it normalises whatever the user
 * typed, it returns *all* legs (§8.12 — never `[0]`), and it stamps each leg
 * with a tracking tier from the feed health of its two airports (§7.3).
 */
import { parseFlightDesignator, type FlightCandidate } from '@flightbuddy/shared';

import { ProviderDataError } from './errors';
import type { FeedHealth, FlightDataProvider } from './provider';
import { assignTrackingTier, createFeedHealthCache, type FeedHealthCache } from './trackingTier';

export interface LookupRequest {
  /** However the user typed it: `"dl 1234"`, `"DL1234"`, `"B6 1411"`. */
  flightNumber: string;
  /** Local departure date at the origin, `YYYY-MM-DD` (§6.3). */
  dateLocal: string;
}

export interface LookupOptions {
  /**
   * Feed-health cache. Defaults to one shared across the process, so repeated
   * adds through the same hub cost one request per airport per day.
   */
  feedHealthCache?: FeedHealthCache;
}

/** Shared by default so the 24-hour TTL actually spans requests. */
const sharedFeedHealthCache = createFeedHealthCache();

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Look up every leg a flight number operates on a date.
 *
 * Returns an empty array when the provider has no such flight — that is a 404
 * at the API edge and the prompt to add the flight manually in the UI, not an
 * error here.
 *
 * @throws ProviderDataError for an unparseable number or date.
 * @throws ProviderRateLimitError, ProviderError for provider failures.
 */
export async function lookupCandidates(
  provider: FlightDataProvider,
  request: LookupRequest,
  options: LookupOptions = {},
): Promise<FlightCandidate[]> {
  const designator = parseFlightDesignator(request.flightNumber);
  if (designator === null) {
    throw new ProviderDataError(`"${request.flightNumber}" is not a flight number.`);
  }
  if (!LOCAL_DATE.test(request.dateLocal)) {
    throw new ProviderDataError(`"${request.dateLocal}" is not a YYYY-MM-DD date.`);
  }

  const candidates = await provider.lookupFlight(designator.designator, request.dateLocal);
  if (candidates.length === 0) return [];

  const cache = options.feedHealthCache ?? sharedFeedHealthCache;
  const icaos = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.originIcao !== undefined) icaos.add(candidate.originIcao);
    if (candidate.destinationIcao !== undefined) icaos.add(candidate.destinationIcao);
  }

  // Feed health decides the tier, never whether the lookup succeeds: an airport
  // whose health cannot be read degrades that flight to `scheduled` (§7.3)
  // instead of denying the user a flight the provider already returned.
  const health = new Map<string, FeedHealth>();
  await Promise.all(
    [...icaos].map(async (icao) => {
      try {
        health.set(icao, await cache.get(icao, provider));
      } catch {
        /* leave it unknown: assignTrackingTier reads that as `scheduled`. */
      }
    }),
  );

  return candidates.map((candidate) => ({
    ...candidate,
    trackingTier: assignTrackingTier(
      candidate.originIcao === undefined ? null : (health.get(candidate.originIcao) ?? null),
      candidate.destinationIcao === undefined
        ? null
        : (health.get(candidate.destinationIcao) ?? null),
    ),
  }));
}
