/**
 * The engine's SQL, other than the lease claim.
 *
 * Everything here is a parameterised statement against a table the
 * `flightbuddy_worker` role actually holds a grant on: `select, insert, update on
 * public.flights`, `select, insert on public.flight_events`, `select, insert,
 * update on public.notification_deliveries`, and column-level `select` on the
 * trip tables the fan-out joins (migration `20260915021807_worker_role`). **There is no DELETE in this file**, because the
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
import type { DetectedEvent, FlightEventType } from './changeDetector';
import type { Pool } from '../db';
import { ONCE_PER_FLIGHT_EVENT_TYPES } from './notificationPolicy';
import { recipientsCte } from './recipients';
import { ENGINE_TYPES } from './types';

// --- provider_credit_log (§7.6, §7.7) ----------------------------------------
// Shared by the two writers of the log: the webhook drain (`webhookIngest.ts`,
// the balance every delivery carries) and the hourly `credit-check`
// (`creditMonitor.ts`). `flightbuddy_worker` holds `select, insert` on the table.

/** `provider_credit_log.balance` is `int`. */
export const INT4_MAX = 2_147_483_647;
export const INT4_MIN = -2_147_483_648;

/**
 * The `source` values written to `provider_credit_log.source` (plain `text`, no
 * check constraint). The migration documents the first three; `drill` came later.
 * `post_refill` is written by nobody yet (ADR 0003).
 */
export const CREDIT_LOG_SOURCES = {
  WEBHOOK_PAYLOAD: 'webhook_payload',
  BALANCE_CHECK: 'balance_check',
  POST_REFILL: 'post_refill',
  /**
   * A forced zero from the credit drill (`CREDIT_DRILL_ZERO`), never a real
   * reading: kept apart so the drill's rows can be told from the account's
   * real balance history, and removed after a drill.
   */
  DRILL: 'drill',
} as const;

export type CreditLogSource = (typeof CREDIT_LOG_SOURCES)[keyof typeof CREDIT_LOG_SOURCES];

export const INSERT_CREDIT_LOG_SQL = `insert into public.provider_credit_log (balance, source)
values ($1, $2)`;

/**
 * The most recent real reading, by `id` alone — the same order
 * `DISARMED_THRESHOLDS_SQL` uses. `observed_at` is `now()` at each insert and two
 * rows can tie or disagree with insertion order; ordering on it could seed the
 * worker's credit state at boot from an older, healthier row than the zero reading
 * that followed it.
 *
 * Drill rows are skipped: a forced zero is not the account's balance, and a
 * restart between unsetting `CREDIT_DRILL_ZERO` and deleting the drill rows must
 * not boot the worker into failover off it.
 */
export const LATEST_CREDIT_BALANCE_SQL = `select balance
  from public.provider_credit_log
 where source <> '${CREDIT_LOG_SOURCES.DRILL}'
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
 * Build the statement that records a batch of detected events **and** fans each
 * one out to its recipients (wave 5, §9).
 *
 * One statement, so it is atomic: an event is never committed without its
 * `notification_deliveries` rows, and a crash cannot leave a change recorded but
 * nobody told. The parts:
 *
 * 1. `inserted` — the `flight_events` rows, as before.
 * 2. `recipients` — who is told (`recipients.ts`; own flights only in Phase 2).
 * 3. `fanned` — one delivery per (event, user), `on conflict do nothing` on the
 *    §9 unique key. A user who already had a delivery for a once-per-flight event
 *    type on this flight (`ONCE_PER_FLIGHT_EVENT_TYPES`) is skipped, so a status
 *    bounce cannot send a second "cancelled".
 *
 * Returns one row per event: its id, and the number of deliveries the whole
 * statement created (the same on every row).
 *
 * Exported so a test can assert the statement's shape without a database. The
 * placeholder numbers come from the event's index in the array — never from any
 * value inside it. The two trailing parameters are the notifying types and the
 * once-per-flight types, both `text[]`.
 */
export function buildInsertEventsSql(count: number): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = i * 5;
    rows.push(
      `($${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4}::jsonb, $${base + 5})`,
    );
  }
  const notifyParam = `$${count * 5 + 1}`;
  const onceParam = `$${count * 5 + 2}`;

  return `with inserted as (
insert into public.flight_events (flight_id, event_type, previous_value, new_value, source)
values ${rows.join(', ')}
returning id, flight_id, event_type
),
${recipientsCte(notifyParam)},
fanned as (
  insert into public.notification_deliveries (flight_event_id, user_id, recipient_reason)
  select r.flight_event_id, r.user_id, r.recipient_reason
    from recipients r
    join inserted i on i.id = r.flight_event_id
   where not (
           i.event_type = any(${onceParam}::text[])
           and exists (
                 select 1
                   from public.notification_deliveries d
                   join public.flight_events e on e.id = d.flight_event_id
                  where d.user_id = r.user_id
                    and e.flight_id = i.flight_id
                    and e.event_type = i.event_type))
  on conflict (flight_event_id, user_id) do nothing
  returning id
)
select i.id, (select count(*) from fanned)::int as deliveries
  from inserted i`;
}

export interface RecordedEvents {
  eventIds: string[];
  /** `notification_deliveries` rows created: > 0 means there is something to send. */
  deliveries: number;
}

/**
 * Insert the events one poll (or one delivery) detected, create their
 * deliveries, and return both.
 *
 * @param notify The event types in this batch allowed to notify
 *   (`notifyingEventTypes`). Events outside it are still recorded; they get no
 *   delivery row.
 */
export async function recordFlightEvents(
  pool: Pool,
  flightId: string,
  events: readonly DetectedEvent[],
  notify: readonly FlightEventType[],
): Promise<RecordedEvents> {
  if (events.length === 0) return { eventIds: [], deliveries: 0 };

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
  values.push([...notify], [...ONCE_PER_FLIGHT_EVENT_TYPES]);

  const result = await pool.query<{ id: string; deliveries: number | string }>({
    text: buildInsertEventsSql(events.length),
    values,
    types: ENGINE_TYPES,
  });

  return {
    eventIds: result.rows.map((row) => row.id),
    deliveries: Number(result.rows[0]?.deliveries ?? 0),
  };
}

/** `recordFlightEvents`, returning only the event ids. */
export async function insertFlightEvents(
  pool: Pool,
  flightId: string,
  events: readonly DetectedEvent[],
  notify: readonly FlightEventType[],
): Promise<string[]> {
  return (await recordFlightEvents(pool, flightId, events, notify)).eventIds;
}
