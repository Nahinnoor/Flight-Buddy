/**
 * Process entry point for the Render background worker (PROJECT_OVERVIEW §4, §7.5).
 *
 * Boot order is load env → connect → start the queue → loop, and every failure
 * before the loop kills the process with a non-zero exit so Render restarts it
 * rather than keeping a worker alive that cannot do anything.
 *
 * Wave 1 is the skeleton: `tick()` is a named seam and does nothing yet. Wave 2
 * puts `claimDueFlights(POLL_BATCH_SIZE)` and `pollAndUpdate` behind it, with the
 * lease taken and committed *before* the HTTP call (§7.5, §8.7).
 */
import { ConfigError, loadConfig, type Config } from './config';
import { createPool, ping, type Pool } from './db';
import { createLogger, type Logger } from './logger';
import { createBoss, startQueue, stopQueue, type PgBoss } from './queue';

/** Everything a pass needs. Passed explicitly so `tick` stays testable. */
export interface WorkerContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly pool: Pool;
  readonly boss: PgBoss;
}

/**
 * One pass of the worker loop.
 *
 * Wave 2 replaces the body with:
 *
 * ```ts
 * const due = await claimDueFlights(pool, config.POLL_BATCH_SIZE); // lease, commit
 * for (const flight of due) {
 *   await rateLimiter.acquire();   // 1 req/s
 *   await pollAndUpdate(flight);
 * }
 * ```
 *
 * Until then it exists so the loop, the error handling around it and the shutdown
 * path are the ones that ship, not ones written later under time pressure.
 */
export async function tick(context: WorkerContext): Promise<void> {
  const { logger, config } = context;
  logger.info(
    { batchSize: config.POLL_BATCH_SIZE, intervalMs: config.POLL_INTERVAL_MS },
    'heartbeat: no poller engine yet (wave 2)',
  );
  await Promise.resolve();
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

  const boss = createBoss(config);
  await startQueue({ boss, logger });

  const context: WorkerContext = { config, logger, pool, boss };
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
