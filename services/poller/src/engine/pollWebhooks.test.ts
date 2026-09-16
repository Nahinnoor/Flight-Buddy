/**
 * `pollAndUpdate` with webhooks on (wave 3): T-24 h subscribe, and unsubscribe at
 * landed + 30 min. The wave 2 behaviour with webhooks off is `poll.test.ts`.
 */
import { createFeedHealthCache } from '@flightbuddy/flight-provider';
import { describe, expect, it } from 'vitest';

import { LADDER_INTERVALS } from './ladder';
import { createMemoryDb } from './memoryDb';
import { pollAndUpdate, type PollDependencies } from './poll';
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
import type { FlightRow } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DEPARTURE = Date.parse('2026-09-12T01:59:00.000Z');
/** T-6 h: inside the webhook window. */
const NOW = new Date(DEPARTURE - 6 * HOUR);
const LANDED = Date.parse('2026-09-12T06:57:00.000Z');

const landed = (legs: Record<string, unknown>[]) => legs.map((leg) => ({ ...leg, status: 'Arrived' }));

interface Options {
  now?: Date;
  webhooks?: boolean;
  allLive?: boolean;
  subscriptions?: SubscriptionStub;
  mutate?: (legs: Record<string, unknown>[]) => Record<string, unknown>[];
}

function harness(options: Options = {}) {
  const now = options.now ?? NOW;
  const webhooks = options.webhooks ?? true;
  const db = createMemoryDb({ now });
  const fx = fixtureProvider('flights-number-live-today', {
    allLive: options.allLive ?? true,
    ...(options.subscriptions === undefined ? {} : { subscriptions: options.subscriptions }),
    ...(options.mutate === undefined ? {} : { mutate: options.mutate }),
  });
  const { limiter, count } = countingLimiter();
  const log = captureLogger();
  const deps: PollDependencies = {
    pool: db.pool,
    provider: fx.provider,
    writer: db.writer,
    rateLimiter: limiter,
    logger: log.logger,
    now: () => now,
    rng: () => 0.5,
    webhooksEnabled: webhooks,
    ...(webhooks ? { webhookUrl: FAKE_WEBHOOK_URL } : {}),
    feedHealthCache: createFeedHealthCache(),
  };
  const poll = (row: FlightRow) => pollAndUpdate({ ...row }, deps);
  const posts = () => fx.requests.filter((r) => r.method === 'POST');
  const deletes = () => fx.requests.filter((r) => r.method === 'DELETE');
  return { db, fx, count, log, deps, poll, posts, deletes, now };
}

describe('T-24 h: subscribe (§7.6)', () => {
  it('subscribes a live flight inside the window, stores the id and stops polling it', async () => {
    const h = harness({ subscriptions: { createId: SUB } });
    const row = h.db.addFlight(b6FlightRow({ next_poll_at: NOW.toISOString() }));

    const outcome = await h.poll(row);

    expect(outcome).toMatchObject({ kind: 'updated', nextPollAt: null });
    expect(h.posts()).toHaveLength(1);
    const stored = h.db.flight(row.id);
    expect(stored.alert_subscription_id).toBe(SUB);
    expect(stored.alert_subscribed_at).toBe(NOW.toISOString());
    expect(stored.next_poll_at).toBeNull();
    // One slot for the lookup, one for the subscribe.
    expect(h.count()).toBe(2);
  });

  it('with WEBHOOK_URL unset, never subscribes and keeps the failover ladder', async () => {
    const h = harness({ webhooks: false });
    const row = h.db.addFlight(b6FlightRow());

    const outcome = await h.poll(row);

    expect(h.posts()).toHaveLength(0);
    expect(outcome.nextPollAt).toEqual(new Date(NOW.getTime() + LADDER_INTERVALS.EVERY_15M));
    expect(h.db.flight(row.id).alert_subscription_id).toBeNull();
  });

  it('never subscribes a scheduled-tier flight, even with webhooks on', async () => {
    // Only KJFK is live in the captures, so JFK → LAS comes back `scheduled`.
    const h = harness({ allLive: false });
    const row = h.db.addFlight(b6FlightRow({ tracking_tier: 'scheduled' }));

    const outcome = await h.poll(row);

    expect(h.posts()).toHaveLength(0);
    expect(outcome.nextPollAt).not.toBeNull();
  });

  it('on a subscribe failure: poll still succeeds, flight stays on the ladder, next poll retries', async () => {
    const h = harness({ subscriptions: { createStatus: 503 } });
    const row = h.db.addFlight(b6FlightRow());

    const first = await h.poll(row);

    expect(first.kind).toBe('updated');
    expect(first.nextPollAt).toEqual(new Date(NOW.getTime() + LADDER_INTERVALS.EVERY_15M));
    expect(h.db.flight(row.id).poll_failure_count).toBe(0);
    expect(h.db.flight(row.id).alert_subscription_id).toBeNull();

    await h.poll(h.db.flight(row.id));
    expect(h.posts()).toHaveLength(2);

    const warns = h.log.records().filter((r) => r.level === 'warn');
    expect(warns[0]).toMatchObject({ flightId: row.id, errorName: 'ProviderError' });
    expect(h.log.text()).not.toContain(FAKE_WEBHOOK_TOKEN);
  });

  it('does not subscribe a flight that already has a subscription', async () => {
    const h = harness();
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    const outcome = await h.poll(row);

    expect(h.posts()).toHaveLength(0);
    expect(outcome.nextPollAt).toBeNull();
  });

  it('before the window, schedules the next poll for the moment it opens', async () => {
    const now = new Date(DEPARTURE - 26 * HOUR); // 4-hourly band; +4 h would overshoot T-24 h
    const on = harness({ now });
    const off = harness({ now, webhooks: false });
    const row = b6FlightRow();
    on.db.addFlight(row);
    off.db.addFlight(row);

    const withWebhooks = await on.poll(row);
    const without = await off.poll(row);

    expect(on.posts()).toHaveLength(0);
    expect(withWebhooks.nextPollAt).toEqual(new Date(DEPARTURE - 24 * HOUR));
    expect(without.nextPollAt).toEqual(new Date(now.getTime() + LADDER_INTERVALS.EVERY_4H));
  });
});

describe('landed + 30 min: unsubscribe, then archive (§7.6)', () => {
  const afterLanding = new Date(LANDED + 31 * MINUTE);

  it('unsubscribes the last holder, clears the id and archives', async () => {
    const h = harness({ now: afterLanding, mutate: landed });
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    const outcome = await h.poll(row);

    expect(outcome).toMatchObject({ kind: 'updated', archived: true, nextPollAt: null });
    expect(h.deletes().map((r) => r.url)).toEqual([
      `https://aerodatabox.p.rapidapi.com/subscriptions/webhook/${SUB}`,
    ]);
    const stored = h.db.flight(row.id);
    expect(stored.archived_at).toBe(afterLanding.toISOString());
    expect(stored.alert_subscription_id).toBeNull();
    expect(h.count()).toBe(2); // lookup + delete
  });

  it('leaves a subscription that another active leg still uses', async () => {
    const h = harness({ now: afterLanding, mutate: landed });
    h.db.addFlight(b6FlightRow({ id: 'next-leg', origin_iata: 'LAS', alert_subscription_id: SUB }));
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    await h.poll(row);

    expect(h.deletes()).toHaveLength(0);
    expect(h.db.flight(row.id).archived_at).not.toBeNull();
    expect(h.db.flight('next-leg').alert_subscription_id).toBe(SUB);
  });

  it('archives anyway when the unsubscribe fails; reconcile cleans up', async () => {
    const h = harness({ now: afterLanding, mutate: landed, subscriptions: { deleteStatus: 500 } });
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    const outcome = await h.poll(row);

    expect(outcome).toMatchObject({ kind: 'updated', archived: true });
    expect(h.db.flight(row.id).archived_at).not.toBeNull();
    expect(h.db.flight(row.id).alert_subscription_id).toBeNull();
  });

  it('unsubscribes even with webhooks now off, so no subscription is leaked', async () => {
    const h = harness({ now: afterLanding, mutate: landed, webhooks: false });
    const row = h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB }));

    await h.poll(row);

    expect(h.deletes()).toHaveLength(1);
  });
});
