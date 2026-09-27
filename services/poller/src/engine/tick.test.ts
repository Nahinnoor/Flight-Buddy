import { createFeedHealthCache, createPgFlightsWriter } from '@flightbuddy/flight-provider';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger';
import { createFakePool } from './fakePool';
import { CLAIM_DUE_FLIGHTS_SQL } from './lease';
import { fixtureProvider } from './testFixtures';
import { runPollPass } from './tick';
import type { FlightRow } from './types';

const NOW = new Date('2026-09-11T20:00:00.000Z');
const logger = createLogger({ level: 'silent' });

function flightRow(id: string, origin: string, destination: string): FlightRow {
  return {
    id,
    operating_carrier_iata: 'B6',
    operating_flight_number: '1411',
    departure_date_local: '2026-09-11',
    origin_iata: origin,
    destination_iata: destination,
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
    aircraft_reg: null,
    aircraft_model: null,
    distance_km: null,
    origin_country_code: null,
    destination_country_code: null,
    next_poll_at: NOW.toISOString(),
    poll_lease_until: null,
    last_polled_at: null,
    poll_failure_count: 0,
    alert_subscription_id: null,
    alert_subscribed_at: null,
    raw_payload: null,
    archived_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
  };
}

function harness(claimed: FlightRow[]) {
  const fake = createFakePool();
  fake.queue(claimed);

  const { provider } = fixtureProvider('flights-number-live-today');
  const acquisitions: number[] = [];
  let order = 0;

  return {
    fake,
    acquisitions,
    options: {
      pool: fake.pool,
      provider,
      writer: createPgFlightsWriter(async () => ({ rows: [{ id: 'ignored' }] })),
      rateLimiter: {
        acquire: async () => {
          order += 1;
          acquisitions.push(order);
        },
      },
      logger,
      now: () => NOW,
      rng: () => 0.5,
      feedHealthCache: createFeedHealthCache(),
      batchSize: 25,
    },
  };
}

describe('runPollPass', () => {
  it('claims first and polls after, so every lease is committed before any HTTP call', async () => {
    const h = harness([flightRow('flight-1', 'JFK', 'LAS')]);

    await runPollPass(h.options);

    expect(h.fake.statements[0]?.text).toBe(CLAIM_DUE_FLIGHTS_SQL);
    expect(h.fake.statements[0]?.values).toEqual([25, 120_000]);
  });

  it('does nothing and asks the provider nothing when nothing is due', async () => {
    const h = harness([]);

    const summary = await runPollPass(h.options);

    expect(summary).toMatchObject({ claimed: 0, updated: 0, failed: 0, archived: 0, events: 0 });
    expect(h.acquisitions).toHaveLength(0);
    expect(h.fake.statements).toHaveLength(1);
  });

  it('polls each claimed flight once, taking one limiter slot each', async () => {
    const h = harness([
      flightRow('flight-1', 'JFK', 'LAS'),
      flightRow('flight-2', 'JFK', 'LAS'),
      flightRow('flight-3', 'JFK', 'LAS'),
    ]);

    const summary = await runPollPass(h.options);

    expect(summary.claimed).toBe(3);
    expect(summary.updated).toBe(3);
    expect(summary.failed).toBe(0);
    expect(h.acquisitions).toEqual([1, 2, 3]);
  });

  it('counts a failure without abandoning the rest of the batch', async () => {
    // flight-2 has an origin the fixture's leg does not serve, so its leg is
    // missing — a failure. The pass must still poll flight-3.
    const h = harness([
      flightRow('flight-1', 'JFK', 'LAS'),
      flightRow('flight-2', 'BOS', 'LAS'),
      flightRow('flight-3', 'JFK', 'LAS'),
    ]);

    const summary = await runPollPass(h.options);

    expect(summary).toMatchObject({ claimed: 3, updated: 2, failed: 1 });
    expect(summary.outcomes.map((o) => o.kind)).toEqual(['updated', 'failed', 'updated']);
  });

  it('releases nothing: leases are left to expire (§8.7)', async () => {
    const h = harness([flightRow('flight-1', 'JFK', 'LAS')]);

    await runPollPass(h.options);

    const released = h.fake.statements.filter((s) => s.text.includes('poll_lease_until = null'));
    // The only statement clearing a lease is the flight's own poll result, not a
    // separate release pass.
    expect(released).toHaveLength(1);
    expect(released[0]?.text).toContain('last_polled_at');
  });

  it('honours the configured batch size and lease', async () => {
    const h = harness([]);

    await runPollPass({ ...h.options, batchSize: 5, leaseMs: 45_000 });

    expect(h.fake.statements[0]?.values).toEqual([5, 45_000]);
  });

  it('lets a claim failure end the pass, so the loop logs and retries', async () => {
    const fake = createFakePool();
    fake.failNext(new Error('connection terminated'));
    const h = harness([]);

    await expect(runPollPass({ ...h.options, pool: fake.pool })).rejects.toThrow(
      'connection terminated',
    );
  });
});
