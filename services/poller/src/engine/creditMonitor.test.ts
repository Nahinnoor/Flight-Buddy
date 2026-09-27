/**
 * `credit-check` (§7.7, ADR 0003 decision 3): thresholds, the zero-balance sweep,
 * the operator alert value, and the credit state the poll pass reads.
 *
 * The end-to-end drill (job + poll pass, criterion 7) is `creditFailover.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  FAILOVER_SUBSCRIBED_FLIGHTS_SQL,
  FAILOVER_SWEEP_CEILING_MS,
  createCreditCheckHandler,
  createCreditState,
  crossedThreshold,
  pollWebhookSettings,
  runCreditCheck,
  type CreditCheckDeps,
  type OperatorAlert,
} from './creditMonitor';
import { createMemoryDb } from './memoryDb';
import { CREDIT_LOG_SOURCES, readLatestCreditBalance } from './repository';
import {
  DEFAULT_SUBSCRIPTION_ID as SUB,
  FAKE_WEBHOOK_TOKEN,
  FAKE_WEBHOOK_URL,
  b6FlightRow,
  captureLogger,
  countingLimiter,
  fixtureProvider,
} from './testFixtures';

const NOW = new Date('2026-09-11T20:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const OPERATOR = '0f5e7a2c-3b1d-4e8f-9a6b-5c4d3e2f1a0b';

const CHECK = CREDIT_LOG_SOURCES.BALANCE_CHECK;
const WEBHOOK = CREDIT_LOG_SOURCES.WEBHOOK_PAYLOAD;
const REFILL = CREDIT_LOG_SOURCES.POST_REFILL;

interface Options {
  balance?: number | null | (() => number | null);
  balanceStatus?: number;
  webhooksEnabled?: boolean;
  seed?: { balance: number; source: string }[];
  onOperatorAlert?: (alert: OperatorAlert) => Promise<void>;
  operatorUserId?: string;
  drillZero?: boolean;
}

function harness(options: Options = {}) {
  const db = createMemoryDb({ now: NOW });
  db.creditLog.push(...(options.seed ?? []));
  const fx = fixtureProvider('flights-number-live-today', {
    balance: options.balance === undefined ? 500 : options.balance,
    ...(options.balanceStatus === undefined ? {} : { balanceStatus: options.balanceStatus }),
  });
  const { limiter, count } = countingLimiter();
  const log = captureLogger();
  const creditState = createCreditState();
  const deps: CreditCheckDeps = {
    pool: db.pool,
    provider: fx.provider,
    rateLimiter: limiter,
    logger: log.logger,
    webhooksEnabled: options.webhooksEnabled ?? true,
    creditState,
    operatorUserId: options.operatorUserId,
    ...(options.onOperatorAlert === undefined ? {} : { onOperatorAlert: options.onOperatorAlert }),
    ...(options.drillZero === undefined ? {} : { drillZero: options.drillZero }),
    now: () => NOW,
  };
  return { db, fx, count, log, creditState, deps, run: () => runCreditCheck(deps) };
}

/** Run the job over a sequence of readings; returns the alert thresholds raised, `null` for none. */
async function alertsFor(readings: number[], seed: { balance: number; source: string }[] = []) {
  let current = 0;
  const h = harness({ balance: () => current, seed });
  const raised: (number | null)[] = [];
  for (const reading of readings) {
    current = reading;
    const result = await h.run();
    raised.push(result.alert?.threshold ?? null);
  }
  return { raised, h };
}

describe('crossedThreshold', () => {
  it('first ever reading: every mark is armed, and the lowest reached is named', () => {
    const none = new Set<number>();
    expect(crossedThreshold(480, none)).toBeNull();
    expect(crossedThreshold(300, none)).toBe(300);
    expect(crossedThreshold(250, none)).toBe(300);
    expect(crossedThreshold(40, none)).toBe(100);
    expect(crossedThreshold(0, none)).toBe(0);
    expect(crossedThreshold(-3, none)).toBe(0);
  });

  it('a disarmed mark does not alert again; a lower armed one still does', () => {
    expect(crossedThreshold(250, new Set([300]))).toBeNull();
    expect(crossedThreshold(90, new Set([300]))).toBe(100);
    expect(crossedThreshold(0, new Set([300, 100]))).toBe(0);
    expect(crossedThreshold(0, new Set([300, 100, 0]))).toBeNull();
  });
});

describe('credit-check thresholds (alert on a downward crossing, once)', () => {
  it('first ever run with a healthy balance: no alert, reading recorded', async () => {
    const h = harness({ balance: 480 });

    const result = await h.run();

    expect(result).toMatchObject({
      skipped: false,
      balance: 480,
      previousBalance: null,
      logged: true,
      alert: null,
    });
    expect(h.db.creditLog).toEqual([{ balance: 480, source: CHECK }]);
    expect(h.count()).toBe(1);
  });

  it('first ever run already below a mark: alerts once, naming the lowest reached', async () => {
    const { raised } = await alertsFor([40, 40]);
    expect(raised).toEqual([100, null]);
  });

  it('a balance sitting at 250 alerts once, not every hour', async () => {
    const { raised } = await alertsFor([480, 250, 250, 249, 250]);
    expect(raised).toEqual([null, 300, null, null, null]);
  });

  it('300 → 50 in one step is one alert naming 100', async () => {
    const { raised, h } = await alertsFor([320, 50]);
    expect(raised).toEqual([null, 100]);
    expect(h.log.records().filter((r) => r.operatorAlert !== undefined)).toHaveLength(1);
  });

  it('equal readings on a mark alert once', async () => {
    const { raised } = await alertsFor([300, 300, 100, 100]);
    expect(raised).toEqual([300, null, 100, null]);
  });

  it('a refill re-arms the marks it rose above, so the next fall alerts again', async () => {
    const { raised } = await alertsFor([250, 90, 600, 280, 95]);
    expect(raised).toEqual([300, 100, null, 300, 100]);
  });

  it('a post_refill row in between re-arms, even with no balance_check above the mark', async () => {
    const seed = [
      { balance: 250, source: CHECK },
      { balance: 90, source: CHECK },
      { balance: 1_000, source: REFILL },
    ];
    const { raised, h } = await alertsFor([280], seed);
    expect(raised).toEqual([300]);
    expect(h.db.creditLog.at(-1)).toEqual({ balance: 280, source: CHECK });
  });

  it('a webhook delivery that logged the low balance first does not swallow the alert', async () => {
    // The drain logs balances but never alerts. Were "previous row above the mark"
    // the rule, this 0 would make the job's 0 look like no change.
    const h = harness({
      balance: 0,
      seed: [
        { balance: 120, source: CHECK },
        { balance: 0, source: WEBHOOK },
      ],
    });

    const result = await h.run();

    expect(result.previousBalance).toBe(0);
    expect(result.alert).toMatchObject({ kind: 'credit_exhausted', threshold: 0 });
  });

  it('a webhook balance above a mark re-arms it', async () => {
    const { raised } = await alertsFor(
      [250],
      [
        { balance: 250, source: CHECK },
        { balance: 310, source: WEBHOOK },
      ],
    );
    expect(raised).toEqual([300]);
  });
});

describe('credit-check operator alert (the wave 5 seam)', () => {
  it('low: returns a typed value, logs it at warn, and hands it to the sink', async () => {
    const received: OperatorAlert[] = [];
    const h = harness({
      balance: 250,
      seed: [{ balance: 420, source: CHECK }],
      operatorUserId: OPERATOR,
      onOperatorAlert: async (alert) => {
        received.push(alert);
      },
    });

    const result = await h.run();

    const expected: OperatorAlert = {
      kind: 'credit_low',
      severity: 'warn',
      threshold: 300,
      balance: 250,
      previousBalance: 420,
      failedOverFlightIds: [],
      recipientUserId: OPERATOR,
      observedAt: NOW.toISOString(),
    };
    expect(result.alert).toEqual(expected);
    expect(received).toEqual([expected]);
    const line = h.log.records().find((r) => r.operatorAlert === 'credit_low');
    expect(line).toMatchObject({
      level: 'warn',
      threshold: 300,
      balance: 250,
      operatorConfigured: true,
    });
  });

  it('never logs the operator user id', async () => {
    const h = harness({ balance: 0, operatorUserId: OPERATOR });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB, next_poll_at: null }));

    await h.run();

    expect(h.log.text()).not.toContain(OPERATOR);
    expect(h.log.text()).not.toContain(FAKE_WEBHOOK_TOKEN);
  });

  it('carries a null recipient when OPERATOR_USER_ID is unset, and says so in the log', async () => {
    const h = harness({ balance: 90 });

    const result = await h.run();

    expect(result.alert?.recipientUserId).toBeNull();
    expect(h.log.records().find((r) => r.operatorAlert)).toMatchObject({
      operatorConfigured: false,
    });
  });

  it('a failing sink is logged and swallowed; the reading stays recorded', async () => {
    const h = harness({
      balance: 50,
      onOperatorAlert: async () => {
        throw new TypeError('push transport down');
      },
    });

    const result = await h.run();

    expect(result.alert?.threshold).toBe(100);
    expect(h.db.creditLog).toHaveLength(1);
    const failure = h.log
      .records()
      .find(
        (r) =>
          r.msg === 'operator alert could not be delivered; the log line above stands in for it',
      );
    expect(failure).toMatchObject({ level: 'error', errorName: 'TypeError' });
    expect(h.log.text()).not.toContain('push transport down');
  });
});

describe('credit-check zero-balance failover (§7.7 step 3)', () => {
  it('puts every subscribed flight back on the ladder now, keeps the id, and alerts at error', async () => {
    const h = harness({ balance: 0, seed: [{ balance: 40, source: CHECK }] });
    const backup = h.db.addFlight(
      b6FlightRow({ id: 'on-backup', alert_subscription_id: SUB, next_poll_at: at(2 * HOUR) }),
    );
    const noBackup = h.db.addFlight(
      b6FlightRow({
        id: 'no-backup',
        operating_flight_number: '1412',
        alert_subscription_id: SUB,
        next_poll_at: null,
      }),
    );

    const result = await h.run();

    expect(result.failedOverFlightIds.sort()).toEqual(['no-backup', 'on-backup']);
    for (const row of [backup, noBackup]) {
      expect(h.db.flight(row.id).next_poll_at).toBe(NOW.toISOString());
      expect(h.db.flight(row.id).alert_subscription_id).toBe(SUB);
    }
    expect(result.alert).toMatchObject({
      kind: 'credit_exhausted',
      severity: 'error',
      threshold: 0,
      failedOverFlightIds: expect.arrayContaining(['on-backup', 'no-backup']),
    });
    expect(h.log.records().find((r) => r.operatorAlert === 'credit_exhausted')).toMatchObject({
      level: 'error',
      failedOver: 2,
    });
    expect(h.creditState.exhausted()).toBe(true);
    expect(h.db.creditLog.at(-1)).toEqual({ balance: 0, source: CHECK });
  });

  it('flips the credit state before the sweep, so a pass that claims a swept row already runs in failover', async () => {
    // The poll loop is not awaited by this job: it reads the state when it starts a
    // pass, then claims. If the state flipped only after the sweep, a pass starting
    // in between would claim the rows just made due with webhooks still on and write
    // the backup cadence straight back. Record the state at the instant the sweep runs.
    const h = harness({ balance: 0 });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB, next_poll_at: at(2 * HOUR) }));
    const exhaustedAtSweep: boolean[] = [];
    const inner = h.db.pool;
    h.deps.pool = {
      ...inner,
      query: (config: { text: string }, ...rest: unknown[]) => {
        if (config.text === FAILOVER_SUBSCRIBED_FLIGHTS_SQL)
          exhaustedAtSweep.push(h.creditState.exhausted());
        return (inner.query as (...args: unknown[]) => unknown)(config, ...rest);
      },
    } as unknown as typeof inner;

    const result = await h.run();

    expect(result.failedOverFlightIds).toEqual(['flight-b6']);
    expect(exhaustedAtSweep).toEqual([true]);
    expect(pollWebhookSettings(FAKE_WEBHOOK_URL, h.creditState)).toEqual({
      webhooksEnabled: false,
    });
  });

  it('touches only subscribed, unarchived rows (an unsubscribed live flight is left to the ladder)', async () => {
    const h = harness({ balance: 0 });
    h.db.addFlight(b6FlightRow({ id: 'unsubscribed-live', next_poll_at: at(15 * MINUTE) }));
    h.db.addFlight(
      b6FlightRow({
        id: 'archived',
        operating_flight_number: '1412',
        alert_subscription_id: SUB,
        next_poll_at: null,
        archived_at: at(-HOUR),
      }),
    );

    const result = await h.run();

    expect(result.failedOverFlightIds).toEqual([]);
    expect(h.db.flight('unsubscribed-live').next_poll_at).toBe(at(15 * MINUTE));
    expect(h.db.flight('archived').next_poll_at).toBeNull();
  });

  it('leaves a subscribed row already on the failover ladder alone (no hourly pull-forward)', async () => {
    const h = harness({ balance: 0 });
    h.db.addFlight(
      b6FlightRow({
        id: 'within',
        alert_subscription_id: SUB,
        next_poll_at: at(FAILOVER_SWEEP_CEILING_MS),
      }),
    );
    h.db.addFlight(
      b6FlightRow({
        id: 'beyond',
        operating_flight_number: '1412',
        alert_subscription_id: SUB,
        next_poll_at: at(FAILOVER_SWEEP_CEILING_MS + 1),
      }),
    );

    const result = await h.run();

    expect(result.failedOverFlightIds).toEqual(['beyond']);
    expect(h.db.flight('within').next_poll_at).toBe(at(FAILOVER_SWEEP_CEILING_MS));
  });

  it('is idempotent: a redelivered run changes no flight and raises no second alert', async () => {
    const h = harness({ balance: 0 });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB, next_poll_at: at(2 * HOUR) }));

    const first = await h.run();
    const snapshot = structuredClone([...h.db.flights.values()]);
    const second = await h.run();

    expect(first.failedOverFlightIds).toHaveLength(1);
    expect(second.failedOverFlightIds).toEqual([]);
    expect(second.alert).toBeNull();
    expect([...h.db.flights.values()]).toEqual(snapshot);
    expect(h.log.records().filter((r) => r.operatorAlert !== undefined)).toHaveLength(1);
  });

  it('still at zero an hour later: sweeps a row that drifted back to the backup cadence, without a new alert', async () => {
    const h = harness({ balance: 0 });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB, next_poll_at: null }));
    await h.run();
    // A poll in flight during the sweep wrote the backup cadence back.
    h.db.flight('flight-b6').next_poll_at = at(2 * HOUR);

    const later = await h.run();

    expect(later.failedOverFlightIds).toEqual(['flight-b6']);
    expect(later.alert).toBeNull();
    expect(
      h.log
        .records()
        .find(
          (r) =>
            r.msg ===
            'alert credits still exhausted; subscribed flights put back on the polling ladder',
        ),
    ).toBeDefined();
  });

  it('a failed sweep logs nothing, so the next run alerts and sweeps again', async () => {
    const h = harness({ balance: 0 });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB, next_poll_at: null }));
    h.db.failOn(FAILOVER_SUBSCRIBED_FLIGHTS_SQL, new Error('connection reset'));

    await expect(h.run()).rejects.toThrow('connection reset');
    expect(h.db.creditLog).toEqual([]);

    const retry = await h.run();
    expect(retry.alert?.kind).toBe('credit_exhausted');
    expect(retry.failedOverFlightIds).toEqual(['flight-b6']);
  });

  it('above zero: no sweep at all', async () => {
    const h = harness({ balance: 1 });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB, next_poll_at: null }));

    const result = await h.run();

    expect(result.failedOverFlightIds).toEqual([]);
    expect(h.db.flight('flight-b6').next_poll_at).toBeNull();
    expect(h.creditState.exhausted()).toBe(false);
  });

  it("reads the provider's empty 200 (the captured sample) as zero and fails over", async () => {
    const h = harness({ balance: null });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB, next_poll_at: null }));

    const result = await h.run();

    expect(result.balance).toBe(0);
    expect(result.failedOverFlightIds).toEqual(['flight-b6']);
  });
});

describe('credit drill (CREDIT_DRILL_ZERO, criterion 7 manual half)', () => {
  it('reads 0 without asking the provider, records it as a drill, fails over and alerts once', async () => {
    const h = harness({ drillZero: true, balance: 250, seed: [{ balance: 60, source: CHECK }] });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB, next_poll_at: at(2 * HOUR) }));

    const result = await h.run();

    expect(h.count()).toBe(0);
    expect(h.fx.requests).toHaveLength(0);
    expect(result.balance).toBe(0);
    expect(h.db.creditLog.at(-1)).toEqual({ balance: 0, source: CREDIT_LOG_SOURCES.DRILL });
    expect(result.failedOverFlightIds).toEqual(['flight-b6']);
    expect(result.alert).toMatchObject({ kind: 'credit_exhausted', threshold: 0 });
    expect(h.creditState.exhausted()).toBe(true);
    expect(h.log.records().some((r) => r.level === 'error' && r.creditDrill === true)).toBe(true);
  });

  it('a second drill hour does not alert again (the drill row disarms the zero mark)', async () => {
    const h = harness({ drillZero: true, seed: [{ balance: 60, source: CHECK }] });

    const first = await h.run();
    const second = await h.run();

    expect(first.alert?.kind).toBe('credit_exhausted');
    expect(second.alert).toBeNull();
  });

  it('after the drill, a real reading above zero recovers and re-arms the mark', async () => {
    const h = harness({ balance: 58, seed: [{ balance: 60, source: CHECK }] });
    h.deps.drillZero = true;
    await h.run();
    expect(h.creditState.exhausted()).toBe(true);

    h.deps.drillZero = false;
    const recovered = await h.run();

    expect(recovered.balance).toBe(58);
    expect(h.creditState.exhausted()).toBe(false);
    expect(h.db.creditLog.at(-1)).toEqual({ balance: 58, source: CHECK });
  });

  it('a restart after the drill seeds from the last real reading, not the forced zero', async () => {
    const h = harness({ drillZero: true, seed: [{ balance: 60, source: CHECK }] });
    await h.run();
    expect(h.db.creditLog.at(-1)?.source).toBe(CREDIT_LOG_SOURCES.DRILL);

    // What `main.ts` does at boot, with the drill switch already unset.
    const reseeded = createCreditState(await readLatestCreditBalance(h.db.pool));

    expect(reseeded.exhausted()).toBe(false);
  });

  it('off by default: the provider is asked and the reading is a real balance_check', async () => {
    const h = harness({ balance: 250 });
    const result = await h.run();
    expect(result.balance).toBe(250);
    expect(h.db.creditLog.at(-1)?.source).toBe(CHECK);
  });
});

describe('credit-check failure and no-op paths', () => {
  it('does nothing at all when webhooks are off', async () => {
    const h = harness({ balance: 0, webhooksEnabled: false });
    h.db.addFlight(b6FlightRow({ alert_subscription_id: SUB, next_poll_at: null }));

    const result = await h.run();

    expect(result.skipped).toBe(true);
    expect(h.fx.requests).toHaveLength(0);
    expect(h.db.creditLog).toEqual([]);
    expect(h.db.flight('flight-b6').next_poll_at).toBeNull();
  });

  it('a provider failure is logged at error, records nothing and leaves the state alone', async () => {
    const h = harness({ balanceStatus: 503 });
    h.creditState.observe(0);

    const result = await h.run();

    expect(result.skipped).toBe(true);
    expect(h.db.creditLog).toEqual([]);
    expect(h.creditState.exhausted()).toBe(true);
    const line = h.log.records().find((r) => r.job === 'credit-check');
    expect(line).toMatchObject({ level: 'error', errorName: expect.any(String) });
    expect(h.log.text()).not.toContain('test-key');
  });

  it('does not record a balance the int column cannot hold', async () => {
    const h = harness({ balance: 3_000_000_000 });

    const result = await h.run();

    expect(result.logged).toBe(false);
    expect(h.db.creditLog).toEqual([]);
  });

  it('the pg-boss handler runs the check', async () => {
    const h = harness({ balance: 90 });

    await createCreditCheckHandler(h.deps)();

    expect(h.db.creditLog).toEqual([{ balance: 90, source: CHECK }]);
  });
});

describe('credit state and the poll pass settings', () => {
  it('seeds from the last logged balance; unknown is healthy', () => {
    expect(createCreditState().exhausted()).toBe(false);
    expect(createCreditState(null).exhausted()).toBe(false);
    expect(createCreditState(12).exhausted()).toBe(false);
    expect(createCreditState(0).exhausted()).toBe(true);
    expect(createCreditState(-1).exhausted()).toBe(true);
  });

  it('follows readings, and ignores an unknown one', () => {
    const state = createCreditState(50);
    state.observe(0);
    expect(state.exhausted()).toBe(true);
    state.observe(null);
    expect(state.exhausted()).toBe(true);
    state.observe(500);
    expect(state.exhausted()).toBe(false);
  });

  it('exhausted credits run the pass as if WEBHOOK_URL were unset', () => {
    expect(pollWebhookSettings(FAKE_WEBHOOK_URL, createCreditState(500))).toEqual({
      webhooksEnabled: true,
      webhookUrl: FAKE_WEBHOOK_URL,
    });
    expect(pollWebhookSettings(FAKE_WEBHOOK_URL, createCreditState(0))).toEqual({
      webhooksEnabled: false,
    });
    expect(pollWebhookSettings(undefined, createCreditState(500))).toEqual({
      webhooksEnabled: false,
    });
  });
});
