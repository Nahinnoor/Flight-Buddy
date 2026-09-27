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
  CREDIT_LOG_SOURCES,
  INSERT_CREDIT_LOG_SQL,
  INT4_MAX,
  INT4_MIN,
  LATEST_CREDIT_BALANCE_SQL,
  buildInsertEventsSql,
  insertCreditLog,
  insertFlightEvents,
  recordFlightEvents,
  type RecordedEvents,
  isLoggableBalance,
  readLatestCreditBalance,
  type CreditLogSource,
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

// --- wave 4: credit monitor and failover (§7.7, ADR 0003) ---------------------

export {
  CREDIT_THRESHOLDS,
  DISARMED_THRESHOLDS_SQL,
  FAILOVER_SUBSCRIBED_FLIGHTS_SQL,
  FAILOVER_SWEEP_CEILING_MS,
  createCreditCheckHandler,
  createCreditState,
  crossedThreshold,
  pollWebhookSettings,
  readDisarmedThresholds,
  runCreditCheck,
  type CreditCheckDeps,
  type CreditCheckResult,
  type CreditState,
  type CreditThreshold,
  type OperatorAlert,
} from './engine/creditMonitor';
export { ENGINE_TYPES, type FlightRow } from './engine/types';

// --- wave 5: push notifications (§9, §8.10) -----------------------------------

export {
  ONCE_PER_FLIGHT_EVENT_TYPES,
  notifyingEventTypes,
  type PolicyState,
} from './engine/notificationPolicy';
export { recipientsCte } from './engine/recipients';
export {
  DELIVERY_ERRORS,
  DELIVERY_STATUSES,
  MAX_DELIVERY_AGE_MS,
  MAX_SEND_ATTEMPTS,
  RECEIPT_DELAY_MS,
  RECEIPT_RETENTION_MS,
  SEND_LEASE_MS,
  retryDelayMs,
  type DeliveryStatus,
} from './push/deliveryStatus';
export {
  EXPO_ERROR_CODES,
  EXPO_PUSH_RECEIPTS_URL,
  EXPO_PUSH_SEND_URL,
  ExpoRequestError,
  MAX_MESSAGES_PER_REQUEST,
  MAX_RECEIPT_IDS_PER_REQUEST,
  createExpoPushClient,
  sanitizeExpoCode,
  type ExpoPushClient,
  type ExpoPushMessage,
  type ExpoReceipt,
  type ExpoTicket,
} from './push/expoClient';
export { buildPushCopy, type MessageFacts, type PushCopy } from './push/messages';
export {
  OPERATOR_ALERT_QUEUE,
  createOperatorAlertHandler,
  createOperatorAlertSink,
  operatorCopy,
  sendOperatorAlert,
  type OperatorAlertSink,
  type OperatorNotice,
} from './push/operatorAlerts';
export {
  CLAIM_DELIVERIES_SQL,
  CLEAR_DEAD_TOKEN_SQL,
  CLOSE_EXHAUSTED_SENDS_SQL,
  FINALIZE_SENDS_SQL,
  LOAD_DELIVERY_FACTS_SQL,
  createPushSendHandler,
  runPushSend,
  type PushSendDeps,
  type PushSendSummary,
} from './push/pushSend';
export {
  FINALIZE_RECEIPTS_SQL,
  SELECT_AWAITING_RECEIPTS_SQL,
  createPushReceiptsHandler,
  runPushReceipts,
  type PushReceiptsDeps,
  type PushReceiptsSummary,
} from './push/pushReceipts';
export { isExpoPushToken, pushTokenSha256 } from './push/tokens';
