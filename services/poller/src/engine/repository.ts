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

// --- provider_credit_log (§7.6, §7.7) ----------------------------------------
// Shared by the two writers of the log: the webhook drain (`webhookIngest.ts`,
// the balance every delivery carries) and the hourly `credit-check`
// (`creditMonitor.ts`). `flightbuddy_worker` holds `select, insert` on the table.

/** `provider_credit_log.balance` is `int`. */
export const INT4_MAX = 2_147_483_647;
export const INT4_MIN = -2_147_483_648;

/** The `source` values the migration documents. `post_refill` is written by nobody yet (ADR 0003). */
export const CREDIT_LOG_SOURCES = {
  WEBHOOK_PAYLOAD: 'webhook_payload',
  BALANCE_CHECK: 'balance_check',
  POST_REFILL: 'post_refill',
} as const;

export type CreditLogSource = (typeof CREDIT_LOG_SOURCES)[keyof typeof CREDIT_LOG_SOURCES];

export const INSERT_CREDIT_LOG_SQL = `insert into public.provider_credit_log (balance, source)
values ($1, $2)`;

/**
 * The most recent reading, from any source, by `id` alone — the same order
 * `DISARMED_THRESHOLDS_SQL` uses. `observed_at` is `now()` at each insert and two
 * rows can tie or disagree with insertion order; ordering on it could seed the
 * worker's credit state at boot from an older, healthier row than the zero reading
 * that followed it.
 */
export const LATEST_CREDIT_BALANCE_SQL = `select balance
  from public.provider_credit_log
 order by id desc
 limit 1`;

/** A whole number the `int` column can hold. Anything else is not written. */
export function isLoggableBalance(balance: number): boolean {
  return Number.isInteger(balance) && balance >= INT4_MIN && balance <= INT4_MAX;
}

/** Record one reading. The caller checks `isLoggableBalance` first. */
export async function insertCreditLog(
  pool: Pool,
  balance: number,
  source: CreditLogSource,
): Promise<void> {
  await pool.query({
    text: INSERT_CREDIT_LOG_SQL,
    values: [balance, source],
    types: ENGINE_TYPES,
  });
}

/** The latest logged balance, or `null` when the log is empty. */
export async function readLatestCreditBalance(pool: Pool): Promise<number | null> {
  const result = await pool.query<{ balance: number }>({
    text: LATEST_CREDIT_BALANCE_SQL,
    types: ENGINE_TYPES,
  });
  const row = result.rows[0];
  return row === undefined ? null : Number(row.balance);
}

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
