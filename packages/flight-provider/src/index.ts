// @flightbuddy/flight-provider — FlightDataProvider interface + AeroDataBox implementation.
// Owned by the data-pipeline agent (PROJECT_OVERVIEW §7).
//
// No AeroDataBox response shape leaks past this package: everything exported
// here is either a `@flightbuddy/shared` type or declared in `provider.ts`.

export { createAeroDataBoxProvider, type AeroDataBoxOptions } from './aerodatabox/client';
export { mapStatus, toFlightCandidate, toUtcIso } from './aerodatabox/mapper';
export { parseAlertDelivery } from './aerodatabox/notification';

export {
  DEFAULT_MAX_DELIVERY_RETRIES,
  FEED_STATUSES,
  isFeedUp,
  type AlertDelivery,
  type AlertSubscription,
  type FeedHealth,
  type FeedStatus,
  type FlightDataProvider,
  type SubscribeAlertsOptions,
} from './provider';

export { lookupCandidates, type LookupOptions, type LookupRequest } from './lookup';
export {
  assignTrackingTier,
  createFeedHealthCache,
  type FeedHealthCache,
  type FeedHealthCacheOptions,
} from './trackingTier';

export {
  FLIGHTS_CONFLICT_COLUMNS,
  FLIGHTS_CONFLICT_TARGET,
  FLIGHT_COALESCE_COLUMNS,
  FLIGHT_UPSERT_COLUMNS,
  FlightIngestError,
  createSupabaseFlightsWriter,
  ingestFlight,
  type FlightUpsertRow,
  type FlightsWriter,
  type IngestOptions,
  type IngestResult,
} from './ingest';
export { FLIGHTS_UPSERT_SQL, createPgFlightsWriter, type QueryFn } from './pgWriter';

export {
  ProviderDataError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './errors';
