/**
 * The inbox claim against a real Postgres: two concurrent claimers never get the
 * same row (`for update skip locked`).
 *
 * Skipped unless `INTEGRATION=1` **and** `DATABASE_URL` is set, and skipped at
 * run time when `public.webhook_inbox` does not exist yet (the API's migration).
 *
 * ```sh
 * INTEGRATION=1 npm test -w @flightbuddy/poller
 * ```
 *
 * ## Seeding
 *
 * `flightbuddy_worker` has no INSERT on `webhook_inbox` — only the receiver writes
 * it. So rows are seeded through `INTEGRATION_SEED_DATABASE_URL` (any role that may
 * insert, e.g. a local superuser), or through `DATABASE_URL` itself if that role
 * happens to have INSERT; otherwise the test skips and says why.
 *
 * ## What it touches
 *
 * Four synthetic rows with random subscription ids and a `{ "synthetic": true }`
 * payload, received ten years ago so they sort ahead of anything real. Every claim
 * runs in a transaction that is **rolled back**, so the claim itself changes
 * nothing. Cleanup marks the rows processed (the worker cannot delete). A
 * deployed worker draining the same database could pick them up meanwhile — it
 * would mark them processed as invalid, which is harmless.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvFile, parseConfig } from '../config';
import { createPool, type Pool, type PoolClient } from '../db';
import { ENGINE_TYPES } from './types';
import { claimInboxRow } from './webhookIngest';

loadEnvFile();

const enabled = process.env.INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const ROWS = 4;

describe.skipIf(!enabled)('webhook inbox claim against a real database', () => {
  let poolA: Pool;
  let poolB: Pool;
  let seedPool: Pool | null = null;
  let ids: string[] = [];
  let skipReason: string | null = null;

  beforeAll(async () => {
    const config = parseConfig();
    poolA = createPool(config);
    poolB = createPool(config);

    const table = await poolA.query<{ exists: boolean }>(
      `select to_regclass('public.webhook_inbox') is not null as exists`,
    );
    if (!table.rows[0]?.exists) {
      skipReason = 'public.webhook_inbox does not exist yet (the API migration is not applied)';
      return;
    }

    const seedUrl = process.env.INTEGRATION_SEED_DATABASE_URL;
    if (seedUrl) {
      seedPool = createPool(parseConfig({ ...process.env, DATABASE_URL: seedUrl }));
    } else {
      const grant = await poolA.query<{ can: boolean }>(
        `select has_table_privilege(current_user, 'public.webhook_inbox', 'INSERT') as can`,
      );
      if (grant.rows[0]?.can) seedPool = poolA;
    }
    if (seedPool === null) {
      skipReason =
        'DATABASE_URL cannot INSERT into webhook_inbox; set INTEGRATION_SEED_DATABASE_URL to seed';
      return;
    }

    const seeded = await seedPool.query<{ id: string }>({
      text: `insert into public.webhook_inbox (subscription_id, payload, received_at)
             select gen_random_uuid(), '{"synthetic": true}'::jsonb,
                    now() - interval '10 years' + (n * interval '1 second')
               from generate_series(1, $1::int) as n
             returning id`,
      values: [ROWS],
      types: ENGINE_TYPES,
    });
    ids = seeded.rows.map((row) => row.id);
  });

  afterAll(async () => {
    if (poolA !== undefined && ids.length > 0) {
      // The worker cannot delete; processed rows are never claimed again.
      await poolA.query({
        text: `update public.webhook_inbox
                  set processed_at = now(), last_error = 'IntegrationTest'
                where id = any($1::uuid[])`,
        values: [ids],
        types: ENGINE_TYPES,
      });
    }
    if (seedPool !== null && seedPool !== poolA) await seedPool.end();
    await poolA?.end();
    await poolB?.end();
  });

  /** Claim up to `max` rows inside one transaction, then roll it back. */
  async function claimAll(pool: Pool, max: number, hold: Promise<void>): Promise<string[]> {
    const client: PoolClient = await pool.connect();
    const claimed: string[] = [];
    try {
      await client.query('begin');
      for (let i = 0; i < max; i += 1) {
        const row = await claimInboxRow(client, claimed);
        if (row === null) break;
        claimed.push(row.id);
      }
      await hold; // keep the locks until both claimers have finished claiming
      return claimed;
    } finally {
      await client.query('rollback');
      client.release();
    }
  }

  it('gives each row to exactly one of two concurrent claimers', async (ctx) => {
    if (skipReason !== null) ctx.skip(skipReason);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = claimAll(poolA, ROWS, hold);
    const b = claimAll(poolB, ROWS, hold);
    // Let both claim, then let both roll back.
    setTimeout(release, 500);
    const [claimedA, claimedB] = await Promise.all([a, b]);

    const mine = new Set(ids);
    const ownA = claimedA.filter((id) => mine.has(id));
    const ownB = claimedB.filter((id) => mine.has(id));

    expect(ownA.filter((id) => ownB.includes(id))).toEqual([]);
    expect(new Set([...ownA, ...ownB])).toEqual(mine);
  });

  it('leaves every row untouched after a rolled-back claim', async (ctx) => {
    if (skipReason !== null) ctx.skip(skipReason);

    const rows = await poolA.query<{ processed_at: string | null; attempts: number }>({
      text: `select processed_at, attempts from public.webhook_inbox where id = any($1::uuid[])`,
      values: [ids],
      types: ENGINE_TYPES,
    });
    expect(rows.rows).toHaveLength(ROWS);
    for (const row of rows.rows) expect(row).toEqual({ processed_at: null, attempts: 0 });
  });

  it('never hands a locked row to a second claimer', async (ctx) => {
    if (skipReason !== null) ctx.skip(skipReason);

    const holder = await poolA.connect();
    const other = await poolB.connect();
    try {
      await holder.query('begin');
      await other.query('begin');
      const first = await claimInboxRow(holder);
      const second = await claimInboxRow(other);
      expect(first).not.toBeNull();
      expect(second?.id).not.toBe(first?.id);
    } finally {
      await holder.query('rollback');
      await other.query('rollback');
      holder.release();
      other.release();
    }
  });
});
