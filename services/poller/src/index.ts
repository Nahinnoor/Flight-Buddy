// @flightbuddy/poller — Render background worker (PROJECT_OVERVIEW §4, §7.5).
//
// The process entry point is `src/main.ts` (`npm start -w @flightbuddy/poller`).
// This module is the workspace's importable surface: the pieces later waves and
// tests reach for, without pulling in the module that starts a worker on import.

export {
  ConfigError,
  configSchema,
  loadConfig,
  loadEnvFile,
  parseConfig,
  type Config,
} from './config';
export {
  APPLICATION_NAME,
  MAX_POOL_CONNECTIONS,
  createPool,
  ping,
  poolConfig,
  withClient,
  type Pool,
  type PoolClient,
} from './db';
export { REDACT_CENSOR, REDACT_PATHS, createLogger, type Logger } from './logger';
export {
  DECLARED_QUEUES,
  PGBOSS_SCHEMA,
  QUEUE_NAMES,
  SCHEDULED_JOBS,
  SCHEDULE_TIMEZONE,
  createBoss,
  createScheduledHandlers,
  startQueue,
  stopQueue,
  type JobBatch,
  type PgBoss,
  type ScheduledHandler,
  type ScheduledJob,
} from './queue';

// --- the polling engine (§7.4, §7.5, §8.2, §8.8, §8.9) ----------------------

export {
  ARCHIVE_AFTER_LANDING_MS,
  JITTER_FRACTION,
  LADDER_BOUNDARIES,
  LADDER_INTERVALS,
  applyJitter,
  arrivalAnchor,
  departureAnchor,
  ladderIntervalMs,
  nextPollAt,
  type LadderFlight,
  type LadderOptions,
} from './engine/ladder';
export {
  CLAIM_DUE_FLIGHTS_SQL,
  DEFAULT_LEASE_MS,
  RELEASE_LEASE_SQL,
  claimDueFlights,
  releaseLease,
} from './engine/lease';
export {
  DEFAULT_PROVIDER_RPS,
  createRateLimiter,
  systemClock,
  type Clock,
  type RateLimiter,
  type RateLimiterOptions,
} from './engine/rateLimiter';
export {
  DEFAULT_DELAY_THRESHOLD_MINUTES,
  FLIGHT_EVENT_TYPES,
  detectChanges,
  type DetectChangesOptions,
  type DetectedEvent,
  type FlightEventSource,
  type FlightEventType,
  type PreviousFlight,
} from './engine/changeDetector';
export {
  MAX_BACKOFF_MS,
  MAX_CONSECUTIVE_FAILURES,
  backoffPollAt,
  operatingDesignator,
  pollAndUpdate,
  type PollDependencies,
  type PollFailure,
  type PollFailureReason,
  type PollOutcome,
  type PollSuccess,
} from './engine/poll';
export {
  ARCHIVE_AFTER_ARRIVAL_HOURS,
  ARCHIVE_BACKSTOP_SQL,
  ARRIVAL_FALLBACK_HOURS,
  archiveStaleFlights,
  createArchiveBackstopHandler,
  type ArchiveBackstopResult,
} from './engine/archiveBackstop';
export {
  buildInsertEventsSql,
  insertFlightEvents,
  recordPollFailure,
  recordPollSuccess,
} from './engine/repository';
export { runPollPass, type PollPassOptions, type PollPassSummary } from './engine/tick';
export { ENGINE_TYPES, type FlightRow } from './engine/types';
