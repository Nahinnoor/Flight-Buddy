/**
 * The engine's SQL, other than the lease claim.
 *
 * Everything here is a parameterised statement against a table the
 * `flightbuddy_worker` role actually holds a grant on: `select, insert, update on
 * public.flights` and `select, insert on public.flight_events` (migration
 * `20260915021807_worker_role`). **There is no DELETE in this file**, because the
 * role has none anywhere — archiving is `archived_at = now()`, never a delete.
 *
 * The `flights` columns written here are the *scheduling* ones —
 * `next_poll_at`, `last_polled_at`, `poll_failure_count`, `poll_lease_until`,
 * `archived_at`. Provider data never travels through this file: that goes through
 * `ingestFlight` and its `FlightsWriter`, which is rule 7 (§12.7).
 *
 * Provider payloads reach `flight_events.previous_value` / `new_value` as bound
 * JSON parameters. Nothing derived from a payload is ever concatenated into a
 * statement: the only thing built at runtime is the `($1, $2, …)` placeholder
 * list, and it is built from array indices.
 */
import type { DetectedEvent } from './changeDetector';
import type { Pool } from '../db';
import { ENGINE_TYPES } from './types';

/** Written after a poll that reached the provider and ingested a leg. */
export const RECORD_POLL_SUCCESS_SQL = `update public.flights
   set next_poll_at = $2,
       last_polled_at = $3,
       poll_failure_count = 0,
       poll_lease_until = null,
       archived_at = $4
 where id = $1`;

/**
 * Written after a poll that did not reach a usable leg.
 *
 * `archived_at` is deliberately absent: a failure says nothing about whether the
 * flight is over, and "the provider stopped returning it" is explicitly **not** a
 * cancellation (§8.8).
 */
export const RECORD_POLL_FAILURE_SQL = `update public.flights
   set next_poll_at = $2,
       last_polled_at = $3,
       poll_failure_count = $4,
       poll_lease_until = null
 where id = $1`;

export interface PollSuccessUpdate {
  flightId: string;
  /** `null` stops polling: landed and archived, or (wave 3) handed to a webhook. */
  nextPollAt: Date | null;
  polledAt: Date;
  /** Set only at landed + 30 min; `null` otherwise, matching the ingest that just ran. */
  archivedAt: Date | null;
}

export interface PollFailureUpdate {
  flightId: string;
  nextPollAt: Date | null;
  polledAt: Date;
  failureCount: number;
}

export async function recordPollSuccess(pool: Pool, update: PollSuccessUpdate): Promise<void> {
  await pool.query({
    text: RECORD_POLL_SUCCESS_SQL,
    values: [update.flightId, update.nextPollAt, update.polledAt, update.archivedAt],
    types: ENGINE_TYPES,
  });
}

export async function recordPollFailure(pool: Pool, update: PollFailureUpdate): Promise<void> {
  await pool.query({
    text: RECORD_POLL_FAILURE_SQL,
    values: [update.flightId, update.nextPollAt, update.polledAt, update.failureCount],
    types: ENGINE_TYPES,
  });
}

/**
 * Build the multi-row insert for a batch of detected events.
 *
 * Exported so a test can assert the statement's shape without a database. The
 * placeholder numbers come from the event's index in the array — never from any
 * value inside it.
 */
export function buildInsertEventsSql(count: number): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = i * 5;
    rows.push(
      `($${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4}::jsonb, $${base + 5})`,
    );
  }
  return `insert into public.flight_events (flight_id, event_type, previous_value, new_value, source)
values ${rows.join(', ')}
returning id`;
}

/**
 * Insert the events one poll detected, and return their ids.
 *
 * One statement for the batch: the events of a single poll are one piece of news
 * about one flight, and wave 5 will fan them out to recipients together.
 */
export async function insertFlightEvents(
  pool: Pool,
  flightId: string,
  events: readonly DetectedEvent[],
): Promise<string[]> {
  if (events.length === 0) return [];

  const values: unknown[] = [];
  for (const event of events) {
    values.push(
      flightId,
      event.type,
      event.previousValue === null ? null : JSON.stringify(event.previousValue),
      JSON.stringify(event.newValue),
      event.source,
    );
  }

  const result = await pool.query<{ id: string }>({
    text: buildInsertEventsSql(events.length),
    values,
    types: ENGINE_TYPES,
  });

  return result.rows.map((row) => row.id);
}
