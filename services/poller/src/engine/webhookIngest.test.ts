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

const status = (value: string): Legs => (legs) => legs.map((leg) => ({ ...leg, status: value }));
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
  batchSize?: number;
  row?: Partial<FlightRow>;
}

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
    // Still subscribed and still off the ladder; lease handed back.
    expect(h.db.flight(FLIGHT)).toMatchObject({ next_poll_at: null, poll_lease_until: null });
  });

  it('ingests a delay straight from the webhook: no verification poll for delays', async () => {
    const h = harness();
    h.deliver({ mutate: delayed45 });

    const summary = await h.drain();

    expect(summary.outcomes[0]?.events).toEqual(['delay']);
    expect(h.db.events[0]).toMatchObject({ event_type: 'delay', source: 'webhook', flight_id: FLIGHT });
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

    expect(h.db.inbox.find((r) => r.id === inboxId)?.last_error).toBe('VerificationLegMissingError');
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
    expect(h.log.records().find((r) => r.inboxId === inboxId)?.msg).toContain('unknown subscription');
  });

  it('treats a subscription held only by an archived flight as unknown', async () => {
    const h = harness({ row: { archived_at: '2026-09-10T00:00:00.000Z' } });
    h.deliver();
    expect((await h.drain()).unknownSubscription).toBe(1);
  });

  it('re-validates the envelope: a body off the contract is dropped at once, not retried', async () => {
    const h = harness();
    const inboxId = h.db.addInbox({
      subscription_id: SUB,
      payload: { ...alertEnvelope(), injected: 'x' },
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

    const summary = await h.drain();

    expect(summary.outcomes[0]).toMatchObject({ kind: 'processed', flightIds: [] });
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

    expect([...(summary.outcomes[0]?.flightIds ?? [])].sort()).toEqual(['as65-leg-2', 'as65-leg-4']);
    expect(h.db.events).toEqual([]);
    const applied = h.log.records().find((r) => r.msg === 'webhook delivery applied');
    expect(applied).toMatchObject({ ignoredLegs: legs.length - 2 });
  });

  it('defers a delivery whose flight a poll is holding, then applies it once released', async () => {
    const h = harness({ row: { poll_lease_until: new Date(NOW.getTime() + 60_000).toISOString() } });
    const inboxId = h.deliver({ mutate: delayed45 });

    const first = await h.drain();
    expect(first.deferred).toBe(1);
    expect(h.db.inbox.find((r) => r.id === inboxId)).toMatchObject({ attempts: 0, processed_at: null });
    expect(h.db.events).toEqual([]);

    h.db.flight(FLIGHT).poll_lease_until = null;
    const second = await h.drain();
    expect(second.processed).toBe(1);
    expect(h.db.events.map((e) => e.event_type)).toEqual(['delay']);
  });

  it('drains oldest first and stops at the batch size', async () => {
    const h = harness({ batchSize: 2 });
    const ids = ['2026-09-11T19:00:03.000Z', '2026-09-11T19:00:01.000Z', '2026-09-11T19:00:02.000Z'].map(
      (receivedAt) =>
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
    h.db.addInbox({ subscription_id: SUB, payload: { ...alertEnvelope(), injected: 'x' } });
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
    const error = Object.assign(new Error('relation "public.webhook_inbox" does not exist'), { code });
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
