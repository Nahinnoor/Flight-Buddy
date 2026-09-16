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
  ladderViewOf,
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

// --- wave 3: webhooks and subscriptions (§7.6, ADR 0003) ----------------------

export {
  CLEAR_SUBSCRIPTION_SQL,
  COUNT_OTHER_HOLDERS_SQL,
  FIND_SHARED_SUBSCRIPTION_SQL,
  MAX_DELIVERY_RETRIES,
  STORE_SUBSCRIPTION_SQL,
  clampToWindowOpening,
  closeSubscription,
  isSubscribable,
  openSubscription,
  shouldSubscribe,
  webhookWindowOpensAt,
  type SubscriptionDeps,
} from './engine/subscriptions';
export {
  CLAIM_INBOX_ROW_SQL,
  CREDIT_LOG_SOURCE,
  DEFAULT_INBOX_BATCH_SIZE,
  FIND_SUBSCRIBED_FLIGHTS_SQL,
  INBOX_MAX_ATTEMPTS,
  INBOX_REASONS,
  INSERT_CREDIT_LOG_SQL,
  LEASE_FLIGHT_FOR_WEBHOOK_SQL,
  MARK_INBOX_DONE_SQL,
  MARK_INBOX_FAILED_SQL,
  VERIFIED_EVENT_TYPES,
  VerificationLegMissingError,
  WEBHOOK_APPLIED_SQL,
  claimInboxRow,
  createInboxDrainer,
  drainWebhookInbox,
  matchLegs,
  type DrainSummary,
  type InboxDrainer,
  type InboxOutcome,
  type InboxOutcomeKind,
  type InboxRow,
  type WebhookIngestDeps,
} from './engine/webhookIngest';
export {
  ACTIVE_SUBSCRIPTIONS_SQL,
  DETACH_SUBSCRIPTION_SQL,
  RECONCILE_GRACE_MS,
  createReconcileHandler,
  reconcileSubscriptions,
  type ReconcileDeps,
  type ReconcileResult,
} from './engine/reconcile';
export { ENGINE_TYPES, type FlightRow } from './engine/types';
