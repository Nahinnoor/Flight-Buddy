/**
 * pg-boss, the worker's queue and its scheduler.
 *
 * Two owner decisions shape this file:
 *
 * - **Scheduled jobs run inside the worker** on pg-boss's own cron, not as Render
 *   cron services (PHASE2_PLAN §8.8). One process holds the database and RapidAPI
 *   secrets instead of four, and `render.yaml` has no cron rows.
 * - **The queue lives in schema `pgboss`**, which the `flightbuddy_worker` role
 *   owns (§8.7). That schema is not exposed through Supabase's REST API, so job
 *   payloads are not reachable from a browser (§5, "Keys and privilege").
 *
 * Wave 1 registers the *shape*: the queues exist and the three schedules tick, with
 * handlers that log and return. Waves 3–5 replace the bodies; nothing about the
 * wiring below should need to change when they do.
 */
import { PgBoss, type Job } from 'pg-boss';

import { APPLICATION_NAME, MAX_POOL_CONNECTIONS, connectionSettings } from './db';
import { type Config } from './config';
import { type Logger } from './logger';

/** Owned by `flightbuddy_worker` (migration `20260915021807_worker_role`). */
export const PGBOSS_SCHEMA = 'pgboss';

/**
 * Work queues. Declared here so the queue rows exist from the first boot; the
 * consumers land in later waves.
 */
export const QUEUE_NAMES = {
  /** Wave 3: an accepted AeroDataBox alert body, ingested off the request path (§7.6). */
  WEBHOOK_INGEST: 'webhook-ingest',
  /** Wave 5: a batch of Expo push sends. */
  PUSH_SEND: 'push-send',
  /** Wave 5: Expo receipt reads, which clear dead tokens (§8.10). */
  PUSH_RECEIPTS: 'push-receipts',
} as const;

export const DECLARED_QUEUES: readonly string[] = Object.values(QUEUE_NAMES);

export interface ScheduledJob {
  readonly name: string;
  /** Standard 5-field cron, evaluated in `SCHEDULE_TIMEZONE`. */
  readonly cron: string;
  readonly description: string;
}

/**
 * The three schedules from PHASE2_PLAN §4 and §6 (wave 4 implements their bodies).
 *
 * The plan fixes the cadence — hourly, hourly, daily — and leaves the minute to us.
 * They are spread across the hour on purpose: both hourly jobs call RapidAPI, and
 * the account's rate limit is per-second, so landing them on the same minute buys
 * nothing and risks colliding with a poll pass.
 */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    name: 'credit-check',
    cron: '0 * * * *',
    description: 'GET /subscriptions/balance → provider_credit_log; alert and fail over at zero',
  },
  {
    name: 'reconcile-subscriptions',
    cron: '20 * * * *',
    description: 'delete provider subscriptions that map to no active flight',
  },
  {
    name: 'archive-backstop',
    cron: '40 3 * * *',
    description: 'archive any flight past scheduled arrival + 6 h that never reported landing',
  },
];

/**
 * Cron is evaluated in UTC. Nothing here is user-facing or airport-local, and a
 * server-local schedule would silently shift twice a year (§8.4).
 */
export const SCHEDULE_TIMEZONE = 'UTC';

/** pg-boss hands a batch to every handler, even when the batch is one job. */
export type JobBatch = Job<object>[];

/** What pg-boss calls for a scheduled job. */
export type ScheduledHandler = (jobs: JobBatch) => Promise<void>;

/**
 * The no-op bodies wave 1 ships. Each logs that it ran and returns, which is enough
 * to prove the scheduler fires on the deployed worker before any of it does work.
 *
 * Wave 2 supplies a real `archive-backstop` through `startQueue`'s `handlers`
 * override; `credit-check` (wave 4) and `reconcile-subscriptions` (wave 3) are
 * still the no-ops below.
 *
 * Handlers must stay idempotent when they grow bodies (§5, "Engineering basics"):
 * a `missed: 'once'` catch-up or a redelivery can run the same occurrence twice.
 */
export function createScheduledHandlers(logger: Logger): Record<string, ScheduledHandler> {
  async function handleCreditCheck(jobs: JobBatch): Promise<void> {
    logger.info({ job: 'credit-check', count: jobs.length }, 'scheduled job ran (no-op, wave 4)');
  }

  async function handleReconcileSubscriptions(jobs: JobBatch): Promise<void> {
    logger.info(
      { job: 'reconcile-subscriptions', count: jobs.length },
      'scheduled job ran (no-op, wave 3)',
    );
  }

  async function handleArchiveBackstop(jobs: JobBatch): Promise<void> {
    logger.info(
      { job: 'archive-backstop', count: jobs.length },
      'scheduled job ran (no-op; the real body is injected by main.ts)',
    );
  }

  return {
    'credit-check': handleCreditCheck,
    'reconcile-subscriptions': handleReconcileSubscriptions,
    'archive-backstop': handleArchiveBackstop,
  };
}

/**
 * Build the pg-boss instance. Does not connect — `startQueue` does that.
 *
 * `createSchema: false` is the least-privilege half of §8.7: `pgboss` is created by
 * a migration and owned by the worker role, so the process never needs CREATE on
 * the database. If the schema is missing, `start()` fails loudly, which is the
 * right outcome — a missing schema is a missing migration, not a runtime repair.
 */
export function createBoss(config: Config): PgBoss {
  return new PgBoss({
    // Fields, not a connection string, so the pinned Supabase CA from `db.ts`
    // survives — see the TLS note there for why that matters.
    ...connectionSettings(config),
    schema: PGBOSS_SCHEMA,
    application_name: `${APPLICATION_NAME}-boss`,
    max: MAX_POOL_CONNECTIONS,
    createSchema: false,
  });
}

export interface StartQueueOptions {
  boss: PgBoss;
  logger: Logger;
  /**
   * Real bodies for scheduled jobs, by name, replacing the no-op of the same name.
   *
   * The bodies need a database pool and a provider, which this module deliberately
   * does not know about — `main.ts` owns those. An unknown name is a wiring
   * mistake and throws rather than being silently ignored.
   */
  handlers?: Record<string, ScheduledHandler>;
}

/**
 * Connect, declare the queues, register the scheduled jobs and their workers.
 *
 * Every step is idempotent: `createQueue` and `schedule` upsert, so a redeploy or a
 * second worker re-asserts the same rows rather than duplicating them.
 */
export async function startQueue({
  boss,
  logger,
  handlers: overrides = {},
}: StartQueueOptions): Promise<void> {
  const scheduledNames = new Set(SCHEDULED_JOBS.map((job) => job.name));
  for (const name of Object.keys(overrides)) {
    if (!scheduledNames.has(name)) {
      throw new Error(`handler override for unknown scheduled job ${name}`);
    }
  }

  // pg-boss emits these instead of throwing once it is running; unhandled, an
  // 'error' event on an EventEmitter takes the process down.
  boss.on('error', (error) => logger.error({ err: error }, 'pg-boss error'));
  boss.on('warning', (warning) => logger.warn({ warning }, 'pg-boss warning'));

  await boss.start();

  for (const name of DECLARED_QUEUES) {
    await boss.createQueue(name);
  }
  logger.info({ queues: DECLARED_QUEUES, schema: PGBOSS_SCHEMA }, 'queues declared');

  const handlers = { ...createScheduledHandlers(logger), ...overrides };
  for (const job of SCHEDULED_JOBS) {
    const handler = handlers[job.name];
    if (!handler) throw new Error(`no handler registered for scheduled job ${job.name}`);

    await boss.createQueue(job.name);
    await boss.work(job.name, handler);
    await boss.schedule(job.name, job.cron, null, { tz: SCHEDULE_TIMEZONE });
  }
  logger.info(
    {
      jobs: SCHEDULED_JOBS.map((job) => ({ name: job.name, cron: job.cron })),
      tz: SCHEDULE_TIMEZONE,
    },
    'scheduled jobs registered',
  );
}

/**
 * Stop accepting work, let in-flight handlers finish, and close pg-boss's pool.
 *
 * `stop()` resolves only once all of that is done, so awaiting it is the whole
 * shutdown. The timeout bounds a handler that will not finish — Render's own grace
 * period is finite, and being killed mid-shutdown is worse than giving up on one
 * job, whose lease expires and is retried.
 */
export async function stopQueue(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: true, close: true, timeout: 20_000 });
}

export type { PgBoss };
