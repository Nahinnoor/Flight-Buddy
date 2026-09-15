/**
 * The lease claim against a real Postgres (PHASE2_PLAN §1, criterion 4).
 *
 * Skipped unless `INTEGRATION=1` **and** `DATABASE_URL` is set, so `npm test` stays
 * offline everywhere else (§12.2).
 *
 * ```sh
 * INTEGRATION=1 npm test -w @flightbuddy/poller
 * ```
 *
 * `for update skip locked` cannot be proved against a fake: the whole question is
 * what two connections racing on the same rows do. So this test opens **two pools**
 * and claims from both at once.
 *
 * ## What it touches
 *
 * Synthetic rows only: carrier `ZZ` (unassigned by IATA) on a far-future date, with
 * `next_poll_at` set well in the past so they sort ahead of anything real and a
 * single small batch takes them. A short lease bounds the blast radius if a real
 * row is swept in: two seconds later it is claimable again, and nothing about it is
 * modified except `poll_lease_until`.
 *
 * Cleanup archives the synthetic rows rather than deleting them, because the
 * `flightbuddy_worker` role has **no DELETE grant anywhere** — which is the point.
 * An archived row is invisible to every later claim.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvFile, parseConfig, type Config } from '../config';
import { createPool, ping, type Pool } from '../db';
import { claimDueFlights, releaseLease } from './lease';
import { ENGINE_TYPES, type FlightRow } from './types';

loadEnvFile();

const enabled = process.env.INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);

/** Unassigned IATA prefix, so these can never collide with a real flight. */
const SYNTHETIC_CARRIER = 'ZZ';
const SYNTHETIC_DATE = '2099-01-01';
const FLIGHT_COUNT = 6;
/** Short, so a real row accidentally swept in is claimable again almost at once. */
const LEASE_MS = 2_000;

describe.skipIf(!enabled)('claimDueFlights against a real database', () => {
  let config: Config;
  let poolA: Pool;
  let poolB: Pool;
  /** `ZZ` flight numbers unique to this run, so concurrent runs do not collide. */
  let numbers: string[];
  let insertedIds: string[];

  beforeAll(async () => {
    config = parseConfig();
    poolA = createPool(config);
    poolB = createPool(config);
    await ping(poolA);
    await ping(poolB);

    const run = randomUUID().replaceAll('-', '').slice(0, 8);
    numbers = Array.from({ length: FLIGHT_COUNT }, (_, i) => `${run}${i}`);

    // Due well in the past so these sort ahead of any real due flight, and one
    // small batch is enough to take them all.
    const result = await poolA.query<{ id: string }>({
      text: `insert into public.flights (
               operating_carrier_iata, operating_flight_number, departure_date_local,
               origin_iata, destination_iata, origin_tz, destination_tz,
               next_poll_at, scheduled_departure_utc, scheduled_arrival_utc
             )
             select $1, n, $2::date, 'ZZZ', 'ZZY', 'UTC', 'UTC',
                    now() - interval '10 years',
                    now() + interval '30 days',
                    now() + interval '30 days' + interval '2 hours'
               from unnest($3::text[]) as n
             returning id`,
      values: [SYNTHETIC_CARRIER, SYNTHETIC_DATE, numbers],
      types: ENGINE_TYPES,
    });
    insertedIds = result.rows.map((row) => row.id);
  });

  afterAll(async () => {
    // Archive, never delete: the role has no DELETE grant (§8.7). An archived row
    // is excluded from every claim.
    if (poolA !== undefined && numbers !== undefined) {
      await poolA.query({
        text: `update public.flights
                  set archived_at = now(), next_poll_at = null, poll_lease_until = null
                where operating_carrier_iata = $1
                  and departure_date_local = $2::date
                  and operating_flight_number = any($3::text[])`,
        values: [SYNTHETIC_CARRIER, SYNTHETIC_DATE, numbers],
        types: ENGINE_TYPES,
      });
    }
    if (poolA !== undefined) await poolA.end();
    if (poolB !== undefined) await poolB.end();
  });

  it('inserted the synthetic batch', () => {
    expect(insertedIds).toHaveLength(FLIGHT_COUNT);
  });

  it('returns rows in the shapes the engine expects, not pg defaults', async () => {
    const [claimed] = await claimDueFlights(poolA, 1, LEASE_MS);
    expect(claimed).toBeDefined();
    const row = claimed as FlightRow;

    // A `date` must stay the origin-local calendar date as text. `pg`'s default
    // would hand back a JS Date at the *server's* local midnight (§6.3, §8.4).
    expect(typeof row.departure_date_local).toBe('string');
    expect(row.departure_date_local).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Timestamps are UTC ISO strings, which is what `ingestFlight` and the ladder
    // both assume.
    expect(typeof row.poll_lease_until).toBe('string');
    expect(row.poll_lease_until).toMatch(/Z$/);
    expect(typeof row.poll_failure_count).toBe('number');

    await releaseLease(poolA, row.id);
  });

  it('gives each due flight to exactly one of two concurrent claimers', async () => {
    // The criterion: two workers overlapping during a deploy must never poll the
    // same flight twice. `skip locked` is what makes both make progress instead of
    // one queueing behind the other.
    const [batchA, batchB] = await Promise.all([
      claimDueFlights(poolA, FLIGHT_COUNT, LEASE_MS),
      claimDueFlights(poolB, FLIGHT_COUNT, LEASE_MS),
    ]);

    const mine = new Set(insertedIds);
    const claimedA = batchA.map((row) => row.id).filter((id) => mine.has(id));
    const claimedB = batchB.map((row) => row.id).filter((id) => mine.has(id));
    const all = [...claimedA, ...claimedB];

    // No row in both batches, and no row twice in one batch.
    expect(new Set(all).size).toBe(all.length);
    expect(claimedA.filter((id) => claimedB.includes(id))).toEqual([]);

    // Between them they took the whole synthetic batch: both claimers made
    // progress rather than one waiting on the other's locks.
    expect(new Set(all)).toEqual(mine);
    expect(claimedA.length + claimedB.length).toBe(FLIGHT_COUNT);
  });

  it('does not hand a leased flight to a third claimer', async () => {
    // The rows from the test above are still leased for LEASE_MS.
    const again = await claimDueFlights(poolA, FLIGHT_COUNT, LEASE_MS);
    const mine = new Set(insertedIds);

    expect(again.filter((row) => mine.has(row.id))).toEqual([]);
  });

  it('hands a flight back once its lease is released', async () => {
    const first = insertedIds[0];
    expect(first).toBeDefined();
    await releaseLease(poolA, first as string);

    const claimed = await claimDueFlights(poolA, FLIGHT_COUNT, LEASE_MS);
    expect(claimed.map((row) => row.id)).toContain(first);
  });

  it('never claims an archived flight', async () => {
    const target = insertedIds[1];
    expect(target).toBeDefined();
    await poolA.query({
      text: `update public.flights
                set archived_at = now(), poll_lease_until = null
              where id = $1`,
      values: [target],
      types: ENGINE_TYPES,
    });

    const claimed = await claimDueFlights(poolA, FLIGHT_COUNT, LEASE_MS);
    expect(claimed.map((row) => row.id)).not.toContain(target);
  });

  it('never claims a flight with a null next_poll_at (the "do not poll" state)', async () => {
    const target = insertedIds[2];
    expect(target).toBeDefined();
    await poolA.query({
      text: `update public.flights
                set next_poll_at = null, poll_lease_until = null
              where id = $1`,
      values: [target],
      types: ENGINE_TYPES,
    });

    const claimed = await claimDueFlights(poolA, FLIGHT_COUNT, LEASE_MS);
    expect(claimed.map((row) => row.id)).not.toContain(target);
  });
});
