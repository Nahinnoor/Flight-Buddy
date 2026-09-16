/**
 * Process entry point for the Render background worker (PROJECT_OVERVIEW §4, §7.5).
 *
 * Boot order is load env → connect → start the queue → loop, and every failure
 * before the loop kills the process with a non-zero exit so Render restarts it
 * rather than keeping a worker alive that cannot do anything.
 *
 * Wave 2 filled `tick()` in: the pass itself lives in `engine/tick.ts` so it can
 * be tested without importing the module that starts a worker on import.
 */
import {
  createAeroDataBoxProvider,
  createFeedHealthCache,
  createPgFlightsWriter,
  type FeedHealthCache,
  type FlightDataProvider,
  type FlightsWriter,
} from '@flightbuddy/flight-provider';

import { ConfigError, loadConfig, type Config } from './config';
import { createPool, ping, type Pool } from './db';
import { createRateLimiter, type RateLimiter } from './engine/rateLimiter';
import { runPollPass } from './engine/tick';
import { createLogger, type Logger } from './logger';
import { createArchiveBackstopHandler } from './engine/archiveBackstop';
import { createReconcileHandler } from './engine/reconcile';
import { createInboxDrainer, type InboxDrainer } from './engine/webhookIngest';
import { createBoss, startQueue, stopQueue, type PgBoss } from './queue';

/** Everything a pass needs. Passed explicitly so `tick` stays testable. */
export interface WorkerContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly provider: FlightDataProvider;
  /** The `pg`-backed `FlightsWriter`; rule 7 still routes every write through `ingestFlight`. */
  readonly writer: FlightsWriter;
  /** Process-wide, so the 1 req/s ceiling holds across passes, not just within one. */
  readonly rateLimiter: RateLimiter;
  readonly feedHealthCache: FeedHealthCache;
  /** Drains `webhook_inbox`; never throws (a missing inbox never stops polling). */
  readonly inboxDrainer: InboxDrainer;
}

/**
 * One pass of the worker loop: drain the webhook inbox, then claim a batch and
 * poll each flight.
 *
 * The drain goes first so a delivered gate change is applied before any poll of
 * the same flight; both write the value they saw, so whichever runs second sees
 * no change (criterion 8). Webhooks are on only when `WEBHOOK_URL` is set; off,
 * nothing subscribes and every flight stays on the polling ladder.
 */
export async function tick(context: WorkerContext): Promise<void> {
  await context.inboxDrainer.drain();

  const webhookUrl = context.config.WEBHOOK_URL;
  await runPollPass({
    pool: context.pool,
    provider: context.provider,
    writer: context.writer,
    rateLimiter: context.rateLimiter,
    logger: context.logger,
    feedHealthCache: context.feedHealthCache,
    webhooksEnabled: webhookUrl !== undefined,
    ...(webhookUrl === undefined ? {} : { webhookUrl }),
    // 0 disables the backup poll and restores §7.6's "no polling at all".
    webhookBackupIntervalMs:
      context.config.WEBHOOK_BACKUP_POLL_MS > 0 ? context.config.WEBHOOK_BACKUP_POLL_MS : undefined,
    batchSize: context.config.POLL_BATCH_SIZE,
  });
}

/** `setTimeout` that resolves early when `signal` aborts, and never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

/**
 * Run `tick` every `POLL_INTERVAL_MS` until `signal` aborts.
 *
 * A thrown pass is logged and the loop continues: a provider outage or one bad row
 * must not end the process, because a restarted worker re-reads the same row and a
 * crash loop turns a degraded pipeline into a stopped one (§8.8).
 */
export async function runLoop(context: WorkerContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await tick(context);
    } catch (error) {
      context.logger.error({ err: error }, 'worker pass failed');
    }
    await sleep(context.config.POLL_INTERVAL_MS, signal);
  }
}

/**
 * Keeps a Render **free** web service awake: it spins down after 15 minutes
 * without inbound traffic and takes about a minute to wake, which is longer than
 * AeroDataBox's 10-second delivery timeout (ADR 0004).
 *
 * Only ever requests `/healthz`, which needs no auth and touches no dependency,
 * so this costs nothing and carries no secret. Failures are warnings: the worker
 * must not exit because the API is briefly down.
 */
export function startKeepAlive(options: {
  url: string;
  intervalMs: number;
  logger: Logger;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): () => void {
  const doFetch = options.fetchImpl ?? fetch;
  const ping = async (): Promise<void> => {
    try {
      const response = await doFetch(options.url, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      options.logger.debug({ status: response.status }, 'keep-alive ping');
    } catch (error: unknown) {
      // The URL is not secret, but keep logs uniform: class name only.
      options.logger.warn(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'keep-alive ping failed',
      );
    }
  };

  void ping();
  const timer = setInterval(() => void ping(), options.intervalMs);
  const stop = (): void => clearInterval(timer);
  options.signal.addEventListener('abort', stop, { once: true });
  return stop;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL });

  // Anything that escapes the loop's own handler still ends the process with a
  // non-zero code, because Render restarts a crashed worker and does not restart a
  // live one that has quietly stopped doing work.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error: unknown) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });

  const pool = createPool(config);
  // A pool that cannot connect should fail here, not on the first claim.
  await ping(pool);
  logger.info('database reachable');

  const provider = createAeroDataBoxProvider({
    apiKey: config.RAPIDAPI_KEY,
    host: config.AERODATABOX_HOST,
  });
  // Rule 7 (§12.7): the worker writes flight data only through `ingestFlight`,
  // which now takes a transport. This is the `pg` one — the worker holds no
  // Supabase key at all (ADR 0003 §6).
  const writer = createPgFlightsWriter((text, values) => pool.query(text, [...values]));
  const rateLimiter = createRateLimiter({ rps: config.PROVIDER_RPS });
  const feedHealthCache = createFeedHealthCache();
  // `WEBHOOK_URL` absent = webhooks off (today's behaviour): nothing subscribes,
  // reconcile is a no-op, every flight stays on the ladder. The inbox is drained
  // either way, so deliveries for subscriptions opened earlier are still applied.
  const webhooksEnabled = config.WEBHOOK_URL !== undefined;

  const inboxDrainer = createInboxDrainer({
    pool,
    provider,
    writer,
    rateLimiter,
    logger,
    feedHealthCache,
    webhooksEnabled,
  });

  const boss = createBoss(config);
  await startQueue({
    boss,
    logger,
    // `credit-check` is wave 4 and stays a no-op.
    handlers: {
      'archive-backstop': createArchiveBackstopHandler({ pool, logger }),
      // Shares the process-wide limiter, so the 1 req/s ceiling holds across the
      // loop and this job.
      'reconcile-subscriptions': createReconcileHandler({
        pool,
        provider,
        rateLimiter,
        logger,
        webhooksEnabled,
      }),
    },
  });

  const context: WorkerContext = {
    config,
    logger,
    pool,
    boss,
    provider,
    writer,
    rateLimiter,
    feedHealthCache,
    inboxDrainer,
  };
  const shutdown = new AbortController();

  // Render sends SIGTERM on every deploy. An interrupted pass costs nothing: the
  // lease simply expires and the flight is re-claimed (§8.7).
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) {
        // A second signal means someone is waiting. Stop arguing and go.
        logger.warn({ signal }, 'second signal, exiting now');
        process.exit(0);
      }
      stopping = true;
      logger.info({ signal }, 'shutting down');
      shutdown.abort();
    });
  }

  if (config.KEEPALIVE_URL !== undefined) {
    startKeepAlive({
      url: config.KEEPALIVE_URL,
      intervalMs: config.KEEPALIVE_INTERVAL_MS,
      logger,
      signal: shutdown.signal,
    });
    logger.info({ intervalMs: config.KEEPALIVE_INTERVAL_MS }, 'keep-alive ping started');
  }

  logger.info(
    // A boolean, never the URL: it carries the receiver's secret token.
    {
      intervalMs: config.POLL_INTERVAL_MS,
      batchSize: config.POLL_BATCH_SIZE,
      webhooksEnabled,
      webhookBackupPollMs: config.WEBHOOK_BACKUP_POLL_MS,
    },
    'poller started',
  );
  await runLoop(context, shutdown.signal);

  await stopQueue(boss);
  await pool.end();
  logger.info('shutdown complete');
  process.exit(0);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // No logger yet, and nothing secret in the message: it names variables.
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
