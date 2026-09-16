import { describe, expect, it } from 'vitest';

import { createMemoryDb } from './memoryDb';
import { RECONCILE_GRACE_MS, reconcileSubscriptions, type ReconcileDeps } from './reconcile';
import {
  FAKE_WEBHOOK_TOKEN,
  b6FlightRow,
  captureLogger,
  countingLimiter,
  fixtureProvider,
  subscriptionContract,
  type SubscriptionStub,
} from './testFixtures';

const NOW = new Date('2026-09-11T20:00:00.000Z');
const OLD = '2026-09-11 12:00Z';
const OLD_ISO = '2026-09-11T12:00:00.000Z';
/** Inside the grace window. */
const YOUNG = '2026-09-11 19:55Z';
const YOUNG_ISO = '2026-09-11T19:55:00.000Z';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

function harness(subscriptions: SubscriptionStub, webhooksEnabled = true) {
  const db = createMemoryDb({ now: NOW });
  const fx = fixtureProvider('flights-number-live-today', { subscriptions });
  const { limiter, count } = countingLimiter();
  const log = captureLogger();
  const deps: ReconcileDeps = {
    pool: db.pool,
    provider: fx.provider,
    rateLimiter: limiter,
    logger: log.logger,
    webhooksEnabled,
    now: () => NOW,
  };
  const deletes = () =>
    fx.requests.filter((r) => r.method === 'DELETE').map((r) => r.url.split('/').at(-1));
  return { db, fx, count, log, deps, deletes, run: () => reconcileSubscriptions(deps) };
}

describe('reconcileSubscriptions', () => {
  it('does nothing at all when webhooks are off', async () => {
    const h = harness({ list: [subscriptionContract(S1, { createdOnUtc: OLD })] }, false);

    const result = await h.run();

    expect(result.skipped).toBe(true);
    expect(h.fx.requests).toHaveLength(0);
  });

  it('deletes a provider subscription no active flight claims, keeps a claimed one', async () => {
    const h = harness({
      list: [subscriptionContract(S1, { createdOnUtc: OLD }), subscriptionContract(S2, { createdOnUtc: OLD })],
    });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: S1, alert_subscribed_at: OLD_ISO }));

    const result = await h.run();

    expect(h.deletes()).toEqual([S2]);
    expect(result.deleted).toEqual([S2]);
    expect(result.detached).toEqual([]);
    expect(h.count()).toBe(2); // list + one delete
  });

  it('deletes a subscription claimed only by an archived row', async () => {
    const h = harness({ list: [subscriptionContract(S1, { createdOnUtc: OLD })] });
    h.db.addFlight(
      b6FlightRow({ alert_subscription_id: S1, archived_at: '2026-09-10T00:00:00.000Z' }),
    );

    await h.run();

    expect(h.deletes()).toEqual([S1]);
  });

  it('leaves an unclaimed subscription younger than the grace window (a subscribe in progress)', async () => {
    const h = harness({ list: [subscriptionContract(S2, { createdOnUtc: YOUNG })] });
    expect(RECONCILE_GRACE_MS).toBe(10 * 60_000);

    await h.run();

    expect(h.deletes()).toEqual([]);
  });

  it('detaches a row whose subscription the provider no longer has, and puts it back on the ladder', async () => {
    const h = harness({}); // 204: the provider has none
    h.db.addFlight(b6FlightRow({ alert_subscription_id: S1, alert_subscribed_at: OLD_ISO }));

    const result = await h.run();

    expect(result.detached).toEqual(['flight-b6']);
    expect(h.db.flight('flight-b6')).toMatchObject({
      alert_subscription_id: null,
      alert_subscribed_at: null,
      next_poll_at: NOW.toISOString(),
    });
  });

  it('does not detach a row subscribed inside the grace window', async () => {
    const h = harness({});
    h.db.addFlight(b6FlightRow({ alert_subscription_id: S1, alert_subscribed_at: YOUNG_ISO }));

    await h.run();

    expect(h.db.flight('flight-b6').alert_subscription_id).toBe(S1);
  });

  it('treats an inactive subscription as gone: deleted, and its rows back on the ladder', async () => {
    const h = harness({ list: [subscriptionContract(S1, { createdOnUtc: OLD, isActive: false })] });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: S1, alert_subscribed_at: OLD_ISO }));

    const result = await h.run();

    expect(h.deletes()).toEqual([S1]);
    expect(result.detached).toEqual(['flight-b6']);
  });

  it('compares ids case-insensitively', async () => {
    const h = harness({ list: [subscriptionContract(S1.toUpperCase(), { createdOnUtc: OLD })] });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: S1.toUpperCase(), alert_subscribed_at: OLD_ISO }));

    const result = await h.run();

    expect(result.deleted).toEqual([]);
    expect(result.detached).toEqual([]);
  });

  it('keeps going past a failed delete and reports it', async () => {
    const h = harness({
      list: [subscriptionContract(S2, { createdOnUtc: OLD }), subscriptionContract(S3, { createdOnUtc: OLD })],
      deleteStatus: 500,
    });

    const result = await h.run();

    expect(result.failedDeletes).toEqual([S2, S3]);
    expect(h.log.records().filter((r) => r.level === 'warn')).toHaveLength(2);
  });

  it('acts on nothing when the list cannot be read', async () => {
    const h = harness({ listStatus: 502 });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: S1, alert_subscribed_at: OLD_ISO }));

    const result = await h.run();

    expect(result.skipped).toBe(true);
    expect(h.db.flight('flight-b6').alert_subscription_id).toBe(S1);
    expect(h.deletes()).toEqual([]);
  });

  it('logs ids only — never the subscriber URL the list carries', async () => {
    const h = harness({
      list: [subscriptionContract(S1, { createdOnUtc: OLD }), subscriptionContract(S2, { createdOnUtc: OLD })],
    });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: S1, alert_subscribed_at: OLD_ISO }));

    await h.run();

    expect(h.log.text()).not.toContain(FAKE_WEBHOOK_TOKEN);
    expect(h.log.records().at(-1)).toMatchObject({ deleted: [S2], detachedFlightIds: [] });
  });
});
