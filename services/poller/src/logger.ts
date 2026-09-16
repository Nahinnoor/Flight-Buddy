/**
 * The worker's logger: pino, JSON on stdout, which is what Render collects.
 *
 * PHASE2_PLAN §5 ("Personal data") says logs carry ids only — no names, emails,
 * push tokens, connection strings or Authorization headers. `REDACT_PATHS` is that
 * rule made mechanical, so a future wave that logs a whole row by accident still
 * cannot leak one.
 *
 * Two things this cannot do, and that no amount of configuration would fix:
 *
 * 1. Redaction matches **object keys**, not text. `logger.info(secret)` as a
 *    message string is printed verbatim. Log `{ flightId }`, never interpolate.
 * 2. It is not a substitute for not logging the thing. Nothing in the worker ever
 *    logs an environment value; `config.ts` reports variable names for that reason.
 */
import { pino, type DestinationStream, type Level, type Logger } from 'pino';

/**
 * Keys whose value is a secret or personal data.
 *
 * pino's wildcard matches exactly one level, so each key is listed at the root and
 * at one and two levels deep — enough for `{ err }`, `{ headers }`, `{ profile }`
 * and `{ job: { data } }` shapes without the cost of a full deep scan.
 */
const SENSITIVE_KEYS = [
  // Credentials and transport secrets
  'authorization',
  'Authorization',
  'password',
  'connectionString',
  'connection_string',
  'DATABASE_URL',
  'RAPIDAPI_KEY',
  'rapidApiKey',
  'x-rapidapi-key',
  'apiKey',
  'api_key',
  'token',
  'secret',
  'webhookToken',
  'WEBHOOK_TOKEN',
  'WEBHOOK_URL',
  'webhookUrl',
  // Webhook payloads (wave 3): provider free text and the whole stored body.
  // Never logged on purpose; redacted in case a future line does it by accident.
  'payload',
  'notificationSummary',
  'notificationRemark',
  // Personal data (§10, PHASE2_PLAN §5)
  'expo_push_token',
  'expoPushToken',
  'email',
  'display_name',
  'displayName',
] as const;

export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
]);

export const REDACT_CENSOR = '[redacted]';

export interface LoggerOptions {
  level: Level | 'silent';
  /** Test seam: a stream to write to instead of stdout. */
  destination?: DestinationStream;
}

/**
 * Build the worker's root logger.
 *
 * `base` is fixed to a service tag: Render interleaves the API's and the worker's
 * logs in one project view, and `pid`/`hostname` say nothing useful about a
 * container that is replaced on every deploy.
 */
export function createLogger({ level, destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service: 'poller' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        // A level name reads better than a number in Render's log search.
        level: (label) => ({ level: label }),
      },
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    },
    destination,
  );
}

export type { Logger };
