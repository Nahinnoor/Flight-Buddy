/**
 * Operator alerts (§7.7 step 4, ADR 0003 decision 4): the credit monitor's
 * `onOperatorAlert` → the sink → the `operator-alert` job → one push to
 * `OPERATOR_USER_ID`, degrading to the log line and never looping.
 */
import { describe, expect, it } from 'vitest';

import { createCreditState, runCreditCheck } from '../engine/creditMonitor';
import { createMemoryDb } from '../engine/memoryDb';
import { captureLogger, fixtureProvider } from '../engine/testFixtures';
import {
  FAKE_TOKEN_A,
  FAKE_TOKEN_B,
  errorTicket,
  fakeExpo,
  okTicket,
  type FakeExpoOptions,
} from './fakeExpo';
import {
  PUSH_ALERT_THROTTLE_MS,
  createOperatorAlertHandler,
  createOperatorAlertSink,
  operatorCopy,
  sendOperatorAlert,
  type OperatorNotice,
} from './operatorAlerts';

const OPERATOR = '99999999-9999-4999-8999-999999999999';
const LOW: OperatorNotice = { kind: 'credit_low', threshold: 100, balance: 94, failedOver: 0 };

function operatorSetup(
  options: {
    token?: string | null;
    tokens?: string[];
    expo?: FakeExpoOptions;
    operatorUserId?: string;
  } = {},
) {
  const db = createMemoryDb();
  if (options.token !== undefined || options.tokens !== undefined) {
    db.addTraveller({
      userId: OPERATOR,
      flightIds: [],
      token: options.token ?? null,
      tokens: options.tokens,
    });
  }
  const expo = fakeExpo(options.expo);
  const log = captureLogger();
  const deps = {
    pool: db.pool,
    expo: expo.client,
    logger: log.logger,
    operatorUserId: 'operatorUserId' in options ? options.operatorUserId : OPERATOR,
  };
  return { db, expo, log, deps };
}

describe('sendOperatorAlert', () => {
  it('with a token: sends one push to the operator, ids-free copy, kind only in data', async () => {
    const s = operatorSetup({ token: FAKE_TOKEN_A });

    await expect(sendOperatorAlert(LOW, s.deps)).resolves.toBe('sent');

    expect(s.expo.messages()).toHaveLength(1);
    expect(s.expo.messages()[0]).toMatchObject({
      to: FAKE_TOKEN_A,
      title: 'FlightBuddy: alert credits low',
      body: 'Balance 94, at or below 100. Refill by hand.',
      data: { kind: 'credit_low' },
    });
    // Nothing about the operator or the token reaches the log.
    expect(s.log.text()).not.toContain(OPERATOR);
    expect(s.log.text()).not.toContain('ExponentPushToken');
  });

  it('without an active device: no push, a log line, no throw', async () => {
    const s = operatorSetup({ token: null });

    await expect(sendOperatorAlert(LOW, s.deps)).resolves.toBe('no_token');

    expect(s.expo.sent).toHaveLength(0);
    expect(s.log.text()).toContain('no active push device');
  });

  it('fans out to every active device of the operator, in one request', async () => {
    const s = operatorSetup({ tokens: [FAKE_TOKEN_A, FAKE_TOKEN_B] });

    await expect(sendOperatorAlert(LOW, s.deps)).resolves.toBe('sent');

    expect(s.expo.sent).toHaveLength(1);
    expect(
      s.expo
        .messages()
        .map((m) => m.to)
        .sort(),
    ).toEqual([FAKE_TOKEN_A, FAKE_TOKEN_B]);
    expect(s.expo.messages().every((m) => m.title === 'FlightBuddy: alert credits low')).toBe(true);
    expect(s.log.text()).not.toContain('ExponentPushToken');
  });

  it('skips an invalidated device of the operator', async () => {
    const s = operatorSetup({ tokens: [FAKE_TOKEN_A, FAKE_TOKEN_B] });
    const dead = s.db.device(FAKE_TOKEN_B);
    if (dead) {
      dead.invalidated_at = new Date().toISOString();
      dead.invalidated_reason = 'device_not_registered';
    }

    await sendOperatorAlert(LOW, s.deps);

    expect(s.expo.messages().map((m) => m.to)).toEqual([FAKE_TOKEN_A]);
  });

  it('one dead operator device is invalidated; the alert still counts as sent', async () => {
    const s = operatorSetup({
      tokens: [FAKE_TOKEN_A, FAKE_TOKEN_B],
      expo: {
        send: {
          tickets: (m) =>
            m.to === FAKE_TOKEN_B ? errorTicket('DeviceNotRegistered', m.to) : okTicket(),
        },
      },
    });

    await expect(sendOperatorAlert(LOW, s.deps)).resolves.toBe('sent');

    expect(s.db.device(FAKE_TOKEN_B)?.invalidated_reason).toBe('device_not_registered');
    expect(s.db.device(FAKE_TOKEN_A)?.invalidated_at).toBeNull();
    expect(s.db.pushTokenEvents).toHaveLength(1);
  });

  it('without OPERATOR_USER_ID: no query, no push, no throw', async () => {
    const s = operatorSetup({ operatorUserId: undefined });

    await expect(sendOperatorAlert(LOW, s.deps)).resolves.toBe('no_operator');

    expect(s.expo.sent).toHaveLength(0);
    expect(s.db.statements).toHaveLength(0);
  });

  it('Expo unavailable: throws so pg-boss retries, and raises nothing', async () => {
    const s = operatorSetup({ token: FAKE_TOKEN_A, expo: { send: { status: 503 } } });

    await expect(sendOperatorAlert(LOW, s.deps)).rejects.toMatchObject({ kind: 'unavailable' });
    // There is no sink on this path at all: a failure cannot become another alert.
    expect(s.log.text()).toContain('pg-boss will retry');
  });

  it('a dead operator device is invalidated and not retried; the profile column is left alone', async () => {
    const s = operatorSetup({
      token: FAKE_TOKEN_A,
      expo: { send: { tickets: (m) => errorTicket('DeviceNotRegistered', m.to) } },
    });

    await expect(sendOperatorAlert(LOW, s.deps)).resolves.toBe('failed');

    expect(s.db.device(FAKE_TOKEN_A)?.invalidated_reason).toBe('device_not_registered');
    expect(s.db.profiles.get(OPERATOR)?.expo_push_token).toBe(FAKE_TOKEN_A);
  });

  it('the job handler drops data that does not parse', async () => {
    const s = operatorSetup({ token: FAKE_TOKEN_A });
    const handler = createOperatorAlertHandler(s.deps);

    await handler([{ data: { kind: 'nonsense' } }, { data: LOW }]);

    expect(s.expo.messages()).toHaveLength(1);
  });

  it('has copy for every kind', () => {
    for (const notice of [
      LOW,
      { kind: 'credit_exhausted', threshold: 0, balance: 0, failedOver: 3 },
      { kind: 'push_credentials_invalid', count: 2 },
      { kind: 'push_unauthorized' },
    ] as OperatorNotice[]) {
      const copy = operatorCopy(notice);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeLessThan(178);
    }
  });
});

describe('createOperatorAlertSink', () => {
  it('queues the notice when an operator is configured', async () => {
    const queued: OperatorNotice[] = [];
    const sink = createOperatorAlertSink({
      operatorUserId: OPERATOR,
      logger: captureLogger().logger,
      enqueue: async (notice) => void queued.push(notice),
    });

    await sink.raise(LOW);

    expect(queued).toEqual([LOW]);
  });

  it('with no OPERATOR_USER_ID: logs that the log line is the alert, queues nothing', async () => {
    const queued: OperatorNotice[] = [];
    const log = captureLogger();
    const sink = createOperatorAlertSink({
      operatorUserId: undefined,
      logger: log.logger,
      enqueue: async (notice) => void queued.push(notice),
    });

    await sink.raise(LOW);

    expect(queued).toEqual([]);
    expect(log.text()).toContain('no OPERATOR_USER_ID configured');
  });

  it('never throws when the queue does', async () => {
    const log = captureLogger();
    const sink = createOperatorAlertSink({
      operatorUserId: OPERATOR,
      logger: log.logger,
      enqueue: async () => {
        throw new Error('database down');
      },
    });

    await expect(sink.raise(LOW)).resolves.toBeUndefined();
    expect(log.text()).toContain('could not be queued');
    expect(log.text()).not.toContain('database down');
  });

  it('throttles the push-pipeline kinds, not the credit kinds', async () => {
    const queued: OperatorNotice[] = [];
    let now = new Date('2026-09-26T00:00:00.000Z');
    const sink = createOperatorAlertSink({
      operatorUserId: OPERATOR,
      logger: captureLogger().logger,
      enqueue: async (notice) => void queued.push(notice),
      now: () => now,
    });

    await sink.raise({ kind: 'push_unauthorized' });
    await sink.raise({ kind: 'push_unauthorized' });
    await sink.raise(LOW);
    await sink.raise(LOW);
    now = new Date(now.getTime() + PUSH_ALERT_THROTTLE_MS);
    await sink.raise({ kind: 'push_unauthorized' });

    expect(queued.map((n) => n.kind)).toEqual([
      'push_unauthorized',
      'credit_low',
      'credit_low',
      'push_unauthorized',
    ]);
  });
});

describe('credit-check → operator push (criterion 7, "the operator is alerted")', () => {
  it('a zero crossing reaches the operator’s phone through the queue', async () => {
    const s = operatorSetup({ token: FAKE_TOKEN_A });
    const { provider } = fixtureProvider('flights-number-live-today', { balance: 0 });
    // The queue, collapsed: enqueue runs the job handler directly.
    const handler = createOperatorAlertHandler(s.deps);
    const sink = createOperatorAlertSink({
      operatorUserId: OPERATOR,
      logger: s.log.logger,
      enqueue: (notice) => handler([{ data: notice }]),
    });

    await runCreditCheck({
      pool: s.db.pool,
      provider,
      rateLimiter: { acquire: async () => undefined },
      logger: s.log.logger,
      webhooksEnabled: true,
      creditState: createCreditState(null),
      operatorUserId: OPERATOR,
      onOperatorAlert: (alert) =>
        sink.raise({
          kind: alert.kind,
          threshold: alert.threshold,
          balance: alert.balance,
          failedOver: alert.failedOverFlightIds.length,
        }),
    });

    expect(s.expo.messages()).toHaveLength(1);
    expect(s.expo.messages()[0]?.title).toBe('FlightBuddy: alert credits exhausted');
    // The log line is written first and stays the fallback.
    expect(s.log.text()).toContain('OPERATOR ALERT');
  });
});
