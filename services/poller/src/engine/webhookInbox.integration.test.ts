/**
 * The inbox claim against a real Postgres: two concurrent claimers never get the
 * same row (`for update skip locked`).
 *
 * **Only against the throwaway cluster** (`../throwawayDb.ts`): skipped unless
 * `INTEGRATION=1`, and it refuses to start without `INTEGRATION_THROWAWAY=1`, on a
 * host that is not a local socket or loopback, or when `auth.users` is not empty.
 * A deployed worker draining the same inbox would claim the rows it seeds and
 * break the two-claimer assertions. Run it with:
 *
 * ```sh
 * npm run test:integration -w @flightbuddy/poller
 * ```
 *
 * ## Seeding
 *
 * `flightbuddy_worker` has no INSERT on `webhook_inbox` — only the receiver writes
 * it — so rows are seeded as the cluster's superuser and claimed as the worker.
 *
 * ## What it touches
 *
 * Four synthetic rows with random subscription ids and a `{ "synthetic": true }`
 * payload, received ten years ago so they sort ahead of any other row. Every
 * claim runs in a transaction that is **rolled back**, so the claim itself
 * changes nothing. Cleanup marks the rows processed (the worker cannot delete).
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Pool, PoolClient } from '../db';
import {
  connectThrowawayDb,
  integrationRequested as enabled,
  type ThrowawayDb,
} from '../throwawayDb';
import { ENGINE_TYPES } from './types';
import { claimInboxRow } from './webhookIngest';

const ROWS = 4;

describe.skipIf(!enabled)('webhook inbox claim against a real database', () => {
  let db: ThrowawayDb | undefined;
  let poolA: Pool;
  let poolB: Pool;
  let ids: string[] = [];

  beforeAll(async () => {
    db = await connectThrowawayDb();
    poolA = db.worker;
    poolB = new pg.Pool(db.workerConnection) as Pool;

    const seeded = await db.admin.query<{ id: string }>({
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
    await poolB?.end();
    await db?.end();
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

  it('gives each row to exactly one of two concurrent claimers', async () => {
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

  it('leaves every row untouched after a rolled-back claim', async () => {
    const rows = await poolA.query<{ processed_at: string | null; attempts: number }>({
      text: `select processed_at, attempts from public.webhook_inbox where id = any($1::uuid[])`,
      values: [ids],
      types: ENGINE_TYPES,
    });
    expect(rows.rows).toHaveLength(ROWS);
    for (const row of rows.rows) expect(row).toEqual({ processed_at: null, attempts: 0 });
  });

  it('never hands a locked row to a second claimer', async () => {
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
