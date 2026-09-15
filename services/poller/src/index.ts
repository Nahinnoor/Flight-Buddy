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
  type ScheduledJob,
} from './queue';
