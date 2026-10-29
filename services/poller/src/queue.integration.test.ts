/**
 * pg-boss against a real Postgres, as `flightbuddy_worker`.
 *
 * **Only against the throwaway cluster** (`./throwawayDb.ts`): skipped unless
 * `INTEGRATION=1`, and it refuses to start without `INTEGRATION_THROWAWAY=1`, on a
 * host that is not a local socket or loopback, or when `auth.users` is not empty.
 * A queue on a shared database is the deployed worker's queue: it would run the
 * schedules this test registers. Run it with:
 *
 * ```sh
 * npm run test:integration -w @flightbuddy/poller
 * ```
 *
 * pg-boss builds its tables inside the `pgboss` schema the migrations give the
 * worker role, and `createQueue`/`schedule` upsert. It writes nothing to any
 * application table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withClient, type Pool } from './db';
import { createLogger } from './logger';
import {
  DECLARED_QUEUES,
  PGBOSS_SCHEMA,
  SCHEDULED_JOBS,
  SCHEDULE_TIMEZONE,
  createBossOn,
  startQueue,
  stopQueue,
  type PgBoss,
} from './queue';
import {
  connectThrowawayDb,
  integrationRequested as enabled,
  type ThrowawayDb,
} from './throwawayDb';

describe.skipIf(!enabled)('queue against a real database', () => {
  let db: ThrowawayDb | undefined;
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    db = await connectThrowawayDb();
    pool = db.worker;

    boss = createBossOn(db.workerConnection);
    // 'silent': pg-boss's own lines would only bury the assertions.
    await startQueue({ boss, logger: createLogger({ level: 'silent' }) });
  });

  afterAll(async () => {
    if (boss) await stopQueue(boss);
    await db?.end();
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
