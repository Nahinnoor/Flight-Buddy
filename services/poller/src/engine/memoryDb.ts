/**
 * Test support: a small stateful stand-in for the worker's slice of Postgres.
 *
 * `fakePool.ts` records statements and replays queued results, which proves what
 * SQL is sent but cannot prove what happens when two paths touch the same row —
 * and that is the whole of criterion 8 (poll/webhook race). This fake keeps real
 * state for `flights`, `flight_events`, `webhook_inbox`, `provider_credit_log`, and
 * (wave 5) `notification_deliveries` with the recipient tables it joins,
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
import { pushTokenSha256 } from '../push/tokens';
import { READ_OPERATOR_TOKEN_SQL } from '../push/operatorAlerts';
import { FINALIZE_RECEIPTS_SQL, SELECT_AWAITING_RECEIPTS_SQL } from '../push/pushReceipts';
import {
  CLAIM_DELIVERIES_SQL,
  CLEAR_DEAD_TOKEN_SQL,
  CLOSE_EXHAUSTED_SENDS_SQL,
  FINALIZE_SENDS_SQL,
  LOAD_DELIVERY_FACTS_SQL,
} from '../push/pushSend';
import { DISARMED_THRESHOLDS_SQL, FAILOVER_SUBSCRIBED_FLIGHTS_SQL } from './creditMonitor';
import { CLAIM_DUE_FLIGHTS_SQL, RELEASE_LEASE_SQL } from './lease';
import { ACTIVE_SUBSCRIPTIONS_SQL, DETACH_SUBSCRIPTION_SQL } from './reconcile';
import {
  INSERT_CREDIT_LOG_SQL,
  LATEST_CREDIT_BALANCE_SQL,
  RECORD_POLL_FAILURE_SQL,
  RECORD_POLL_SUCCESS_SQL,
} from './repository';
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
  detected_at: string;
}

/** A `notification_deliveries` row with the wave 5 columns. */
export interface MemoryDelivery {
  id: string;
  flight_event_id: string;
  user_id: string;
  recipient_reason: string;
  status: string;
  error: string | null;
  sent_at: string | null;
  created_at: string;
  attempts: number;
  not_before: string | null;
  claimed_until: string | null;
  expo_ticket_id: string | null;
  push_token_sha256: string | null;
  receipt_checked_at: string | null;
}

export interface MemorySegment {
  id: string;
  trip_id: string;
  flight_id: string;
  marketing_carrier_iata: string | null;
  marketing_flight_number: string | null;
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
  /**
   * `provider_credit_log`, in insertion order — the array index stands in for the
   * `bigserial` id. Push to it directly to seed earlier readings.
   */
  creditLog: { balance: number; source: string }[];
  statements: { text: string; values: readonly unknown[] }[];
  /** `profiles(id, expo_push_token)`: the only profile columns the worker can see. */
  profiles: Map<string, { id: string; expo_push_token: string | null }>;
  travelers: Map<string, { id: string; user_id: string | null }>;
  trips: Map<string, { id: string; traveler_id: string }>;
  segments: MemorySegment[];
  deliveries: MemoryDelivery[];
  /**
   * A traveller with one trip holding `flightIds`. `userId: null` is an unclaimed
   * traveller (§3.4); otherwise a profile is created with `token`.
   */
  addTraveller(options: {
    userId: string | null;
    flightIds: string[];
    token?: string | null;
    marketing?: { carrier: string; number: string };
  }): { travelerId: string; tripId: string };
  setNow(now: Date): void;
  addFlight(row: FlightRow): FlightRow;
  flight(id: string): FlightRow;
  addInbox(row: {
    subscription_id: string;
    payload: unknown;
    id?: string;
    received_at?: string;
    attempts?: number;
  }): string;
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
  const profiles = new Map<string, { id: string; expo_push_token: string | null }>();
  const travelers = new Map<string, { id: string; user_id: string | null }>();
  const trips = new Map<string, { id: string; traveler_id: string }>();
  const segments: MemorySegment[] = [];
  const deliveries: MemoryDelivery[] = [];
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

  /** The owners (user ids) of every trip holding `flightId`, claimed travellers only. */
  function ownRecipients(flightId: string): string[] {
    const users = new Set<string>();
    for (const segment of segments) {
      if (segment.flight_id !== flightId) continue;
      const trip = trips.get(segment.trip_id);
      const traveler = trip === undefined ? undefined : travelers.get(trip.traveler_id);
      if (traveler?.user_id) users.add(traveler.user_id);
    }
    return [...users];
  }

  /** `buildInsertEventsSql`: events, then the §9 fan-out, as the SQL does it. */
  function insertEventsAndFanOut(values: readonly unknown[]): Row[] {
    const eventValues = values.slice(0, values.length - 2);
    const notify = values[values.length - 2] as string[];
    const once = values[values.length - 1] as string[];
    const inserted: MemoryEvent[] = [];
    for (let i = 0; i < eventValues.length; i += 5) {
      const event: MemoryEvent = {
        id: randomUUID(),
        flight_id: String(eventValues[i]),
        event_type: String(eventValues[i + 1]),
        previous_value: eventValues[i + 2] === null ? null : JSON.parse(String(eventValues[i + 2])),
        new_value: JSON.parse(String(eventValues[i + 3])),
        source: String(eventValues[i + 4]),
        detected_at: now.toISOString(),
      };
      inserted.push(event);
    }

    // Snapshot semantics: the once-per-flight check sees deliveries from before
    // this statement only, as a CTE does.
    const before = [...deliveries];
    const eventsBefore = [...events];
    let created = 0;
    for (const event of inserted) {
      if (!notify.includes(event.event_type)) continue;
      for (const userId of ownRecipients(event.flight_id)) {
        if (once.includes(event.event_type)) {
          const already = before.some((d) => {
            const e = eventsBefore.find((candidate) => candidate.id === d.flight_event_id);
            return (
              d.user_id === userId &&
              e !== undefined &&
              e.flight_id === event.flight_id &&
              e.event_type === event.event_type
            );
          });
          if (already) continue;
        }
        if (deliveries.some((d) => d.flight_event_id === event.id && d.user_id === userId))
          continue;
        deliveries.push({
          id: randomUUID(),
          flight_event_id: event.id,
          user_id: userId,
          recipient_reason: 'own_flight',
          status: 'pending',
          error: null,
          sent_at: null,
          created_at: now.toISOString(),
          attempts: 0,
          not_before: null,
          claimed_until: null,
          expo_ticket_id: null,
          push_token_sha256: null,
          receipt_checked_at: null,
        });
        created += 1;
      }
    }
    events.push(...inserted);
    return inserted.map((event) => ({ id: event.id, deliveries: created }));
  }

  function unnestRows(values: readonly unknown[], names: readonly string[]): Row[] {
    const columns = values.slice(0, names.length) as unknown[][];
    return (columns[0] ?? []).map((_, index) => {
      const row: Row = {};
      names.forEach((name, column) => {
        row[name] = columns[column]?.[index] ?? null;
      });
      return row;
    });
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

    if (text.startsWith('with inserted as (\ninsert into public.flight_events')) {
      return insertEventsAndFanOut(values);
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
          .sort(
            (a, b) =>
              (millis(a.alert_subscribed_at) ?? Infinity) -
              (millis(b.alert_subscribed_at) ?? Infinity),
          )[0];
        return holder === undefined
          ? []
          : [{ alert_subscription_id: holder.alert_subscription_id }];
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
          (f) =>
            f.alert_subscription_id === subscriptionId &&
            f.archived_at === null &&
            f.id !== exclude,
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
          {
            id: row.id,
            subscription_id: row.subscription_id,
            payload: row.payload,
            attempts: row.attempts,
          },
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

      case LATEST_CREDIT_BALANCE_SQL: {
        const last = creditLog.at(-1);
        return last === undefined ? [] : [{ balance: last.balance }];
      }

      case DISARMED_THRESHOLDS_SQL: {
        const [marks, source] = values as [number[], string];
        return marks
          .filter((mark) => {
            let rearmedAt = -1;
            creditLog.forEach((row, index) => {
              if (row.balance > mark) rearmedAt = index;
            });
            return creditLog.some(
              (row, index) => index > rearmedAt && row.source === source && row.balance <= mark,
            );
          })
          .map((mark) => ({ mark }));
      }

      case FAILOVER_SUBSCRIBED_FLIGHTS_SQL: {
        const ceiling = nowMs() + Number(values[0]);
        const swept = [...flights.values()].filter(
          (f) =>
            f.archived_at === null &&
            f.alert_subscription_id !== null &&
            (f.next_poll_at === null || (millis(f.next_poll_at) as number) > ceiling),
        );
        for (const f of swept) f.next_poll_at = now.toISOString();
        return swept.map((f) => ({ id: f.id }));
      }

      case CLOSE_EXHAUSTED_SENDS_SQL: {
        const closed = deliveries.filter(
          (d) =>
            d.status === 'sending' &&
            d.claimed_until !== null &&
            (millis(d.claimed_until) as number) < nowMs() &&
            d.attempts >= Number(values[0]),
        );
        for (const d of closed) {
          d.status = 'failed';
          d.error = String(values[1]);
          d.claimed_until = null;
        }
        return closed.map((d) => ({ id: d.id }));
      }

      case CLAIM_DELIVERIES_SQL: {
        const [limit, leaseMs, maxAttempts] = values as [number, number, number];
        const claimable = deliveries
          .filter(
            (d) =>
              d.attempts < maxAttempts &&
              ((d.status === 'pending' &&
                (d.not_before === null || (millis(d.not_before) as number) <= nowMs())) ||
                (d.status === 'sending' &&
                  d.claimed_until !== null &&
                  (millis(d.claimed_until) as number) < nowMs())),
          )
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
          .slice(0, limit);
        for (const d of claimable) {
          d.status = 'sending';
          d.attempts += 1;
          d.claimed_until = new Date(nowMs() + leaseMs).toISOString();
        }
        return claimable.map((d) => ({ id: d.id }));
      }

      case LOAD_DELIVERY_FACTS_SQL: {
        const ids = values[0] as string[];
        return deliveries
          .filter((d) => ids.includes(d.id) && d.status === 'sending')
          .flatMap((d) => {
            const event = events.find((e) => e.id === d.flight_event_id);
            const flight = event === undefined ? undefined : flights.get(event.flight_id);
            if (event === undefined || flight === undefined) return [];
            const profile = profiles.get(d.user_id);
            const segment = segments
              .filter((s) => {
                if (s.flight_id !== flight.id) return false;
                const trip = trips.get(s.trip_id);
                const traveler = trip === undefined ? undefined : travelers.get(trip.traveler_id);
                return traveler?.user_id === d.user_id;
              })
              .sort((a, b) => a.id.localeCompare(b.id))[0];
            return [
              {
                delivery_id: d.id,
                user_id: d.user_id,
                attempts: d.attempts,
                event_id: event.id,
                event_type: event.event_type,
                previous_value: event.previous_value,
                new_value: event.new_value,
                detected_at: event.detected_at,
                flight_id: flight.id,
                operating_carrier_iata: flight.operating_carrier_iata,
                operating_flight_number: flight.operating_flight_number,
                origin_iata: flight.origin_iata,
                destination_iata: flight.destination_iata,
                origin_tz: flight.origin_tz,
                destination_tz: flight.destination_tz,
                departure_date_local: flight.departure_date_local,
                status: flight.status,
                scheduled_departure_utc: flight.scheduled_departure_utc,
                estimated_departure_utc: flight.estimated_departure_utc,
                scheduled_arrival_utc: flight.scheduled_arrival_utc,
                estimated_arrival_utc: flight.estimated_arrival_utc,
                expo_push_token: profile?.expo_push_token ?? null,
                marketing_carrier_iata: segment?.marketing_carrier_iata ?? null,
                marketing_flight_number: segment?.marketing_flight_number ?? null,
              },
            ];
          });
      }

      case FINALIZE_SENDS_SQL: {
        for (const u of unnestRows(values, [
          'id',
          'status',
          'ticket_id',
          'token_sha256',
          'error',
          'not_before',
        ])) {
          const d = deliveries.find((row) => row.id === u.id);
          if (d === undefined || d.status !== 'sending') continue;
          d.status = String(u.status);
          d.expo_ticket_id = (u.ticket_id as string | null) ?? null;
          d.push_token_sha256 = (u.token_sha256 as string | null) ?? null;
          d.error = (u.error as string | null) ?? null;
          d.not_before = iso(u.not_before);
          if (d.status === 'sent') d.sent_at = now.toISOString();
          d.claimed_until = null;
        }
        return [];
      }

      case CLEAR_DEAD_TOKEN_SQL: {
        const profile = profiles.get(String(values[0]));
        if (
          profile === undefined ||
          profile.expo_push_token === null ||
          pushTokenSha256(profile.expo_push_token) !== values[1]
        ) {
          return [];
        }
        profile.expo_push_token = null;
        return [{ id: profile.id }];
      }

      case SELECT_AWAITING_RECEIPTS_SQL: {
        const [delayMs, limit] = values as [number, number];
        return deliveries
          .filter(
            (d) =>
              d.status === 'sent' &&
              d.expo_ticket_id !== null &&
              d.sent_at !== null &&
              (millis(d.sent_at) as number) <= nowMs() - delayMs &&
              (d.receipt_checked_at === null ||
                (millis(d.receipt_checked_at) as number) <= nowMs() - delayMs),
          )
          .sort(
            (a, b) => (a.sent_at ?? '').localeCompare(b.sent_at ?? '') || a.id.localeCompare(b.id),
          )
          .slice(0, limit)
          .map((d) => ({
            id: d.id,
            user_id: d.user_id,
            expo_ticket_id: d.expo_ticket_id,
            push_token_sha256: d.push_token_sha256,
            sent_at: d.sent_at,
            attempts: d.attempts,
            detected_at:
              events.find((e) => e.id === d.flight_event_id)?.detected_at ?? now.toISOString(),
          }));
      }

      case FINALIZE_RECEIPTS_SQL: {
        for (const u of unnestRows(values, ['id', 'status', 'error', 'not_before'])) {
          const d = deliveries.find((row) => row.id === u.id);
          if (d === undefined || d.status !== 'sent') continue;
          d.status = String(u.status);
          d.error = (u.error as string | null) ?? null;
          d.not_before = iso(u.not_before);
          if (d.status === 'pending') d.expo_ticket_id = null;
          d.receipt_checked_at = now.toISOString();
        }
        return [];
      }

      case READ_OPERATOR_TOKEN_SQL: {
        const profile = profiles.get(String(values[0]));
        return profile === undefined ? [] : [{ expo_push_token: profile.expo_push_token }];
      }

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
    return async (
      config: unknown,
      maybeValues?: unknown,
    ): Promise<{ rows: Row[]; rowCount: number }> => {
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
    profiles,
    travelers,
    trips,
    segments,
    deliveries,
    addTraveller({ userId, flightIds, token = null, marketing }) {
      if (userId !== null && !profiles.has(userId)) {
        profiles.set(userId, { id: userId, expo_push_token: token });
      }
      const travelerId = randomUUID();
      travelers.set(travelerId, { id: travelerId, user_id: userId });
      const tripId = randomUUID();
      trips.set(tripId, { id: tripId, traveler_id: travelerId });
      for (const flightId of flightIds) {
        segments.push({
          id: randomUUID(),
          trip_id: tripId,
          flight_id: flightId,
          marketing_carrier_iata: marketing?.carrier ?? null,
          marketing_flight_number: marketing?.number ?? null,
        });
      }
      return { travelerId, tripId };
    },
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
