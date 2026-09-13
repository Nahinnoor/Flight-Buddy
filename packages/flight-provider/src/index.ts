// @flightbuddy/flight-provider — FlightDataProvider interface + AeroDataBox implementation.
// Owned by the data-pipeline agent (PROJECT_OVERVIEW §7).
//
// No AeroDataBox response shape leaks past this package: everything exported
// here is either a `@flightbuddy/shared` type or declared in `provider.ts`.

export { createAeroDataBoxProvider, type AeroDataBoxOptions } from './aerodatabox/client';
export { mapStatus, toFlightCandidate, toUtcIso } from './aerodatabox/mapper';

export {
  FEED_STATUSES,
  isFeedUp,
  type FeedHealth,
  type FeedStatus,
  type FlightDataProvider,
} from './provider';

export { lookupCandidates, type LookupOptions, type LookupRequest } from './lookup';
export {
  assignTrackingTier,
  createFeedHealthCache,
  type FeedHealthCache,
  type FeedHealthCacheOptions,
} from './trackingTier';

export {
  FLIGHTS_CONFLICT_TARGET,
  FlightIngestError,
  ingestFlight,
  type IngestOptions,
  type IngestResult,
} from './ingest';

export {
  ProviderDataError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './errors';
