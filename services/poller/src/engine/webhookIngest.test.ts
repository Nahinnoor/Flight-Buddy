import { createFeedHealthCache } from '@flightbuddy/flight-provider';
import type { FlightCandidate } from '@flightbuddy/shared';
import { describe, expect, it } from 'vitest';

import type { Pool } from '../db';
import { createMemoryDb } from './memoryDb';
import {
  CLAIM_INBOX_ROW_SQL,
  INBOX_MAX_ATTEMPTS,
  createInboxDrainer,
  drainWebhookInbox,
  type WebhookIngestDeps,
} from './webhookIngest';
import {
  DEFAULT_SUBSCRIPTION_ID as SUB,
  FAKE_WEBHOOK_TOKEN,
  alertEnvelope,
  b6FlightRow,
  captureLogger,
  countingLimiter,
  fixtureBody,
  fixtureCandidates,
  fixtureProvider,
  withDepartureGate,
  type AlertEnvelopeOptions,
  type FixtureProviderOptions,
} from './testFixtures';
import type { FlightRow } from './types';

const NOW = new Date('2026-09-11T20:00:00.000Z');
const FLIGHT = 'flight-b6';

type Legs = (legs: Record<string, unknown>[]) => Record<string, unknown>[];

const status =
  (value: string): Legs =>
  (legs) =>
    legs.map((leg) => ({ ...leg, status: value }));
/** Revised departure 45 minutes later than the capture's 01:59Z. */
const delayed45: Legs = (legs) =>
  legs.map((leg) => ({
    ...leg,
    departure: {
      ...(leg.departure as Record<string, unknown>),
      revisedTime: { utc: '2026-09-12 02:44Z', local: '2026-09-11 22:44-04:00' },
    },
  }));

interface Options {
  now?: Date;
  /** What a verification poll sees. */
  poll?: FixtureProviderOptions;
  webhooksEnabled?: boolean;
  /** ADR 0004's backup cadence, as `main.ts` passes it. `null` disables it. */
  backupMs?: number | null;
  batchSize?: number;
  row?: Partial<FlightRow>;
}

/** What the deployed worker runs with (`WEBHOOK_BACKUP_POLL_MS` default). */
const BACKUP_MS = 2 * 60 * 60_000;

function harness(options: Options = {}) {
  const now = options.now ?? NOW;
  const db = createMemoryDb({ now });
  db.addFlight(
    b6FlightRow({
      alert_subscription_id: SUB,
      alert_subscribed_at: '2026-09-11T02:00:00.000Z',
      ...options.row,
    }),
  );
  const fx = fixtureProvider('flights-number-live-today', { allLive: true, ...options.poll });
  const { limiter, count } = countingLimiter();
  const log = captureLogger();
  const deps: WebhookIngestDeps = {
    pool: db.pool,
    provider: fx.provider,
    writer: db.writer,
    rateLimiter: limiter,
    logger: log.logger,
    now: () => now,
    rng: () => 0.5,
    webhooksEnabled: options.webhooksEnabled ?? true,
    webhookBackupIntervalMs:
      options.backupMs === null ? undefined : (options.backupMs ?? BACKUP_MS),
    feedHealthCache: createFeedHealthCache(),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  };
  const deliver = (envelope: AlertEnvelopeOptions = {}, subscriptionId = SUB) =>
    db.addInbox({ subscription_id: subscriptionId, payload: alertEnvelope(envelope) });
  const drain = () => drainWebhookInbox(deps);
  return { db, fx, count, log, deps, deliver, drain };
}

describe('drainWebhookInbox — applying a delivery', () => {
  it('marks an unchanged delivery processed, logs the balance, and emits nothing', async () => {
    const h = harness();
    const inboxId = h.deliver();

    const summary = await h.drain();

    expect(summary).toMatchObject({ claimed: 1, processed: 1, events: 0 });
    expect(h.db.events).toEqual([]);
    expect(h.fx.lookups()).toHaveLength(0);
    expect(h.db.creditLog).toEqual([{ balance: 482, source: 'webhook_payload' }]);
    expect(h.db.inbox.find((r) => r.id === inboxId)).toMatchObject({
      attempts: 1,
      last_error: null,
      processed_at: NOW.toISOString(),
    });
    // Still subscribed, and still on ADR 0004's backup cadence rather than off the
    // ladder entirely: a later delivery lost to a cold start has to be noticed by
    // something, and inside the window this poll is the only thing that looks.
    // (`rng: () => 0.5` is the midpoint, so the jitter is zero.)
    expect(h.db.flight(FLIGHT)).toMatchObject({
      next_poll_at: new Date(NOW.getTime() + BACKUP_MS).toISOString(),
      poll_lease_until: null,
    });
  });

  it('takes the flight off the ladder only when the backup poll is disabled', async () => {
    const h = harness({ backupMs: null });
    const inboxId = h.deliver();

    await h.drain();

    expect(h.db.inbox.find((r) => r.id === inboxId)?.last_error).toBeNull();
    expect(h.db.flight(FLIGHT).next_poll_at).toBeNull();
  });

  it('ingests a delay straight from the webhook: no verification poll for delays', async () => {
    const h = harness();
    h.deliver({ mutate: delayed45 });

    const summary = await h.drain();

    expect(summary.outcomes[0]?.events).toEqual(['delay']);
    expect(h.db.events[0]).toMatchObject({
      event_type: 'delay',
      source: 'webhook',
      flight_id: FLIGHT,
    });
    expect(h.fx.lookups()).toHaveLength(0);
    expect(h.db.flight(FLIGHT).estimated_departure_utc).toBe('2026-09-12T02:44:00.000Z');
  });

  it('keeps the stored tracking tier: a delivery carries no feed health', async () => {
    const h = harness();
    h.deliver({ mutate: delayed45 });
    await h.drain();
    expect(h.db.flight(FLIGHT).tracking_tier).toBe('live');
  });

  it('does not log a balance when the delivery has none', async () => {
    const h = harness();
    h.deliver({ credits: null });
    await h.drain();
    expect(h.db.creditLog).toEqual([]);
  });

  it('schedules the landed + 30 min poll that unsubscribes and archives (§7.6)', async () => {
    const h = harness({ now: new Date('2026-09-12T07:00:00.000Z') });
    h.deliver({ mutate: status('Arrived') });

    const summary = await h.drain();

    expect(summary.outcomes[0]?.events).toEqual(['departed', 'landed']);
    expect(h.fx.lookups()).toHaveLength(0);
    expect(h.db.flight(FLIGHT).next_poll_at).toBe('2026-09-12T07:27:00.000Z');
  });

  it('puts the flight back on the ladder when webhooks are off', async () => {
    const h = harness({ webhooksEnabled: false });
    h.deliver();
    await h.drain();
    expect(h.db.flight(FLIGHT).next_poll_at).not.toBeNull();
  });
});

describe('ADR 0003 decision 1: gate changes and cancellations are confirmed by a poll', () => {
  it('confirms a gate change with one poll through the limiter, then emits it', async () => {
    const h = harness({ poll: { mutate: withDepartureGate('B99') } });
    h.deliver({ mutate: withDepartureGate('B99') });

    const summary = await h.drain();

    expect(summary.outcomes[0]).toMatchObject({ kind: 'processed', verifications: 1 });
    expect(h.fx.lookups()).toHaveLength(1);
    expect(h.fx.lookups()[0]?.url).toContain('/flights/number/B61411/2026-09-11');
    expect(h.count()).toBe(1);
    expect(h.db.events).toHaveLength(1);
    expect(h.db.events[0]).toMatchObject({
      event_type: 'gate_change',
      source: 'webhook',
      new_value: { gate: 'B99', terminal: '5' },
    });
    expect(h.db.flight(FLIGHT).gate).toBe('B99');
  });

  it('trusts the poll when it reports a different gate', async () => {
    const h = harness({ poll: { mutate: withDepartureGate('C12') } });
    h.deliver({ mutate: withDepartureGate('B99') });

    await h.drain();

    expect(h.db.events.map((e) => e.new_value)).toEqual([{ gate: 'C12', terminal: '5' }]);
    expect(h.db.flight(FLIGHT).gate).toBe('C12');
  });

  it('trusts the poll when it reports no gate change at all: nothing is emitted', async () => {
    const h = harness(); // the capture has no departure gate
    h.deliver({ mutate: withDepartureGate('B99') });

    await h.drain();

    expect(h.db.events).toEqual([]);
    expect(h.db.flight(FLIGHT).gate).toBeNull();
  });

  it('drops a cancellation the poll does not confirm', async () => {
    const h = harness();
    h.deliver({ mutate: status('Canceled') });

    await h.drain();

    expect(h.fx.lookups()).toHaveLength(1);
    expect(h.db.events).toEqual([]);
    expect(h.db.flight(FLIGHT).status).toBe('scheduled');
  });

  it('emits a cancellation the poll confirms', async () => {
    const h = harness({ poll: { mutate: status('Canceled') } });
    h.deliver({ mutate: status('Canceled') });

    await h.drain();

    expect(h.db.events.map((e) => [e.event_type, e.source])).toEqual([['cancelled', 'webhook']]);
  });

  it('counts a failed verification poll as an attempt and changes nothing', async () => {
    const h = harness({ poll: { flightsStatus: 500 } });
    const inboxId = h.deliver({ mutate: withDepartureGate('B99') });

    const summary = await h.drain();

    expect(summary).toMatchObject({ failed: 1, processed: 0 });
    expect(h.db.inbox.find((r) => r.id === inboxId)).toMatchObject({
      attempts: 1,
      last_error: 'ProviderError',
      processed_at: null,
    });
    expect(h.db.events).toEqual([]);
    expect(h.db.creditLog).toEqual([]);
    expect(h.db.flight(FLIGHT)).toMatchObject({ gate: null, poll_lease_until: null });
  });

  it('records a leg the verification poll cannot find as its own error class', async () => {
    const h = harness({ poll: { flightsStatus: 204 } });
    const inboxId = h.deliver({ mutate: withDepartureGate('B99') });

    await h.drain();

    expect(h.db.inbox.find((r) => r.id === inboxId)?.last_error).toBe(
      'VerificationLegMissingError',
    );
  });

  it(`gives up after ${INBOX_MAX_ATTEMPTS} attempts: processed, logged, never retried`, async () => {
    const h = harness({ poll: { flightsStatus: 500 } });
    const inboxId = h.deliver({ mutate: withDepartureGate('B99') });

    for (let i = 1; i < INBOX_MAX_ATTEMPTS; i += 1) {
      await h.drain();
      expect(h.db.inbox.find((r) => r.id === inboxId)?.processed_at).toBeNull();
    }
    const last = await h.drain();

    expect(last.abandoned).toBe(1);
    expect(h.db.inbox.find((r) => r.id === inboxId)).toMatchObject({
      attempts: INBOX_MAX_ATTEMPTS,
      processed_at: NOW.toISOString(),
    });
    expect(h.log.records().some((r) => r.level === 'error' && r.inboxId === inboxId)).toBe(true);
    expect((await h.drain()).claimed).toBe(0);
  });
});

describe('drainWebhookInbox — what is never applied', () => {
  it('drops a delivery for an unknown subscription without touching anything', async () => {
    const other = '0b9e7a44-2222-4c3d-8e66-3f3c8f5b0d12';
    const h = harness();
    const inboxId = h.deliver({ subscriptionId: other }, other);

    const summary = await h.drain();

    expect(summary.unknownSubscription).toBe(1);
    expect(h.db.inbox.find((r) => r.id === inboxId)).toMatchObject({
      processed_at: NOW.toISOString(),
      last_error: 'UnknownSubscription',
    });
    expect(h.db.creditLog).toEqual([]);
    expect(h.fx.requests).toHaveLength(0);
    expect(h.log.records().find((r) => r.inboxId === inboxId)?.msg).toContain(
      'unknown subscription',
    );
  });

  it('treats a subscription held only by an archived flight as unknown', async () => {
    const h = harness({ row: { archived_at: '2026-09-10T00:00:00.000Z' } });
    h.deliver();
    expect((await h.drain()).unknownSubscription).toBe(1);
  });

  it('re-validates the envelope: a body off the contract is closed at once, not retried', async () => {
    const h = harness();
    const inboxId = h.db.addInbox({
      subscription_id: SUB,
      payload: { ...alertEnvelope(), flights: 'not-an-array' },
    });

    const summary = await h.drain();

    expect(summary.invalid).toBe(1);
    expect(h.db.inbox.find((r) => r.id === inboxId)).toMatchObject({
      attempts: 1,
      last_error: 'InvalidPayload',
      processed_at: NOW.toISOString(),
    });
    expect(h.db.flight(FLIGHT).updated_at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('closes a real-shaped delivery it cannot read: reason code, payload kept, no provider call', async () => {
    // The shape the receiver stores, with a `status` of a JSON type that is
    // neither of the provider's two enum encodings (string name, integer). The
    // worker must not guess: it closes the row once and keeps the payload.
    const h = harness();
    const base = alertEnvelope({ mutate: status('Departed') });
    const payload = {
      ...base,
      id: '0d6f3b1c-7a2e-4f55-9b1d-6c8e2a4f7b30',
      timestampUtc: '2026-09-11 20:00Z',
      deliveryAttempt: 0,
      flights: (base.flights as Record<string, unknown>[]).map((leg) => ({
        ...leg,
        status: { value: 2 },
        codeshareStatus: 1,
      })),
    };
    const kept = JSON.parse(JSON.stringify(payload)) as unknown;
    const inboxId = h.db.addInbox({ subscription_id: SUB, payload });

    const first = await h.drain();
    const second = await h.drain();

    expect(first).toMatchObject({ claimed: 1, invalid: 1, processed: 0, failed: 0 });
    // Closed, so the next pass does not claim it again: one attempt, not five.
    expect(second.claimed).toBe(0);
    const row = h.db.inbox.find((r) => r.id === inboxId);
    expect(row).toMatchObject({
      attempts: 1,
      last_error: 'InvalidPayload',
      processed_at: NOW.toISOString(),
    });
    expect(row?.payload).toEqual(kept);
    // No provider call of any kind, no limiter slot, no flight write, no event.
    expect(h.fx.requests).toHaveLength(0);
    expect(h.count()).toBe(0);
    expect(h.db.events).toEqual([]);
    expect(h.db.creditLog).toEqual([]);
    expect(h.db.flight(FLIGHT).updated_at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('strips an unknown envelope key and applies the delivery', async () => {
    const h = harness();
    const inboxId = h.db.addInbox({
      subscription_id: SUB,
      payload: { ...alertEnvelope(), injected: 'x' },
    });

    const summary = await h.drain();

    expect(summary.processed).toBe(1);
    expect(h.db.inbox.find((r) => r.id === inboxId)?.last_error).toBeNull();
  });

  it('rejects an envelope whose subscription differs from its inbox row', async () => {
    const h = harness();
    h.db.addInbox({
      subscription_id: '0b9e7a44-2222-4c3d-8e66-3f3c8f5b0d12',
      payload: alertEnvelope(),
    });
    expect((await h.drain()).invalid).toBe(1);
    expect(h.db.flight(FLIGHT).updated_at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('ignores a leg for a date nobody tracks (a subscription fires for every date)', async () => {
    const h = harness();
    h.deliver({
      mutate: (legs) =>
        legs.map((leg) => ({
          ...leg,
          departure: {
            ...(leg.departure as Record<string, unknown>),
            scheduledTime: { utc: '2026-09-13 01:59Z', local: '2026-09-12 21:59-04:00' },
            revisedTime: { utc: '2026-09-13 01:59Z', local: '2026-09-12 21:59-04:00' },
          },
        })),
    });

    const inboxId = h.db.inbox[0]?.id;
    const summary = await h.drain();

    expect(summary.outcomes[0]).toMatchObject({ kind: 'no_tracked_leg', flightIds: [] });
    expect(summary.noTrackedLeg).toBe(1);
    expect(h.db.inbox.find((r) => r.id === inboxId)?.last_error).toBe('NoTrackedLeg');
    expect(h.db.flight(FLIGHT).updated_at).toBe('2026-09-01T00:00:00.000Z');
    expect(h.db.flights.size).toBe(1); // and certainly no new row for that date
  });
});

describe('drainWebhookInbox — matching and scheduling', () => {
  it('applies each leg of a shared multi-leg subscription to its own row, never [0]', async () => {
    const legs = await fixtureCandidates('flights-number-multileg', {
      flightNumber: 'AS65',
      dateLocal: '2026-09-15',
    });
    const rowFor = (leg: FlightCandidate, id: string) =>
      b6FlightRow({
        id,
        operating_carrier_iata: leg.operatingCarrierIata,
        operating_flight_number: leg.operatingFlightNumber,
        departure_date_local: leg.departureDateLocal,
        origin_iata: leg.originIata,
        destination_iata: leg.destinationIata,
        origin_tz: leg.originTz,
        destination_tz: leg.destinationTz,
        status: leg.status,
        gate: leg.gate,
        terminal: leg.terminal,
        scheduled_departure_utc: leg.scheduledDepartureUtc,
        estimated_departure_utc: leg.estimatedDepartureUtc,
        actual_departure_utc: leg.actualDepartureUtc,
        scheduled_arrival_utc: leg.scheduledArrivalUtc,
        estimated_arrival_utc: leg.estimatedArrivalUtc,
        actual_arrival_utc: leg.actualArrivalUtc,
        alert_subscription_id: SUB,
      });

    const h = harness({ row: { alert_subscription_id: null } });
    h.db.addFlight(rowFor(legs[1] as FlightCandidate, 'as65-leg-2'));
    h.db.addFlight(rowFor(legs[3] as FlightCandidate, 'as65-leg-4'));
    h.deliver({ fixture: 'flights-number-multileg' });

    const summary = await h.drain();

    expect([...(summary.outcomes[0]?.flightIds ?? [])].sort()).toEqual([
      'as65-leg-2',
      'as65-leg-4',
    ]);
    expect(h.db.events).toEqual([]);
    const applied = h.log.records().find((r) => r.msg === 'webhook delivery applied');
    expect(applied).toMatchObject({ ignoredLegs: legs.length - 2 });
  });

  it('defers a delivery whose flight a poll is holding, then applies it once released', async () => {
    const h = harness({
      row: { poll_lease_until: new Date(NOW.getTime() + 60_000).toISOString() },
    });
    const inboxId = h.deliver({ mutate: delayed45 });

    const first = await h.drain();
    expect(first.deferred).toBe(1);
    expect(h.db.inbox.find((r) => r.id === inboxId)).toMatchObject({
      attempts: 0,
      processed_at: null,
    });
    expect(h.db.events).toEqual([]);

    h.db.flight(FLIGHT).poll_lease_until = null;
    const second = await h.drain();
    expect(second.processed).toBe(1);
    expect(h.db.events.map((e) => e.event_type)).toEqual(['delay']);
  });

  it('drains oldest first and stops at the batch size', async () => {
    const h = harness({ batchSize: 2 });
    const ids = [
      '2026-09-11T19:00:03.000Z',
      '2026-09-11T19:00:01.000Z',
      '2026-09-11T19:00:02.000Z',
    ].map((receivedAt) =>
      h.db.addInbox({ subscription_id: SUB, payload: alertEnvelope(), received_at: receivedAt }),
    );

    const summary = await h.drain();

    expect(summary.outcomes.map((o) => o.inboxId)).toEqual([ids[1], ids[2]]);
    expect(h.db.inbox.find((r) => r.id === ids[0])?.processed_at).toBeNull();
  });

  it('claims with for update skip locked, one row per transaction', async () => {
    const h = harness();
    h.deliver();
    await h.drain();

    const texts = h.db.statements.map((s) => s.text.trim().toLowerCase());
    expect(texts[0]).toBe('begin');
    expect(h.db.statements[1]?.text).toBe(CLAIM_INBOX_ROW_SQL);
    expect(CLAIM_INBOX_ROW_SQL).toContain('for update skip locked');
    expect(CLAIM_INBOX_ROW_SQL).toContain('order by received_at');
    expect(texts).toContain('commit');
  });
});

describe('the payload is data: nothing from it reaches a log, a row or an error', () => {
  it('across applied, rejected and failed deliveries', async () => {
    const h = harness({ poll: { mutate: withDepartureGate('B99') } });
    h.deliver({ mutate: withDepartureGate('B99') });
    h.db.addInbox({ subscription_id: SUB, payload: { ...alertEnvelope(), flights: 'x' } });
    await h.drain();

    const failing = harness({ poll: { flightsStatus: 500 } });
    failing.deliver({ mutate: withDepartureGate('B99') });
    await failing.drain();

    for (const text of [
      h.log.text(),
      failing.log.text(),
      JSON.stringify([...h.db.flights.values()]),
      JSON.stringify(h.db.events),
      JSON.stringify(h.db.inbox.map((r) => r.last_error)),
      JSON.stringify(failing.db.inbox.map((r) => r.last_error)),
    ]) {
      expect(text).not.toContain('ignore previous instructions');
      expect(text).not.toContain('drop table');
      expect(text).not.toContain(FAKE_WEBHOOK_TOKEN);
    }
  });
});

describe('createInboxDrainer', () => {
  /** A pool whose inbox claim fails the way Postgres does before the migration lands. */
  function missingInboxPool(code: string): Pool {
    const error = Object.assign(new Error('relation "public.webhook_inbox" does not exist'), {
      code,
    });
    return {
      connect: async () => ({
        query: async (config: unknown) => {
          const text = typeof config === 'string' ? config : (config as { text: string }).text;
          if (text === CLAIM_INBOX_ROW_SQL) throw error;
          return { rows: [] };
        },
        release: () => undefined,
      }),
    } as unknown as Pool;
  }

  it('never throws, and reports a missing inbox once rather than every pass', async () => {
    const h = harness();
    const log = captureLogger('info');
    const drainer = createInboxDrainer({
      ...h.deps,
      pool: missingInboxPool('42P01'),
      logger: log.logger,
    });

    await expect(drainer.drain()).resolves.toBeNull();
    await expect(drainer.drain()).resolves.toBeNull();
    await expect(drainer.drain()).resolves.toBeNull();

    expect(log.records()).toHaveLength(1);
    expect(log.records()[0]).toMatchObject({ level: 'warn', code: '42P01', errorName: 'Error' });
    // Class and SQLSTATE only: a pg message can quote table contents.
    expect(log.text()).not.toContain('does not exist');
  });

  it('says so when the inbox comes back', async () => {
    const h = harness();
    const log = captureLogger('info');
    let pool = missingInboxPool('42501');
    const drainer = createInboxDrainer({
      ...h.deps,
      get pool() {
        return pool;
      },
      logger: log.logger,
    });

    await drainer.drain();
    pool = h.db.pool;
    await expect(drainer.drain()).resolves.toMatchObject({ claimed: 0 });

    expect(log.records().map((r) => r.msg)).toContain('webhook inbox reachable again');
  });
});

describe('the real capture: webhook-delivery-real-enroute.json (DL1915, 2026-09-18 occurrence)', () => {
  const REAL_SUB = '00000000-0000-4000-8000-000000000002';
  const TRACKED = 'flight-dl1915';

  /** The row the owner tracks: DL1915 JFK→LAX on the 19th, subscribed. */
  function dl1915Row(overrides: Partial<FlightRow> = {}): FlightRow {
    return b6FlightRow({
      id: TRACKED,
      operating_carrier_iata: 'DL',
      operating_flight_number: '1915',
      departure_date_local: '2026-09-19',
      origin_iata: 'JFK',
      destination_iata: 'LAX',
      origin_tz: 'America/New_York',
      destination_tz: 'America/Los_Angeles',
      status: 'scheduled',
      tracking_tier: 'live',
      terminal: '4',
      scheduled_departure_utc: '2026-09-19T23:00:00.000Z',
      estimated_departure_utc: null,
      scheduled_arrival_utc: '2026-09-20T05:10:00.000Z',
      estimated_arrival_utc: null,
      aircraft_reg: null,
      aircraft_model: null,
      alert_subscription_id: REAL_SUB,
      alert_subscribed_at: '2026-09-18T23:05:00.000Z',
      ...overrides,
    });
  }

  function realHarness(row: FlightRow) {
    const now = new Date('2026-09-18T23:21:30.000Z');
    const db = createMemoryDb({ now });
    db.addFlight(row);
    const fx = fixtureProvider('flights-number-live-today', { allLive: true });
    const { limiter, count } = countingLimiter();
    const log = captureLogger();
    const deps: WebhookIngestDeps = {
      pool: db.pool,
      provider: fx.provider,
      writer: db.writer,
      rateLimiter: limiter,
      logger: log.logger,
      now: () => now,
      rng: () => 0.5,
      webhooksEnabled: true,
      feedHealthCache: createFeedHealthCache(),
    };
    const payload = JSON.parse(fixtureBody('webhook-delivery-real-enroute')) as unknown;
    const inboxId = db.addInbox({ subscription_id: REAL_SUB, payload });
    return { db, fx, count, log, inboxId, now, drain: () => drainWebhookInbox(deps) };
  }

  it("ignores another day's occurrence: no ingest, no new flight row, no events, reason code", async () => {
    // Exactly what reached the inbox: the subscription fired for the 18th's
    // flight while the tracked row is the 19th's (§7.6: keyed by number, no date).
    const h = realHarness(dl1915Row());
    const before = { ...h.db.flight(TRACKED) };

    const summary = await h.drain();

    expect(summary).toMatchObject({
      claimed: 1,
      noTrackedLeg: 1,
      processed: 0,
      invalid: 0,
      failed: 0,
    });
    expect(summary.outcomes[0]).toMatchObject({
      kind: 'no_tracked_leg',
      flightIds: [],
      events: [],
    });
    // No `ingestFlight`: no row for 2026-09-18 appeared, and the tracked row is untouched.
    expect(h.db.flights.size).toBe(1);
    expect(h.db.flight(TRACKED)).toEqual(before);
    expect(h.db.events).toEqual([]);
    // No provider call, no limiter slot.
    expect(h.fx.requests).toHaveLength(0);
    expect(h.count()).toBe(0);
    // Closed once, with the reason; the billed balance is still recorded.
    expect(h.db.inbox.find((r) => r.id === h.inboxId)).toMatchObject({
      attempts: 1,
      last_error: 'NoTrackedLeg',
      processed_at: h.now.toISOString(),
    });
    expect(h.db.creditLog).toEqual([{ balance: 65, source: 'webhook_payload' }]);
    const line = h.log.records().find((r) => r.inboxId === h.inboxId);
    expect(line).toMatchObject({ ignoredLegs: 1, unmappedLegs: 0 });
    expect((await h.drain()).claimed).toBe(0);
  });

  it('end to end: when the delivered day is the tracked one, it maps to en_route and is applied', async () => {
    const h = realHarness(
      dl1915Row({
        departure_date_local: '2026-09-18',
        scheduled_departure_utc: '2026-09-18T23:00:00.000Z',
        scheduled_arrival_utc: '2026-09-19T05:10:00.000Z',
      }),
    );

    const summary = await h.drain();

    expect(summary).toMatchObject({ claimed: 1, processed: 1, invalid: 0 });
    expect(summary.outcomes[0]?.flightIds).toEqual([TRACKED]);
    expect(h.db.flights.size).toBe(1);
    expect(h.db.flight(TRACKED)).toMatchObject({
      status: 'en_route',
      actual_departure_utc: '2026-09-18T23:20:00.000Z',
      estimated_arrival_utc: '2026-09-19T04:26:00.000Z',
      tracking_tier: 'live',
    });
    expect(h.db.events.map((e) => [e.event_type, e.source])).toContainEqual([
      'departed',
      'webhook',
    ]);
    // Departed is not a verified event type: no poll was made.
    expect(h.fx.requests).toHaveLength(0);
    expect(h.db.inbox.find((r) => r.id === h.inboxId)?.last_error).toBeNull();
  });

  it('an out-of-table status changes nothing: the stored status stands, no event is written', async () => {
    // The review's case: a cancelled flight must not bounce through `unknown`,
    // or the next genuine `cancelled` would emit a second cancellation event.
    const h = realHarness(
      dl1915Row({
        departure_date_local: '2026-09-18',
        scheduled_departure_utc: '2026-09-18T23:00:00.000Z',
        status: 'cancelled',
      }),
    );
    const before = structuredClone(h.db.flight(TRACKED));
    const row = h.db.inbox.find((r) => r.id === h.inboxId);
    const payload = row?.payload as { flights: Record<string, unknown>[] };
    payload.flights = payload.flights.map((leg) => ({ ...leg, status: 4242 }));

    await h.drain();

    const warn = h.log.records().find((r) => r.level === 'warn' && r.inboxId === h.inboxId);
    expect(warn).toMatchObject({ fields: ['flights[0].status'] });
    expect(h.log.text()).not.toContain('4242');
    expect(h.db.flight(TRACKED)).toEqual(before);
    expect(h.db.flight(TRACKED).status).toBe('cancelled');
    expect(h.db.events).toHaveLength(0);
    expect(h.db.inbox.find((r) => r.id === h.inboxId)?.last_error).toBe('UnmappableLeg');
  });

  it('an out-of-table codeshare or quality code still degrades and applies (it drives no event)', async () => {
    const h = realHarness(
      dl1915Row({
        departure_date_local: '2026-09-18',
        scheduled_departure_utc: '2026-09-18T23:00:00.000Z',
      }),
    );
    const row = h.db.inbox.find((r) => r.id === h.inboxId);
    const payload = row?.payload as { flights: Record<string, unknown>[] };
    payload.flights = payload.flights.map((leg) => ({ ...leg, codeshareStatus: 4242 }));

    await h.drain();

    expect(h.log.text()).not.toContain('4242');
    expect(h.db.flight(TRACKED).status).toBe('en_route');
  });
});
