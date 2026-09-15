/**
 * Claiming flights to poll (§7.5, §8.7).
 *
 * ## Lease, not lock
 *
 * The claim is one statement in its own implicit transaction, and it **commits
 * before any HTTP call is made**. Holding `for update` across a call to RapidAPI
 * would pin a row lock for the length of a third-party request; a slow provider
 * would then block every other worker and, on Supabase's pooler, tie up a session
 * too. Instead the claim stamps `poll_lease_until` and lets go. If the worker dies
 * mid-poll — which Render does on every deploy — nothing needs cleaning up: the
 * lease expires on its own and the flight is claimed again.
 *
 * ## `for update skip locked`
 *
 * Two workers overlapping during a deploy must not both poll the same flight: that
 * is two provider units and two chances at a duplicate event. `skip locked` makes
 * the second claimer step over rows the first is stamping instead of waiting
 * behind them, so both make progress and neither sees the same row.
 *
 * (Overview §7.5 prints `for update skip lock`; the Postgres spelling is
 * `skip locked`.)
 *
 * ## Grants
 *
 * `flightbuddy_worker` has `select, insert, update on public.flights` and **no
 * DELETE anywhere** (migration `20260915021807_worker_role`). Everything here is a
 * SELECT or an UPDATE, and every value is a bound parameter.
 */
import type { Pool } from '../db';
import { ENGINE_TYPES, type FlightRow } from './types';

/** §7.5. Long enough for a slow provider call, short enough that a killed worker's row comes back quickly. */
export const DEFAULT_LEASE_MS = 120_000;

/**
 * §7.5's statement, parameterised.
 *
 * The `where` clause is the index `flights_next_poll_at_idx` was built for:
 * `(next_poll_at) where archived_at is null and next_poll_at is not null`.
 * `next_poll_at is null` is the "do not poll" state — a `manual`-tier flight, or
 * (from wave 3) one whose alerts are coming over a webhook — so it must never be
 * claimable.
 */
export const CLAIM_DUE_FLIGHTS_SQL = `update public.flights
   set poll_lease_until = now() + ($2::double precision * interval '1 millisecond')
 where id in (
   select id
     from public.flights
    where archived_at is null
      and next_poll_at is not null
      and next_poll_at <= now()
      and (poll_lease_until is null or poll_lease_until < now())
    order by next_poll_at
    limit $1
    for update skip locked
 )
returning *`;

/** Clears a lease so the flight is claimable again on the next pass. */
export const RELEASE_LEASE_SQL = `update public.flights
   set poll_lease_until = null
 where id = $1`;

/**
 * Claim up to `batchSize` due flights and return them, lease already committed.
 *
 * `batchSize` is bounded (§7.5 uses 25) because it is one of the three things
 * keeping a crowd of simultaneously due flights from becoming a burst against a
 * 1 req/s limit — the others being the token bucket and the ladder's jitter (§8.3).
 *
 * @throws whatever `pg` throws. The caller logs and the pass ends; the lease on
 *   any row this statement did stamp expires by itself.
 */
export async function claimDueFlights(
  pool: Pool,
  batchSize: number,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<FlightRow[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('claimDueFlights batchSize must be a positive integer');
  }
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new RangeError('claimDueFlights leaseMs must be a positive number');
  }

  const result = await pool.query<FlightRow>({
    text: CLAIM_DUE_FLIGHTS_SQL,
    values: [batchSize, leaseMs],
    types: ENGINE_TYPES,
  });

  return result.rows;
}

/**
 * Hand a lease back early.
 *
 * The loop does not need this — an expiring lease is the design (§8.7) — but a
 * handler that knows it will not poll a flight can return it now instead of
 * leaving it parked for two minutes.
 */
export async function releaseLease(pool: Pool, flightId: string): Promise<void> {
  await pool.query({ text: RELEASE_LEASE_SQL, values: [flightId], types: ENGINE_TYPES });
}
