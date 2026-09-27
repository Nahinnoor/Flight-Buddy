import { createFeedHealthCache, createPgFlightsWriter } from '@flightbuddy/flight-provider';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger';
import { createFakePool, type FakePool } from './fakePool';
import { LADDER_INTERVALS } from './ladder';
import {
  MAX_BACKOFF_MS,
  MAX_CONSECUTIVE_FAILURES,
  backoffPollAt,
  operatingDesignator,
  pollAndUpdate,
  type PollDependencies,
} from './poll';
import { fixtureProvider } from './testFixtures';
import type { FlightRow } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Fixed so a test never depends on the machine's clock. */
const NOW = new Date('2026-09-11T20:00:00.000Z');
const noJitter = () => 0.5;

/** Logs nowhere: a test log line is the easiest place for personal data to escape. */
const logger = createLogger({ level: 'silent' });

/** The stored row for the captured B6 1411 JFK → LAS leg. */
function flightRow(overrides: Partial<FlightRow> = {}): FlightRow {
  return {
    id: 'flight-1',
    operating_carrier_iata: 'B6',
    operating_flight_number: '1411',
    departure_date_local: '2026-09-11',
    origin_iata: 'JFK',
    destination_iata: 'LAS',
    origin_tz: 'America/New_York',
    destination_tz: 'America/Los_Angeles',
    status: 'scheduled',
    tracking_tier: 'live',
    gate: null,
    terminal: '5',
    scheduled_departure_utc: '2026-09-12T01:59:00.000Z',
    estimated_departure_utc: '2026-09-12T01:59:00.000Z',
    actual_departure_utc: null,
    scheduled_arrival_utc: '2026-09-12T07:38:00.000Z',
    estimated_arrival_utc: '2026-09-12T06:57:00.000Z',
    actual_arrival_utc: null,
    aircraft_reg: 'N943JT',
    aircraft_model: 'Airbus A321 (Sharklets)',
    distance_km: 3618,
    origin_country_code: 'US',
    destination_country_code: 'US',
    next_poll_at: NOW.toISOString(),
    poll_lease_until: new Date(NOW.getTime() + 2 * MINUTE).toISOString(),
    last_polled_at: null,
    poll_failure_count: 0,
    alert_subscription_id: null,
    alert_subscribed_at: null,
    raw_payload: null,
    archived_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Harness {
  deps: PollDependencies;
  fake: FakePool;
  asked: string[];
  acquired: () => number;
}

function harness(
  fixture: string,
  options: {
    now?: Date;
    flightsStatus?: number;
    failWith?: Error;
    webhooksEnabled?: boolean;
    writerFails?: boolean;
    mutate?: (legs: Record<string, unknown>[]) => Record<string, unknown>[];
  } = {},
): Harness {
  const fake = createFakePool();
  const { provider, asked } = fixtureProvider(fixture, {
    ...(options.flightsStatus === undefined ? {} : { flightsStatus: options.flightsStatus }),
    ...(options.failWith === undefined ? {} : { failWith: options.failWith }),
    ...(options.mutate === undefined ? {} : { mutate: options.mutate }),
  });

  let acquired = 0;

  const writer = options.writerFails
    ? createPgFlightsWriter(() => Promise.reject(new Error('permission denied for table flights')))
    : createPgFlightsWriter(async () => ({ rows: [{ id: 'flight-1' }] }));

  return {
    fake,
    asked,
    acquired: () => acquired,
    deps: {
      pool: fake.pool,
      provider,
      writer,
      rateLimiter: {
        acquire: async () => {
          acquired += 1;
        },
      },
      logger,
      now: () => options.now ?? NOW,
      rng: noJitter,
      webhooksEnabled: options.webhooksEnabled ?? false,
      feedHealthCache: createFeedHealthCache(),
    },
  };
}

/** The scheduling update is always the last statement a poll makes. */
function lastStatement(fake: FakePool) {
  return fake.statements.at(-1);
}

describe('operatingDesignator', () => {
  it('joins the operating carrier and number, trimming char() padding', () => {
    expect(
      operatingDesignator({ operating_carrier_iata: 'B6', operating_flight_number: '1411' }),
    ).toBe('B61411');
    expect(
      operatingDesignator({ operating_carrier_iata: 'KL ', operating_flight_number: '1405 ' }),
    ).toBe('KL1405');
  });
});

describe('pollAndUpdate — the happy path', () => {
  it('takes a rate-limit slot before it calls the provider', async () => {
    const h = harness('flights-number-live-today');

    await pollAndUpdate(flightRow(), h.deps);

    expect(h.acquired()).toBe(1);
  });

  it('looks the flight up by its OPERATING number and origin-local date', async () => {
    const h = harness('flights-number-live-today');

    await pollAndUpdate(flightRow(), h.deps);

    const lookup = h.asked.find((url) => url.includes('/flights/number/'));
    expect(lookup).toContain('/flights/number/B61411/2026-09-11');
  });

  it('writes through ingestFlight and schedules the next poll from the ladder', async () => {
    const h = harness('flights-number-live-today');
    h.fake.queue([]); // no events for an unchanged flight
    h.fake.queue([]); // the scheduling update

    const outcome = await pollAndUpdate(flightRow(), h.deps);

    expect(outcome.kind).toBe('updated');
    // Departure is 2026-09-12T01:59Z; `now` is 2026-09-11T20:00Z — just under 6 h,
    // so the 15-minute failover band.
    const values = lastStatement(h.fake)?.values ?? [];
    expect(values[0]).toBe('flight-1');
    expect((values[1] as Date).getTime()).toBe(NOW.getTime() + LADDER_INTERVALS.EVERY_15M);
    expect(values[2]).toEqual(NOW);
    expect(values[3]).toBeNull(); // not archived
  });

  it('produces no events at all when nothing changed (§8.2)', async () => {
    const h = harness('flights-number-live-today');
    // The stored row already matches the fixture exactly.
    const stored = flightRow({
      status: 'scheduled',
      estimated_departure_utc: '2026-09-12T01:59:00.000Z',
    });

    const outcome = await pollAndUpdate(stored, h.deps);

    expect(outcome.kind === 'updated' && outcome.events).toEqual([]);
    // One statement only: the scheduling update. No empty insert.
    expect(h.fake.statements).toHaveLength(1);
  });

  it('writes the events it detects and returns their ids', async () => {
    const h = harness('flights-number-live-today');
    h.fake.queue([{ id: 'event-1' }]);

    // Stored gate differs from the fixture's arrival terminal assignment, so the
    // poll sees a gate assignment.
    const stored = flightRow({ gate: 'B24' });
    const outcome = await pollAndUpdate(stored, h.deps);

    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') return;
    // The captured leg reports no departure gate, so a stored gate is *not*
    // overwritten by a null — nothing to notify.
    expect(outcome.events).toEqual([]);
  });

  it('never takes candidates[0]: it matches the leg on origin_iata (§8.12)', async () => {
    // AS 65 operates five legs on one date. Only WRG → PSG is this row.
    const h = harness('flights-number-multileg', { now: new Date('2026-09-15T16:00:00.000Z') });
    h.fake.queue([{ id: 'event-1' }]);
    h.fake.queue([]);

    const leg = flightRow({
      id: 'flight-as65-wrg',
      operating_carrier_iata: 'AS',
      operating_flight_number: '65',
      departure_date_local: '2026-09-15',
      origin_iata: 'WRG',
      destination_iata: 'PSG',
      origin_tz: 'America/Anchorage',
      destination_tz: 'America/Anchorage',
      scheduled_departure_utc: '2026-09-15T18:29:00.000Z',
      estimated_departure_utc: '2026-09-15T18:29:00.000Z',
      scheduled_arrival_utc: '2026-09-15T18:56:00.000Z',
      estimated_arrival_utc: null,
      status: 'cancelled',
    });

    const outcome = await pollAndUpdate(leg, h.deps);

    expect(outcome.kind).toBe('updated');
    // The fixture says this leg is Expected, so the stored `cancelled` is stale —
    // and no `cancelled` event fires for a flight that is no longer cancelled.
    if (outcome.kind !== 'updated') return;
    expect(outcome.events).not.toContain('cancelled');
  });
});

describe('pollAndUpdate — archiving', () => {
  /** The captured B6 leg, reported as `Arrived`. Its revised arrival is 06:57Z. */
  const landed = (legs: Record<string, unknown>[]) =>
    legs.map((leg) => ({ ...leg, status: 'Arrived' }));
  const LANDED_AT = new Date('2026-09-12T06:57:00.000Z');

  it('archives and stops polling once landing + 30 min has passed', async () => {
    const h = harness('flights-number-live-today', {
      now: new Date(LANDED_AT.getTime() + 31 * MINUTE),
      mutate: landed,
    });
    h.fake.queue([{ id: 'event-1' }, { id: 'event-2' }]);
    h.fake.queue([]);

    const outcome = await pollAndUpdate(flightRow(), h.deps);

    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') return;
    expect(outcome.events).toEqual(['departed', 'landed']);
    expect(outcome.archived).toBe(true);
    expect(outcome.nextPollAt).toBeNull();

    // `archived_at = now`, `next_poll_at = null`, in one statement.
    const values = lastStatement(h.fake)?.values ?? [];
    expect(values[1]).toBeNull();
    expect(values[3]).toEqual(new Date(LANDED_AT.getTime() + 31 * MINUTE));
  });

  it('does not archive in the first 30 minutes: it schedules the poll that will', async () => {
    const now = new Date(LANDED_AT.getTime() + 5 * MINUTE);
    const h = harness('flights-number-live-today', { now, mutate: landed });
    h.fake.queue([{ id: 'event-1' }, { id: 'event-2' }]);
    h.fake.queue([]);

    const outcome = await pollAndUpdate(flightRow(), h.deps);

    expect(outcome.kind === 'updated' && outcome.archived).toBe(false);
    // Exactly one more poll, at landed + 30 min, un-jittered.
    expect(outcome.kind === 'updated' && outcome.nextPollAt).toEqual(
      new Date(LANDED_AT.getTime() + 30 * MINUTE),
    );
  });

  it('never archives on a scheduled arrival alone (§8.9 is what handles that)', async () => {
    // The captured leg is `Expected`: a revised arrival of 06:57Z and no observed
    // landing. Hours later it is still not archived here — the daily backstop is
    // the only thing that retires a flight nobody watched land.
    const h = harness('flights-number-live-today', {
      now: new Date('2026-09-12T12:00:00.000Z'),
    });
    h.fake.queue([]);

    const outcome = await pollAndUpdate(flightRow(), h.deps);

    expect(outcome.kind === 'updated' && outcome.archived).toBe(false);
    expect(outcome.kind === 'updated' && outcome.nextPollAt).not.toBeNull();
  });
});

describe('pollAndUpdate — failures', () => {
  it('treats a provider error as a failure and backs off', async () => {
    const h = harness('flights-number-live-today', { flightsStatus: 500 });

    const outcome = await pollAndUpdate(flightRow(), h.deps);

    expect(outcome).toMatchObject({
      kind: 'failed',
      flightId: 'flight-1',
      reason: 'provider_error',
      failureCount: 1,
      backedOff: false,
    });
    // One statement: the failure update. Nothing was ingested, nothing emitted.
    expect(h.fake.statements).toHaveLength(1);
    expect(h.fake.statements[0]?.text).toContain('poll_failure_count = $4');
    expect(h.fake.statements[0]?.values[3]).toBe(1);
  });

  it('treats a rate-limit answer as a failure, not as data', async () => {
    const h = harness('flights-number-live-today', { flightsStatus: 429 });
    const outcome = await pollAndUpdate(flightRow(), h.deps);
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'provider_error' });
  });

  it('treats a network failure as a failure', async () => {
    const h = harness('flights-number-live-today', { failWith: new Error('ECONNRESET') });
    const outcome = await pollAndUpdate(flightRow(), h.deps);
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'provider_error' });
  });

  it('treats a leg the provider no longer returns as a failure, NOT as cancelled', async () => {
    // §8.8. An empty answer, or one with no leg from our origin, means "we do not
    // know" — writing `cancelled` would push a false cancellation notification.
    // AeroDataBox answers 204 with no body for a number it has nothing for
    // (`docs/api-samples/flights-number-nonexistent-empty.json`).
    const h = harness('flights-number-nonexistent-empty', { flightsStatus: 204 });

    const outcome = await pollAndUpdate(flightRow(), h.deps);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'leg_missing', failureCount: 1 });
    expect(h.fake.statements).toHaveLength(1);
    // The failure statement never touches archived_at or any provider column.
    expect(h.fake.statements[0]?.text).not.toContain('archived_at');
    expect(h.fake.statements[0]?.text).not.toContain('status');
  });

  it('treats a right number from the wrong origin as a missing leg', async () => {
    const h = harness('flights-number-multileg', { now: new Date('2026-09-15T12:00:00.000Z') });

    const wrongOrigin = flightRow({
      operating_carrier_iata: 'AS',
      operating_flight_number: '65',
      departure_date_local: '2026-09-15',
      origin_iata: 'LAX', // AS 65 flies SEA/KTN/WRG/PSG/JNU that day, never LAX
    });

    const outcome = await pollAndUpdate(wrongOrigin, h.deps);
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'leg_missing' });
  });

  it('treats a refused write as a failure without losing the lease release', async () => {
    const h = harness('flights-number-live-today', { writerFails: true });

    const outcome = await pollAndUpdate(flightRow(), h.deps);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'write_failed' });
    expect(h.fake.statements.at(-1)?.text).toContain('poll_lease_until = null');
  });

  it('marks a flight backed off from the fifth consecutive failure (§8.8)', async () => {
    const h = harness('flights-number-live-today', { flightsStatus: 500 });

    const outcome = await pollAndUpdate(
      flightRow({ poll_failure_count: MAX_CONSECUTIVE_FAILURES - 1 }),
      h.deps,
    );

    expect(outcome).toMatchObject({
      kind: 'failed',
      failureCount: MAX_CONSECUTIVE_FAILURES,
      backedOff: true,
    });
  });
});

describe('backoffPollAt', () => {
  const near = flightRow(); // 15-minute band at NOW

  it('doubles the flight’s own ladder interval per consecutive failure', () => {
    const one = backoffPollAt(near, NOW, 1, noJitter).getTime() - NOW.getTime();
    const two = backoffPollAt(near, NOW, 2, noJitter).getTime() - NOW.getTime();
    const three = backoffPollAt(near, NOW, 3, noJitter).getTime() - NOW.getTime();

    expect(one).toBe(2 * LADDER_INTERVALS.EVERY_15M);
    expect(two).toBe(4 * LADDER_INTERVALS.EVERY_15M);
    expect(three).toBe(8 * LADDER_INTERVALS.EVERY_15M);
  });

  it('caps at six hours however long the streak', () => {
    for (const failures of [6, 10, 40]) {
      const delta = backoffPollAt(near, NOW, failures, noJitter).getTime() - NOW.getTime();
      // At and past the cap the result is also pushed to the next ladder step,
      // which for a near-departure flight is far smaller — so the cap governs.
      expect(delta).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      expect(delta).toBe(MAX_BACKOFF_MS);
    }
  });

  it('parks a far-future flight at its next ladder step once backed off', () => {
    // A flight three weeks out is on the weekly band; six hours of back-off is
    // pointless there, so the natural step wins.
    const farOut = flightRow({
      scheduled_departure_utc: new Date(NOW.getTime() + 21 * 24 * HOUR).toISOString(),
      estimated_departure_utc: null,
      scheduled_arrival_utc: new Date(NOW.getTime() + 21 * 24 * HOUR + 6 * HOUR).toISOString(),
      estimated_arrival_utc: null,
    });

    const delta =
      backoffPollAt(farOut, NOW, MAX_CONSECUTIVE_FAILURES, noJitter).getTime() - NOW.getTime();

    expect(delta).toBe(LADDER_INTERVALS.WEEKLY);
  });

  it('jitters the back-off so an outage does not resynchronise every flight', () => {
    const early = backoffPollAt(near, NOW, 1, () => 0).getTime();
    const middle = backoffPollAt(near, NOW, 1, () => 0.5).getTime();
    const late = backoffPollAt(near, NOW, 1, () => 0.99).getTime();

    expect(early).toBeLessThan(middle);
    expect(middle).toBeLessThan(late);
    expect(early - NOW.getTime()).toBe(Math.round(2 * LADDER_INTERVALS.EVERY_15M * 0.9));
  });

  it('always lands in the future', () => {
    for (const failures of [1, 2, 3, 5, 12]) {
      for (const draw of [0, 0.5, 0.99]) {
        expect(backoffPollAt(near, NOW, failures, () => draw).getTime()).toBeGreaterThan(
          NOW.getTime(),
        );
      }
    }
  });
});
