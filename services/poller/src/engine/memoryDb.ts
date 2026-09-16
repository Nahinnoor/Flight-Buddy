/**
 * Test support: a small stateful stand-in for the worker's slice of Postgres.
 *
 * `fakePool.ts` records statements and replays queued results, which proves what
 * SQL is sent but cannot prove what happens when two paths touch the same row —
 * and that is the whole of criterion 8 (poll/webhook race). This fake keeps real
 * state for `flights`, `flight_events`, `webhook_inbox` and `provider_credit_log`,
 * and implements the engine's statements **by their exported constants**: any
 * statement it does not recognise throws, so a new query cannot slip past a test
 * unimplemented. The `FlightsWriter` it hands out is the real `pg` writer running
 * over this fake, so `ingestFlight`'s actual upsert is what writes the row.
 *
 * Semantics are only as deep as the tests need: leases, `skip locked` per client,
 * the canonical-key upsert. The real-database behaviour of the same SQL is
 * `*.integration.test.ts`'s job.
 *
 * Not exported from `src/index.ts`: this is for tests.
 */
import { randomUUID } from 'node:crypto';

import {
  FLIGHTS_CONFLICT_COLUMNS,
  FLIGHTS_UPSERT_SQL,
  FLIGHT_UPSERT_COLUMNS,
  createPgFlightsWriter,
  type FlightsWriter,
} from '@flightbuddy/flight-provider';

import type { Pool } from '../db';
import { CLAIM_DUE_FLIGHTS_SQL, RELEASE_LEASE_SQL } from './lease';
import { ACTIVE_SUBSCRIPTIONS_SQL, DETACH_SUBSCRIPTION_SQL } from './reconcile';
import { RECORD_POLL_FAILURE_SQL, RECORD_POLL_SUCCESS_SQL } from './repository';
import {
  CLEAR_SUBSCRIPTION_SQL,
  COUNT_OTHER_HOLDERS_SQL,
  FIND_SHARED_SUBSCRIPTION_SQL,
  STORE_SUBSCRIPTION_SQL,
} from './subscriptions';
import type { FlightRow } from './types';
import {
  CLAIM_INBOX_ROW_SQL,
  FIND_SUBSCRIBED_FLIGHTS_SQL,
  INSERT_CREDIT_LOG_SQL,
  LEASE_FLIGHT_FOR_WEBHOOK_SQL,
  MARK_INBOX_DONE_SQL,
  MARK_INBOX_FAILED_SQL,
  WEBHOOK_APPLIED_SQL,
} from './webhookIngest';

export interface MemoryEvent {
  id: string;
  flight_id: string;
  event_type: string;
  previous_value: unknown;
  new_value: unknown;
  source: string;
}

export interface MemoryInboxRow {
  id: string;
  received_at: string;
  subscription_id: string;
  payload: unknown;
  processed_at: string | null;
  attempts: number;
  last_error: string | null;
}

export interface MemoryDb {
  pool: Pool;
  /** The real `pg` `FlightsWriter`, running over this fake. */
  writer: FlightsWriter;
  flights: Map<string, FlightRow>;
  events: MemoryEvent[];
  inbox: MemoryInboxRow[];
  creditLog: { balance: number; source: string }[];
  statements: { text: string; values: readonly unknown[] }[];
  setNow(now: Date): void;
  addFlight(row: FlightRow): FlightRow;
  flight(id: string): FlightRow;
  addInbox(row: { subscription_id: string; payload: unknown; id?: string; received_at?: string; attempts?: number }): string;
  /** Make the next statement with exactly this text throw `error`. */
  failOn(text: string, error: Error): void;
}

type Row = Record<string, unknown>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function millis(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

export function createMemoryDb(options: { now?: Date } = {}): MemoryDb {
  let now = options.now ?? new Date('2026-09-11T20:00:00.000Z');
  const flights = new Map<string, FlightRow>();
  const events: MemoryEvent[] = [];
  const inbox: MemoryInboxRow[] = [];
  const creditLog: { balance: number; source: string }[] = [];
  const statements: { text: string; values: readonly unknown[] }[] = [];
  const failures = new Map<string, Error>();
  /** inbox id → the client holding its row lock. */
  const inboxLocks = new Map<string, number>();
  let nextClientId = 1;

  const nowMs = () => now.getTime();
  const leaseFree = (flight: FlightRow) => {
    const until = millis(flight.poll_lease_until);
    return until === null || until < nowMs();
  };
  const copy = (flight: FlightRow): FlightRow => ({ ...flight });
  const requireFlight = (id: unknown): FlightRow | undefined => flights.get(String(id));

  function releaseLocks(clientId: number): void {
    for (const [id, holder] of inboxLocks) if (holder === clientId) inboxLocks.delete(id);
  }

  function upsertFlight(values: readonly unknown[]): Row[] {
    const row: Row = {};
    FLIGHT_UPSERT_COLUMNS.forEach((column, index) => {
      row[column] = values[index];
    });
    if (typeof row.raw_payload === 'string') row.raw_payload = JSON.parse(row.raw_payload);

    const key = FLIGHTS_CONFLICT_COLUMNS as readonly string[];
    const existing = [...flights.values()].find((flight) =>
      key.every((column) => (flight as unknown as Row)[column] === row[column]),
    );
    if (existing !== undefined) {
      for (const column of FLIGHT_UPSERT_COLUMNS) {
        if (!key.includes(column)) (existing as unknown as Row)[column] = row[column];
      }
      return [{ id: existing.id }];
    }

    const id = randomUUID();
    // `row` holds only the upsert columns; the rest are the table defaults.
    flights.set(id, {
      ...(row as unknown as FlightRow),
      id,
      next_poll_at: null,
      poll_lease_until: null,
      last_polled_at: null,
      poll_failure_count: 0,
      alert_subscription_id: null,
      alert_subscribed_at: null,
      created_at: now.toISOString(),
    });
    return [{ id }];
  }

  function run(clientId: number, text: string, values: readonly unknown[]): Row[] {
    statements.push({ text, values });
    const failure = failures.get(text);
    if (failure !== undefined) {
      failures.delete(text);
      throw failure;
    }

    const verb = text.trim().toLowerCase();
    if (verb === 'begin') return [];
    if (verb === 'commit' || verb === 'rollback') {
      releaseLocks(clientId);
      return [];
    }

    if (text.startsWith('insert into public.flight_events')) {
      const ids: Row[] = [];
      for (let i = 0; i < values.length; i += 5) {
        const id = randomUUID();
        events.push({
          id,
          flight_id: String(values[i]),
          event_type: String(values[i + 1]),
          previous_value: values[i + 2] === null ? null : JSON.parse(String(values[i + 2])),
          new_value: JSON.parse(String(values[i + 3])),
          source: String(values[i + 4]),
        });
        ids.push({ id });
      }
      return ids;
    }

    switch (text) {
      case FLIGHTS_UPSERT_SQL:
        return upsertFlight(values);

      case CLAIM_DUE_FLIGHTS_SQL: {
        const [limit, leaseMs] = values as [number, number];
        const due = [...flights.values()]
          .filter(
            (f) =>
              f.archived_at === null &&
              f.next_poll_at !== null &&
              (millis(f.next_poll_at) as number) <= nowMs() &&
              leaseFree(f),
          )
          .sort((a, b) => (millis(a.next_poll_at) as number) - (millis(b.next_poll_at) as number))
          .slice(0, limit);
        for (const f of due) f.poll_lease_until = new Date(nowMs() + leaseMs).toISOString();
        return due.map(copy) as unknown as Row[];
      }

      case RELEASE_LEASE_SQL: {
        const f = requireFlight(values[0]);
        if (f) f.poll_lease_until = null;
        return [];
      }

      case RECORD_POLL_SUCCESS_SQL: {
        const f = requireFlight(values[0]);
        if (f) {
          f.next_poll_at = iso(values[1]);
          f.last_polled_at = iso(values[2]);
          f.poll_failure_count = 0;
          f.poll_lease_until = null;
          f.archived_at = iso(values[3]);
        }
        return [];
      }

      case RECORD_POLL_FAILURE_SQL: {
        const f = requireFlight(values[0]);
        if (f) {
          f.next_poll_at = iso(values[1]);
          f.last_polled_at = iso(values[2]);
          f.poll_failure_count = Number(values[3]);
          f.poll_lease_until = null;
        }
        return [];
      }

      case FIND_SHARED_SUBSCRIPTION_SQL: {
        const [carrier, number, exclude] = values;
        const holder = [...flights.values()]
          .filter(
            (f) =>
              f.archived_at === null &&
              f.alert_subscription_id !== null &&
              f.operating_carrier_iata.trim() === carrier &&
              f.operating_flight_number.trim() === number &&
              f.id !== exclude,
          )
          .sort((a, b) => (millis(a.alert_subscribed_at) ?? Infinity) - (millis(b.alert_subscribed_at) ?? Infinity))[0];
        return holder === undefined ? [] : [{ alert_subscription_id: holder.alert_subscription_id }];
      }

      case STORE_SUBSCRIPTION_SQL: {
        const f = requireFlight(values[0]);
        if (!f || f.alert_subscription_id !== null) return [];
        f.alert_subscription_id = String(values[1]);
        f.alert_subscribed_at = iso(values[2]);
        return [{ id: f.id }];
      }

      case COUNT_OTHER_HOLDERS_SQL: {
        const [subscriptionId, exclude] = values;
        const holders = [...flights.values()].filter(
          (f) => f.alert_subscription_id === subscriptionId && f.archived_at === null && f.id !== exclude,
        ).length;
        return [{ holders }];
      }

      case CLEAR_SUBSCRIPTION_SQL: {
        const f = requireFlight(values[0]);
        if (f && f.alert_subscription_id === values[1]) {
          f.alert_subscription_id = null;
          f.alert_subscribed_at = null;
        }
        return [];
      }

      case CLAIM_INBOX_ROW_SQL: {
        const [maxAttempts, skip] = values as [number, string[]];
        const row = [...inbox]
          .sort((a, b) => a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id))
          .find(
            (r) =>
              r.processed_at === null &&
              r.attempts < maxAttempts &&
              !skip.includes(r.id) &&
              !inboxLocks.has(r.id),
          );
        if (row === undefined) return [];
        inboxLocks.set(row.id, clientId);
        return [
          { id: row.id, subscription_id: row.subscription_id, payload: row.payload, attempts: row.attempts },
        ];
      }

      case MARK_INBOX_DONE_SQL: {
        const row = inbox.find((r) => r.id === values[0]);
        if (row) {
          row.processed_at = now.toISOString();
          row.attempts += 1;
          row.last_error = values[1] === null ? null : String(values[1]);
        }
        return [];
      }

      case MARK_INBOX_FAILED_SQL: {
        const row = inbox.find((r) => r.id === values[0]);
        if (!row) return [];
        row.attempts += 1;
        row.last_error = String(values[1]);
        row.processed_at = row.attempts >= Number(values[2]) ? now.toISOString() : null;
        return [{ attempts: row.attempts, processed_at: row.processed_at }];
      }

      case FIND_SUBSCRIBED_FLIGHTS_SQL:
        return [...flights.values()]
          .filter((f) => f.alert_subscription_id === values[0] && f.archived_at === null)
          .map((f) => ({
            id: f.id,
            operating_carrier_iata: f.operating_carrier_iata,
            operating_flight_number: f.operating_flight_number,
            departure_date_local: f.departure_date_local,
            origin_iata: f.origin_iata,
          }));

      case LEASE_FLIGHT_FOR_WEBHOOK_SQL: {
        const f = requireFlight(values[0]);
        if (!f || f.archived_at !== null || !leaseFree(f)) return [];
        f.poll_lease_until = new Date(nowMs() + Number(values[1])).toISOString();
        return [copy(f) as unknown as Row];
      }

      case WEBHOOK_APPLIED_SQL: {
        const f = requireFlight(values[0]);
        if (f) {
          f.next_poll_at = iso(values[1]);
          f.poll_lease_until = null;
        }
        return [];
      }

      case INSERT_CREDIT_LOG_SQL:
        creditLog.push({ balance: Number(values[0]), source: String(values[1]) });
        return [];

      case ACTIVE_SUBSCRIPTIONS_SQL:
        return [...flights.values()]
          .filter((f) => f.archived_at === null && f.alert_subscription_id !== null)
          .map((f) => ({
            id: f.id,
            alert_subscription_id: f.alert_subscription_id,
            alert_subscribed_at: f.alert_subscribed_at,
          }));

      case DETACH_SUBSCRIPTION_SQL: {
        const f = requireFlight(values[0]);
        if (!f || f.alert_subscription_id !== values[1] || f.archived_at !== null) return [];
        f.alert_subscription_id = null;
        f.alert_subscribed_at = null;
        f.next_poll_at = now.toISOString();
        return [{ id: f.id }];
      }
    }

    throw new Error(`memoryDb: unsupported statement: ${text.slice(0, 80)}`);
  }

  function queryFor(clientId: number) {
    return async (config: unknown, maybeValues?: unknown): Promise<{ rows: Row[]; rowCount: number }> => {
      const text = typeof config === 'string' ? config : (config as { text: string }).text;
      const values =
        typeof config === 'string'
          ? ((maybeValues ?? []) as readonly unknown[])
          : (((config as { values?: readonly unknown[] }).values ?? []) as readonly unknown[]);
      const rows = run(clientId, text, values);
      return { rows, rowCount: rows.length };
    };
  }

  const poolQuery = queryFor(0);
  const pool = {
    query: poolQuery,
    connect: async () => {
      const clientId = nextClientId;
      nextClientId += 1;
      return {
        query: queryFor(clientId),
        release: () => releaseLocks(clientId),
      };
    },
  } as unknown as Pool;

  return {
    pool,
    writer: createPgFlightsWriter(
      (text, values) => poolQuery(text, values) as unknown as Promise<{ rows: { id: string }[] }>,
    ),
    flights,
    events,
    inbox,
    creditLog,
    statements,
    setNow(next) {
      now = next;
    },
    addFlight(row) {
      flights.set(row.id, { ...row });
      return flights.get(row.id) as FlightRow;
    },
    flight(id) {
      const f = flights.get(id);
      if (f === undefined) throw new Error(`memoryDb: no flight ${id}`);
      return f;
    },
    addInbox(row) {
      const id = row.id ?? randomUUID();
      inbox.push({
        id,
        received_at: row.received_at ?? now.toISOString(),
        subscription_id: row.subscription_id,
        payload: row.payload,
        processed_at: null,
        attempts: row.attempts ?? 0,
        last_error: null,
      });
      return id;
    },
    failOn(text, error) {
      failures.set(text, error);
    },
  };
}
