/**
 * The drain drill: PHASE2_PLAN §1 criterion 7, the automated half (§7.7 requires it).
 *
 * > With the dev credit balance drained to zero, every subscribed flight goes back
 * > on the polling ladder within one run of the hourly credit job, a gate change
 * > during that degraded window is still notified exactly once, and the operator
 * > is alerted.
 *
 * ## Why the in-memory database, not a real Postgres
 *
 * The property under test is a *sequence across components* — the credit job, the
 * shared credit state, the poll pass, the ladder, `ingestFlight`, change detection
 * and the subscription lifecycle — not a concurrency question. `memoryDb.ts`
 * dispatches on the engine's exported SQL constants (an unrecognised statement
 * throws), runs the real `pg` flights writer, and runs in every `npm test`; the
 * fixture provider is the real AeroDataBox client over captured bodies. A
 * `*.integration.test.ts` is skipped unless `INTEGRATION=1`, so it would never
 * prove this criterion in the default suite, and it would still need a fake
 * provider. What this cannot prove is Postgres's reading of the sweep's `update`
 * predicate; that is the manual drill's job.
 *
 * Nor does it interleave the job with the loop. Every step here is awaited in
 * turn, so it proves the sequence, not that a pass starting *while the job runs*
 * still sees the failover. That depends on the state flipping before the sweep,
 * which `creditMonitor.test.ts` pins directly.
 *
 * ## The two rows
 *
 * Shaped after what the deployed stack held at once on 2026-09-16: one `live`
 * flight subscribed and on the two-hour backup cadence, and one `live` flight
 * inside T-24 h that has not subscribed. Both are captured B6 legs here — the
 * second renumbered to 1412 — because those are the bodies we have.
 */
import { createFeedHealthCache, type FlightDataProvider } from '@flightbuddy/flight-provider';
import { describe, expect, it } from 'vitest';

import { createCreditState, pollWebhookSettings, runCreditCheck } from './creditMonitor';
import { LADDER_INTERVALS } from './ladder';
import { createMemoryDb } from './memoryDb';
import { CREDIT_LOG_SOURCES, readLatestCreditBalance } from './repository';
import {
  DEFAULT_SUBSCRIPTION_ID as SUB,
  FAKE_WEBHOOK_URL,
  b6FlightRow,
  captureLogger,
  countingLimiter,
  fixtureProvider,
  withDepartureGate,
} from './testFixtures';
import { runPollPass } from './tick';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DEPARTURE = Date.parse('2026-09-12T01:59:00.000Z');
/** T-5 h: inside the window, on the 15-minute failover band. */
const START = DEPARTURE - 5 * HOUR;
const BACKUP_MS = 2 * HOUR;

const SUBSCRIBED = 'flight-dl1019-shape';
const UNSUBSCRIBED = 'flight-dl1748-shape';
const NEW_SUB = '9b2e4c61-2222-4d3a-8e7f-6a5b4c3d2e10';

function drill() {
  let now = new Date(START);
  let credits = 40;
  let gate: string | null = null;

  const db = createMemoryDb({ now });
  // The subscribed flight's lookups: the captured leg, with whatever gate the test sets.
  const subscribedFx = fixtureProvider('flights-number-live-today', {
    allLive: true,
    balance: () => credits,
    subscriptions: { createId: NEW_SUB },
    mutate: (legs) => withDepartureGate(gate)(legs),
  });
  // The unsubscribed flight's lookups: the same leg, renumbered.
  const unsubscribedFx = fixtureProvider('flights-number-live-today', {
    allLive: true,
    mutate: (legs) => legs.map((leg) => ({ ...leg, number: 'B6 1412' })),
  });
  // One provider, routed by flight number; subscribe/balance calls go to the first.
  const provider: FlightDataProvider = {
    ...subscribedFx.provider,
    lookupFlight: (number, dateLocal) =>
      number.endsWith('1412')
        ? unsubscribedFx.provider.lookupFlight(number, dateLocal)
        : subscribedFx.provider.lookupFlight(number, dateLocal),
  };

  const { limiter } = countingLimiter();
  const log = captureLogger();
  // Seeded as `main.ts` does at boot: the last reading was healthy-ish.
  db.creditLog.push({ balance: 40, source: CREDIT_LOG_SOURCES.BALANCE_CHECK });
  const creditState = createCreditState(40);
  const feedHealthCache = createFeedHealthCache();

  db.addFlight(
    b6FlightRow({
      id: SUBSCRIBED,
      alert_subscription_id: SUB,
      alert_subscribed_at: new Date(START - 19 * HOUR).toISOString(),
      next_poll_at: new Date(START + BACKUP_MS).toISOString(),
    }),
  );
  db.addFlight(
    b6FlightRow({
      id: UNSUBSCRIBED,
      operating_flight_number: '1412',
      // Due now: its next poll lands in the zero-balance window.
      next_poll_at: new Date(START).toISOString(),
    }),
  );

  const creditCheck = () =>
    runCreditCheck({
      pool: db.pool,
      provider,
      rateLimiter: limiter,
      logger: log.logger,
      webhooksEnabled: true,
      creditState,
      now: () => now,
    });

  /** One worker pass, exactly as `main.ts`'s `tick` builds it. */
  const pollPass = () =>
    runPollPass({
      pool: db.pool,
      provider,
      writer: db.writer,
      rateLimiter: limiter,
      logger: log.logger,
      feedHealthCache,
      ...pollWebhookSettings(FAKE_WEBHOOK_URL, creditState),
      webhookBackupIntervalMs: BACKUP_MS,
      batchSize: 25,
      now: () => now,
      rng: () => 0.5,
    });

  return {
    db,
    log,
    creditState,
    creditCheck,
    pollPass,
    subscribes: () => subscribedFx.requests.filter((r) => r.method === 'POST'),
    unsubscribes: () => subscribedFx.requests.filter((r) => r.method === 'DELETE'),
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      db.setNow(now);
    },
    now: () => now,
    setCredits(value: number) {
      credits = value;
    },
    setGate(value: string | null) {
      gate = value;
    },
    gateEvents: (flightId: string) =>
      db.events.filter((e) => e.flight_id === flightId && e.event_type === 'gate_change'),
  };
}

describe('criterion 7: a drained credit balance falls back to polling without losing an alert', () => {
  it('fails over within one run, notifies a degraded-window gate change once, and recovers', async () => {
    const d = drill();

    // --- the balance drains to zero; one run of the hourly job -----------------
    d.setCredits(0);
    const first = await d.creditCheck();

    // Subscribed flight: back on the ladder now, subscription kept.
    expect(first.failedOverFlightIds).toEqual([SUBSCRIBED]);
    expect(d.db.flight(SUBSCRIBED).next_poll_at).toBe(d.now().toISOString());
    expect(d.db.flight(SUBSCRIBED).alert_subscription_id).toBe(SUB);
    // Unsubscribed live flight: not the sweep's business.
    expect(d.db.flight(UNSUBSCRIBED).next_poll_at).toBe(new Date(START).toISOString());
    // Operator alerted: the typed value, and the error-level log line standing in for the push.
    expect(first.alert).toMatchObject({
      kind: 'credit_exhausted',
      threshold: 0,
      balance: 0,
      previousBalance: 40,
      failedOverFlightIds: [SUBSCRIBED],
    });
    expect(d.log.records().filter((r) => r.operatorAlert === 'credit_exhausted')).toEqual([
      expect.objectContaining({ level: 'error' }),
    ]);
    // The reading is in the log.
    expect(d.db.creditLog.at(-1)).toEqual({ balance: 0, source: CREDIT_LOG_SOURCES.BALANCE_CHECK });
    expect(d.creditState.exhausted()).toBe(true);

    // --- the same job again (redelivery / catch-up): nothing further ------------
    const flightsBefore = structuredClone([...d.db.flights.values()]);
    const second = await d.creditCheck();
    expect(second.failedOverFlightIds).toEqual([]);
    expect(second.alert).toBeNull();
    expect([...d.db.flights.values()]).toEqual(flightsBefore);
    expect(d.log.records().filter((r) => r.operatorAlert !== undefined)).toHaveLength(1);

    // --- degraded window: the gate changes, and only polling can see it ---------
    d.setGate('B22');
    const pass = await d.pollPass();
    expect(pass.claimed).toBe(2);

    // Exactly one gate_change event, from the poll.
    expect(d.gateEvents(SUBSCRIBED)).toEqual([
      expect.objectContaining({
        source: 'poll',
        new_value: expect.objectContaining({ gate: 'B22' }),
      }),
    ]);
    // On the failover ladder (15 min at T-5 h), not the two-hour backup cadence.
    const failoverNext = new Date(d.now().getTime() + LADDER_INTERVALS.EVERY_15M).toISOString();
    expect(d.db.flight(SUBSCRIBED).next_poll_at).toBe(failoverNext);
    expect(d.db.flight(SUBSCRIBED).alert_subscription_id).toBe(SUB);
    // The unsubscribed live flight inside T-24 h did NOT open a subscription against
    // an empty balance, and is polled on the same failover ladder.
    expect(d.subscribes()).toEqual([]);
    expect(d.db.flight(UNSUBSCRIBED).alert_subscription_id).toBeNull();
    expect(d.db.flight(UNSUBSCRIBED).next_poll_at).toBe(failoverNext);
    expect(d.unsubscribes()).toEqual([]);

    // Later passes in the window see the same gate: no duplicate (criterion 8).
    for (let i = 0; i < 3; i += 1) {
      d.advance(LADDER_INTERVALS.EVERY_15M);
      await d.pollPass();
    }
    expect(d.gateEvents(SUBSCRIBED)).toHaveLength(1);
    expect(d.subscribes()).toEqual([]);

    // An hour on, still zero: the job neither alerts nor pulls anyone forward.
    const stillZero = await d.creditCheck();
    expect(stillZero.alert).toBeNull();
    expect(stillZero.failedOverFlightIds).toEqual([]);

    // --- the owner refills; the next hourly run notices ---------------------------
    d.advance(MINUTE);
    d.setCredits(500);
    const refilled = await d.creditCheck();
    expect(refilled.alert).toBeNull();
    expect(refilled.failedOverFlightIds).toEqual([]);
    expect(d.creditState.exhausted()).toBe(false);

    // Recovery is the existing poll path: the subscribed row goes back to the
    // backup cadence with the subscription it kept (no provider call), and the
    // unsubscribed live flight subscribes on its next poll.
    d.advance(LADDER_INTERVALS.EVERY_15M);
    await d.pollPass();
    expect(d.db.flight(SUBSCRIBED).alert_subscription_id).toBe(SUB);
    expect(d.db.flight(SUBSCRIBED).next_poll_at).toBe(
      new Date(d.now().getTime() + BACKUP_MS).toISOString(),
    );
    expect(d.subscribes()).toHaveLength(1);
    expect(d.db.flight(UNSUBSCRIBED).alert_subscription_id).toBe(NEW_SUB);
    expect(d.gateEvents(SUBSCRIBED)).toHaveLength(1);
  });

  it('a worker restarted mid-outage keeps failing over (state seeded from the log)', async () => {
    const d = drill();
    d.setCredits(0);
    await d.creditCheck();

    // What `main.ts` does at boot: read the latest row and seed a fresh state.
    const reseeded = createCreditState(await readLatestCreditBalance(d.db.pool));

    expect(reseeded.exhausted()).toBe(true);
    expect(pollWebhookSettings(FAKE_WEBHOOK_URL, reseeded)).toEqual({ webhooksEnabled: false });
  });
});
