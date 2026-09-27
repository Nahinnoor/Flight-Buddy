/**
 * PHASE2_PLAN criterion 8: when a poll and a webhook detect the same change, one
 * `flight_events` row results.
 *
 * Both paths diff against the stored last-known value and write the fresh value
 * back, so whichever runs second sees nothing new. That needs them never to
 * process one flight at the same time, which the shared `poll_lease_until` lease
 * guarantees. Each case runs both paths against one stateful database and counts
 * the rows.
 */
import { createFeedHealthCache, type FlightDataProvider } from '@flightbuddy/flight-provider';
import { describe, expect, it } from 'vitest';

import { FAKE_TOKEN_A, fakeExpo } from '../push/fakeExpo';
import { runPushSend } from '../push/pushSend';
import { claimDueFlights } from './lease';
import { createMemoryDb } from './memoryDb';
import { pollAndUpdate } from './poll';
import { runPollPass } from './tick';
import { drainWebhookInbox } from './webhookIngest';
import {
  DEFAULT_SUBSCRIPTION_ID as SUB,
  FAKE_WEBHOOK_URL,
  alertEnvelope,
  b6FlightRow,
  captureLogger,
  countingLimiter,
  fixtureProvider,
  withDepartureGate,
} from './testFixtures';

const NOW = new Date('2026-09-11T20:00:00.000Z');
const FLIGHT = 'flight-b6';
const USER = '11111111-1111-4111-8111-111111111111';

/** Gate B24 → B99 as seen by both paths: the poll and the webhook agree. */
function scenario(options: { wrapProvider?: (p: FlightDataProvider) => FlightDataProvider } = {}) {
  const db = createMemoryDb({ now: NOW });
  db.addFlight(
    b6FlightRow({
      gate: 'B24',
      alert_subscription_id: SUB,
      alert_subscribed_at: '2026-09-11T02:00:00.000Z',
    }),
  );
  const fx = fixtureProvider('flights-number-live-today', {
    allLive: true,
    mutate: withDepartureGate('B99'),
  });
  const provider = options.wrapProvider ? options.wrapProvider(fx.provider) : fx.provider;
  const { limiter } = countingLimiter();
  const { logger } = captureLogger();
  const common = {
    pool: db.pool,
    provider,
    writer: db.writer,
    rateLimiter: limiter,
    logger,
    now: () => NOW,
    rng: () => 0.5,
    webhooksEnabled: true,
    feedHealthCache: createFeedHealthCache(),
  };

  const deliver = () =>
    db.addInbox({
      subscription_id: SUB,
      payload: alertEnvelope({ mutate: withDepartureGate('B99') }),
    });
  const drain = () => drainWebhookInbox(common);
  /** Make the flight due, the way the landed+30 poll or a failover would. */
  const makeDue = () => {
    db.flight(FLIGHT).next_poll_at = NOW.toISOString();
  };
  const pollPass = () => runPollPass({ ...common, webhookUrl: FAKE_WEBHOOK_URL, batchSize: 25 });
  const gateEvents = () => db.events.filter((e) => e.event_type === 'gate_change');

  // Wave 5: the flight is on one user's own trip, with a push token.
  db.addTraveller({ userId: USER, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
  const expo = fakeExpo();
  const wakeUps: number[] = [];
  const pushSend = () => runPushSend({ pool: db.pool, expo: expo.client, logger, now: () => NOW });

  return { db, fx, deliver, drain, makeDue, pollPass, gateEvents, common, expo, pushSend, wakeUps };
}

describe('criterion 8: one change, one flight_events row', () => {
  it('webhook first, then a poll of the same data: zero new events', async () => {
    const s = scenario();
    s.deliver();

    await s.drain();
    expect(s.gateEvents()).toHaveLength(1);
    expect(s.gateEvents()[0]?.source).toBe('webhook');

    s.makeDue();
    const pass = await s.pollPass();

    expect(pass.claimed).toBe(1);
    expect(pass.events).toBe(0);
    expect(s.gateEvents()).toHaveLength(1);
    expect(s.db.events).toHaveLength(1);
  });

  it('poll first, then the webhook: zero new events, and no verification poll either', async () => {
    const s = scenario();
    s.makeDue();

    await s.pollPass();
    expect(s.gateEvents()).toHaveLength(1);
    expect(s.gateEvents()[0]?.source).toBe('poll');
    const lookupsAfterPoll = s.fx.lookups().length;

    s.deliver();
    const summary = await s.drain();

    expect(summary.processed).toBe(1);
    expect(summary.events).toBe(0);
    // The webhook saw no change against the stored B99, so nothing needed confirming.
    expect(s.fx.lookups()).toHaveLength(lookupsAfterPoll);
    expect(s.db.events).toHaveLength(1);
  });

  it('a delivery arriving while a poll holds the flight waits, then finds nothing new', async () => {
    const s = scenario();
    s.makeDue();
    s.deliver();

    // The poll has claimed (leased) the flight and is mid-request.
    const [claimed] = await claimDueFlights(s.db.pool, 25);
    expect(claimed?.id).toBe(FLIGHT);

    const during = await s.drain();
    expect(during.deferred).toBe(1);

    await pollAndUpdate(claimed!, { ...s.common, webhookUrl: FAKE_WEBHOOK_URL });
    expect(s.db.events).toHaveLength(1);

    const after = await s.drain();
    expect(after.processed).toBe(1);
    expect(after.events).toBe(0);
    expect(s.db.events).toHaveLength(1);
  });

  it('a poll coming due while the webhook holds the flight cannot claim it', async () => {
    let claimedDuringVerification: string[] | null = null;
    let db: ReturnType<typeof createMemoryDb> | null = null;
    const s = scenario({
      // The verification poll is the webhook path's one provider call. While it is
      // in flight, a poll pass tries to claim the (due) flight.
      wrapProvider: (inner) => ({
        ...inner,
        lookupFlight: async (number, date) => {
          const rows = await claimDueFlights((db as NonNullable<typeof db>).pool, 25);
          claimedDuringVerification = rows.map((row) => row.id);
          return inner.lookupFlight(number, date);
        },
      }),
    });
    db = s.db;
    s.makeDue();
    s.deliver();

    await s.drain();

    expect(claimedDuringVerification).toEqual([]);
    expect(s.db.events).toHaveLength(1);

    // Lease handed back; the poll that was held off now finds nothing new.
    s.makeDue();
    const pass = await s.pollPass();
    expect(pass.events).toBe(0);
    expect(s.db.events).toHaveLength(1);
  });

  it('one change seen by both paths gives one delivery and one push (criterion 8)', async () => {
    const s = scenario();
    const wake = (count: number) => void s.wakeUps.push(count);

    // Webhook first (it wakes push-send), then a poll of the same data.
    s.deliver();
    await drainWebhookInbox({ ...s.common, onDeliveriesCreated: wake });
    s.makeDue();
    await runPollPass({
      ...s.common,
      webhookUrl: FAKE_WEBHOOK_URL,
      batchSize: 25,
      onDeliveriesCreated: wake,
    });

    // And the sweep runs as well as the wake-up: two send runs.
    await s.pushSend();
    await s.pushSend();

    expect(s.db.events).toHaveLength(1);
    expect(s.db.deliveries).toHaveLength(1);
    expect(s.wakeUps).toEqual([1]);
    expect(s.expo.messages()).toHaveLength(1);
    expect(s.expo.messages()[0]).toMatchObject({
      to: FAKE_TOKEN_A,
      data: { eventType: 'gate_change' },
    });
    expect(s.db.deliveries[0]?.status).toBe('sent');
  });

  it('poll first, then the webhook: still one push', async () => {
    const s = scenario();
    s.makeDue();
    await s.pollPass();
    s.deliver();
    await s.drain();

    await s.pushSend();

    expect(s.db.deliveries).toHaveLength(1);
    expect(s.expo.messages()).toHaveLength(1);
  });
});
