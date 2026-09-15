/**
 * The one test in this workspace that touches a real database.
 *
 * Skipped unless `INTEGRATION=1` **and** a `DATABASE_URL` is available, so `npm
 * test` stays offline and deterministic everywhere else (§12.2: tests run against
 * fixtures, never the network, unless you asked for it).
 *
 * ```sh
 * INTEGRATION=1 npm test -w @flightbuddy/poller
 * ```
 *
 * Side effects are intended and idempotent: pg-boss creates its tables inside the
 * `pgboss` schema the worker role owns, and `createQueue`/`schedule` upsert. It
 * writes nothing to any application table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvFile, parseConfig, type Config } from './config';
import { createPool, ping, withClient, type Pool } from './db';
import { createLogger } from './logger';
import {
  DECLARED_QUEUES,
  PGBOSS_SCHEMA,
  SCHEDULED_JOBS,
  SCHEDULE_TIMEZONE,
  createBoss,
  startQueue,
  stopQueue,
  type PgBoss,
} from './queue';

loadEnvFile();

const enabled = process.env.INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)('queue against a real database', () => {
  let config: Config;
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    config = parseConfig();
    pool = createPool(config);
    await ping(pool);

    boss = createBoss(config);
    // 'silent' so a CI log never carries anything from a live database.
    await startQueue({ boss, logger: createLogger({ level: 'silent' }) });
  });

  afterAll(async () => {
    if (boss) await stopQueue(boss);
    if (pool) await pool.end();
  });

  it('reaches the database as the restricted worker role', async () => {
    const role = await withClient(pool, async (client) => {
      const result = await client.query<{ current_user: string }>('select current_user');
      return result.rows[0]?.current_user;
    });

    expect(role).toBe('flightbuddy_worker');
  });

  it('installs pg-boss in the pgboss schema and nowhere else', async () => {
    const schemas = await withClient(pool, async (client) => {
      const result = await client.query<{ table_schema: string }>(
        `select distinct table_schema
           from information_schema.tables
          where table_name = 'job'`,
      );
      return result.rows.map((row) => row.table_schema);
    });

    expect(schemas).toContain(PGBOSS_SCHEMA);
    expect(schemas).not.toContain('public');
  });

  it('declares every work queue', async () => {
    const names = (await boss.getQueues()).map((queue) => queue.name);

    for (const queue of DECLARED_QUEUES) {
      expect(names).toContain(queue);
    }
  });

  it('registers the three scheduled jobs with their cron expressions', async () => {
    const schedules = await boss.getSchedules();
    const byName = new Map(schedules.map((schedule) => [schedule.name, schedule]));

    for (const job of SCHEDULED_JOBS) {
      const schedule = byName.get(job.name);
      expect(schedule, `${job.name} is not scheduled`).toBeDefined();
      expect(schedule?.cron).toBe(job.cron);
      expect(schedule?.timezone).toBe(SCHEDULE_TIMEZONE);
    }
  });

  it('previews the next occurrence of each schedule, so the expressions are runnable', () => {
    for (const job of SCHEDULED_JOBS) {
      const [next] = boss.previewSchedule(job.cron, { tz: SCHEDULE_TIMEZONE });
      expect(next, `${job.cron} yields no next occurrence`).toBeInstanceOf(Date);
    }
  });
});
