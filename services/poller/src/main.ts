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
}

/**
 * One pass of the worker loop: claim a batch, poll each flight, log the counts.
 *
 * `webhooksEnabled: false` is wave 3's seam — until subscriptions exist, a
 * `live`-tier flight inside T-24 h stays on the failover ladder rather than
 * falling into a 24-hour blind spot (see `engine/ladder.ts`).
 */
export async function tick(context: WorkerContext): Promise<void> {
  await runPollPass({
    pool: context.pool,
    provider: context.provider,
    writer: context.writer,
    rateLimiter: context.rateLimiter,
    logger: context.logger,
    feedHealthCache: context.feedHealthCache,
    webhooksEnabled: false,
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

  const boss = createBoss(config);
  await startQueue({
    boss,
    logger,
    // Wave 2's one scheduled body (§8.9). `credit-check` is wave 4 and
    // `reconcile-subscriptions` is wave 3; both stay no-ops.
    handlers: { 'archive-backstop': createArchiveBackstopHandler({ pool, logger }) },
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

  logger.info(
    { intervalMs: config.POLL_INTERVAL_MS, batchSize: config.POLL_BATCH_SIZE },
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
