import { createFeedHealthCache, lookupCandidates } from '@flightbuddy/flight-provider';
import type { FlightCandidate } from '@flightbuddy/shared';
import { describe, expect, it } from 'vitest';

import { createMemoryDb } from './memoryDb';
import type { FlightRow } from './types';
import {
  CLEAR_SUBSCRIPTION_SQL,
  MAX_DELIVERY_RETRIES,
  clampToWindowOpening,
  closeSubscription,
  openSubscription,
  shouldSubscribe,
  webhookWindowOpensAt,
} from './subscriptions';
import {
  DEFAULT_SUBSCRIPTION_ID as SUB,
  FAKE_WEBHOOK_TOKEN,
  FAKE_WEBHOOK_URL,
  b6FlightRow,
  captureLogger,
  countingLimiter,
  fixtureProvider,
  type SubscriptionStub,
} from './testFixtures';

const HOUR = 3_600_000;
/** The captured B6 1411's departure. */
const DEPARTURE = Date.parse('2026-09-12T01:59:00.000Z');
const NOW = new Date(DEPARTURE - 6 * HOUR);

/** The captured leg as a lookup returns it with both airports live. */
async function liveLeg(overrides: Partial<FlightCandidate> = {}): Promise<FlightCandidate> {
  const { provider } = fixtureProvider('flights-number-live-today', { allLive: true });
  const [leg] = await lookupCandidates(
    provider,
    { flightNumber: 'B61411', dateLocal: '2026-09-11' },
    { feedHealthCache: createFeedHealthCache() },
  );
  return { ...(leg as FlightCandidate), ...overrides };
}

describe('shouldSubscribe', () => {
  it('is true for an unsubscribed live flight inside T-24 h', async () => {
    const leg = await liveLeg();
    expect(leg.trackingTier).toBe('live');
    expect(shouldSubscribe(leg, null, NOW)).toBe(true);
  });

  it('opens at exactly T-24 h on the departure anchor, not a millisecond before', async () => {
    const leg = await liveLeg();
    expect(webhookWindowOpensAt(leg)).toBe(DEPARTURE - 24 * HOUR);
    expect(shouldSubscribe(leg, null, new Date(DEPARTURE - 24 * HOUR))).toBe(true);
    expect(shouldSubscribe(leg, null, new Date(DEPARTURE - 24 * HOUR - 1))).toBe(false);
  });

  it('moves with a later estimate, like the ladder does', async () => {
    const leg = await liveLeg({
      estimatedDepartureUtc: new Date(DEPARTURE + 2 * HOUR).toISOString(),
    });
    expect(shouldSubscribe(leg, null, new Date(DEPARTURE - 23 * HOUR))).toBe(false);
    expect(shouldSubscribe(leg, null, new Date(DEPARTURE - 22 * HOUR))).toBe(true);
  });

  it('never subscribes a scheduled- or manual-tier flight (§7.3)', async () => {
    expect(shouldSubscribe(await liveLeg({ trackingTier: 'scheduled' }), null, NOW)).toBe(false);
    expect(shouldSubscribe(await liveLeg({ trackingTier: 'manual' }), null, NOW)).toBe(false);
  });

  it('never subscribes twice', async () => {
    expect(shouldSubscribe(await liveLeg(), SUB, NOW)).toBe(false);
  });

  it('never subscribes a flight that is over: cancelled or landed', async () => {
    expect(shouldSubscribe(await liveLeg({ status: 'cancelled' }), null, NOW)).toBe(false);
    expect(
      shouldSubscribe(await liveLeg({ actualArrivalUtc: '2026-09-12T06:57:00.000Z' }), null, NOW),
    ).toBe(false);
  });

  it('never subscribes a flight with no departure time to anchor on', async () => {
    const leg = await liveLeg({
      scheduledDepartureUtc: null,
      estimatedDepartureUtc: null,
      actualDepartureUtc: null,
    });
    expect(shouldSubscribe(leg, null, NOW)).toBe(false);
  });
});

describe('clampToWindowOpening', () => {
  const at = (ms: number) => new Date(ms);

  it('pulls a 4-hourly pre-window poll back to T-24 h', async () => {
    const now = at(DEPARTURE - 26 * HOUR);
    const next = at(now.getTime() + 4 * HOUR);
    expect(clampToWindowOpening(next, await liveLeg(), now)).toEqual(at(DEPARTURE - 24 * HOUR));
  });

  it('leaves a poll that already lands before the window alone', async () => {
    const now = at(DEPARTURE - 30 * HOUR);
    const next = at(now.getTime() + 4 * HOUR);
    expect(clampToWindowOpening(next, await liveLeg(), now)).toEqual(next);
  });

  it('does nothing once the window is open, or for a flight that will never subscribe', async () => {
    const next = at(NOW.getTime() + HOUR);
    expect(clampToWindowOpening(next, await liveLeg(), NOW)).toEqual(next);

    const early = at(DEPARTURE - 26 * HOUR);
    const later = at(early.getTime() + 4 * HOUR);
    expect(
      clampToWindowOpening(later, await liveLeg({ trackingTier: 'scheduled' }), early),
    ).toEqual(later);
  });
});

function setup(subscriptions: SubscriptionStub = {}) {
  const db = createMemoryDb({ now: NOW });
  const fx = fixtureProvider('flights-number-live-today', { allLive: true, subscriptions });
  const { limiter, count } = countingLimiter();
  const log = captureLogger();
  const deps = {
    pool: db.pool,
    provider: fx.provider,
    rateLimiter: limiter,
    logger: log.logger,
    webhookUrl: FAKE_WEBHOOK_URL,
  };
  return { db, fx, count, log, deps };
}

describe('openSubscription', () => {
  it('subscribes by the OPERATING number with one retry, and stores the id', async () => {
    const h = setup({ createId: SUB });
    const row = h.db.addFlight(b6FlightRow());

    const id = await openSubscription(h.deps, row, NOW);

    expect(id).toBe(SUB);
    expect(h.db.flight(row.id).alert_subscription_id).toBe(SUB);
    expect(h.db.flight(row.id).alert_subscribed_at).toBe(NOW.toISOString());

    const posts = h.fx.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain('/subscriptions/webhook/FlightByNumber/B61411');
    expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({
      url: FAKE_WEBHOOK_URL,
      maxDeliveryRetries: 1,
    });
    expect(MAX_DELIVERY_RETRIES).toBe(1);
  });

  it('takes a rate-limit slot for the subscribe call', async () => {
    const h = setup();
    await openSubscription(h.deps, h.db.addFlight(b6FlightRow()), NOW);
    expect(h.count()).toBe(1);
  });

  it('joins the subscription another active row of the same number holds, at no cost', async () => {
    const h = setup();
    h.db.addFlight(
      b6FlightRow({
        id: 'other-leg',
        origin_iata: 'LAS',
        alert_subscription_id: SUB,
        alert_subscribed_at: '2026-09-11T10:00:00.000Z',
      }),
    );
    const row = h.db.addFlight(b6FlightRow());

    const id = await openSubscription(h.deps, row, NOW);

    expect(id).toBe(SUB);
    expect(h.db.flight(row.id).alert_subscription_id).toBe(SUB);
    expect(h.fx.requests).toHaveLength(0);
    expect(h.count()).toBe(0);
  });

  it('does not join a subscription held only by an archived row', async () => {
    const h = setup({ createId: '0b9e7a44-2222-4c3d-8e66-3f3c8f5b0d12' });
    h.db.addFlight(
      b6FlightRow({
        id: 'archived',
        origin_iata: 'LAS',
        alert_subscription_id: SUB,
        archived_at: '2026-09-10T00:00:00.000Z',
      }),
    );

    const id = await openSubscription(h.deps, h.db.addFlight(b6FlightRow()), NOW);

    expect(id).toBe('0b9e7a44-2222-4c3d-8e66-3f3c8f5b0d12');
    expect(h.fx.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('on a provider failure returns null, leaves the row alone and logs ids + class only', async () => {
    const h = setup({ createStatus: 500 });
    const row = h.db.addFlight(b6FlightRow());

    const id = await openSubscription(h.deps, row, NOW);

    expect(id).toBeNull();
    expect(h.db.flight(row.id).alert_subscription_id).toBeNull();
    const warn = h.log.records().find((r) => r.level === 'warn');
    expect(warn).toMatchObject({ flightId: row.id, errorName: 'ProviderError' });
    expect(h.log.text()).not.toContain(FAKE_WEBHOOK_TOKEN);
    expect(h.log.text()).not.toContain('api.example.invalid');
  });

  it('never overwrites a subscription that appeared on the row meanwhile', async () => {
    const h = setup({ createId: SUB });
    const stored = h.db.addFlight(b6FlightRow({ alert_subscription_id: 'someone-elses' }));
    // What the poller would have read a moment earlier, before the id appeared.
    const stale: FlightRow = { ...stored, alert_subscription_id: null };

    const id = await openSubscription(h.deps, stale, NOW);

    expect(id).toBeNull();
    expect(h.db.flight(stored.id).alert_subscription_id).toBe('someone-elses');
  });
});

describe('closeSubscription', () => {
  it('unsubscribes the last holder and clears the row', async () => {
    const h = setup();
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    await closeSubscription(h.deps, row.id, SUB);

    const deletes = h.fx.requests.filter((r) => r.method === 'DELETE');
    expect(deletes.map((r) => r.url)).toEqual([
      `https://aerodatabox.p.rapidapi.com/subscriptions/webhook/${SUB}`,
    ]);
    expect(h.count()).toBe(1);
    expect(h.db.flight(row.id).alert_subscription_id).toBeNull();
    expect(h.db.flight(row.id).alert_subscribed_at).toBeNull();
  });

  it('keeps a subscription another active row still uses, and detaches this row only', async () => {
    const h = setup();
    h.db.addFlight(
      b6FlightRow({ id: 'other-leg', origin_iata: 'LAS', alert_subscription_id: SUB }),
    );
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    await closeSubscription(h.deps, row.id, SUB);

    expect(h.fx.requests).toHaveLength(0);
    expect(h.db.flight(row.id).alert_subscription_id).toBeNull();
    expect(h.db.flight('other-leg').alert_subscription_id).toBe(SUB);
  });

  it('does not count an archived row as a holder', async () => {
    const h = setup();
    h.db.addFlight(
      b6FlightRow({
        id: 'old',
        origin_iata: 'LAS',
        alert_subscription_id: SUB,
        archived_at: '2026-09-10T00:00:00.000Z',
      }),
    );
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    await closeSubscription(h.deps, row.id, SUB);

    expect(h.fx.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('logs an unsubscribe failure and still detaches (the archive must proceed)', async () => {
    const h = setup({ deleteStatus: 500 });
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    await expect(closeSubscription(h.deps, row.id, SUB)).resolves.toBeUndefined();

    expect(h.db.flight(row.id).alert_subscription_id).toBeNull();
    expect(h.log.records().find((r) => r.level === 'warn')).toMatchObject({
      flightId: row.id,
      subscriptionId: SUB,
      errorName: 'ProviderError',
    });
  });

  it('treats an already-deleted subscription (404) as closed', async () => {
    const h = setup({ deleteStatus: 404 });
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    await closeSubscription(h.deps, row.id, SUB);

    expect(h.log.records().some((r) => r.level === 'warn')).toBe(false);
    expect(h.db.flight(row.id).alert_subscription_id).toBeNull();
  });

  it('throws when the database refuses the detach, so the poll retries the archive', async () => {
    const h = setup();
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));
    h.db.failOn(CLEAR_SUBSCRIPTION_SQL, new Error('connection terminated'));

    await expect(closeSubscription(h.deps, row.id, SUB)).rejects.toThrow('connection terminated');
  });
});
