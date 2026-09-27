/**
 * Wave 5 end to end over the stateful memory database: flight event → recipients
 * → `notification_deliveries` → Expo (a fake `fetch` answering documented shapes)
 * → receipts → dead-token clearing (PHASE2_PLAN criteria 8 and 10, §8.10, §9).
 */
import { describe, expect, it } from 'vitest';

import type { DetectedEvent } from '../engine/changeDetector';
import { createMemoryDb } from '../engine/memoryDb';
import { recordFlightEvents } from '../engine/repository';
import { b6FlightRow, captureLogger, fixtureBody } from '../engine/testFixtures';
import {
  DELIVERY_ERRORS,
  MAX_CRITICAL_DELIVERY_AGE_MS,
  MAX_DELIVERY_AGE_MS,
  MAX_SEND_ATTEMPTS,
  RECEIPT_DELAY_MS,
  RECEIPT_RETENTION_MS,
  SEND_LEASE_MS,
} from './deliveryStatus';
import {
  FAKE_ACCESS_TOKEN,
  FAKE_TOKEN_A,
  FAKE_TOKEN_B,
  FAKE_TOKEN_NEW,
  errorTicket,
  fakeExpo,
  okTicket,
  type FakeExpoOptions,
} from './fakeExpo';
import type { OperatorNotice } from './operatorAlerts';
import { runPushReceipts } from './pushReceipts';
import { CLAIM_DELIVERIES_SQL, runPushSend } from './pushSend';
import { pushTokenSha256 } from './tokens';

const NOW = new Date('2026-09-11T20:00:00.000Z');
const FLIGHT = 'flight-b6';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const GATE_CHANGE: DetectedEvent = {
  type: 'gate_change',
  previousValue: { gate: 'B24', terminal: '5' },
  newValue: { gate: 'B99', terminal: '5' },
  source: 'poll',
};
const CANCELLED: DetectedEvent = {
  type: 'cancelled',
  previousValue: { status: 'scheduled' },
  newValue: { status: 'cancelled' },
  source: 'poll',
};

function setup(expoOptions: FakeExpoOptions = {}) {
  const db = createMemoryDb({ now: NOW });
  db.addFlight(b6FlightRow({ gate: 'B99' }));
  const expo = fakeExpo(expoOptions);
  const log = captureLogger();
  const alerts: OperatorNotice[] = [];
  let clock = NOW;
  const at = (date: Date) => {
    clock = date;
    db.setNow(date);
  };
  const deps = {
    pool: db.pool,
    expo: expo.client,
    logger: log.logger,
    operatorAlerts: { raise: async (notice: OperatorNotice) => void alerts.push(notice) },
    now: () => clock,
  };
  return {
    db,
    expo,
    log,
    alerts,
    at,
    record: (events: DetectedEvent[] = [GATE_CHANGE], notify = events.map((e) => e.type)) =>
      recordFlightEvents(db.pool, FLIGHT, events, notify),
    send: () => runPushSend(deps),
    receipts: () => runPushReceipts(deps),
  };
}

const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('fan-out: event → recipients → deliveries (§9, Phase 2 own flights)', () => {
  it('a flight in two users’ trips gives two deliveries', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    s.db.addTraveller({ userId: USER_B, flightIds: [FLIGHT], token: FAKE_TOKEN_B });

    const recorded = await s.record();

    expect(recorded.deliveries).toBe(2);
    expect(s.db.deliveries.map((d) => d.user_id).sort()).toEqual([USER_A, USER_B]);
    expect(
      s.db.deliveries.every((d) => d.status === 'pending' && d.recipient_reason === 'own_flight'),
    ).toBe(true);
  });

  it('an unclaimed traveller’s flight has no recipient in Phase 2', async () => {
    const s = setup();
    s.db.addTraveller({ userId: null, flightIds: [FLIGHT] });

    const recorded = await s.record();

    expect(recorded.eventIds).toHaveLength(1);
    expect(recorded.deliveries).toBe(0);
    expect(s.db.deliveries).toHaveLength(0);
  });

  it('one user with the flight on two segments still gets one delivery', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT, FLIGHT], token: FAKE_TOKEN_A });
    expect((await s.record()).deliveries).toBe(1);
  });

  it('an event the policy suppressed is recorded but notifies nobody', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });

    const recorded = await s.record([GATE_CHANGE], []);

    expect(s.db.events).toHaveLength(1);
    expect(recorded.deliveries).toBe(0);
  });

  it('cancelled, reinstated, cancelled again: the second cancellation notifies too', async () => {
    // At this layer a real re-cancellation is indistinguishable from a status
    // bounce, and swallowing it could cost the traveller the flight (§9).
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });

    await s.record([CANCELLED]);
    const second = await s.record([CANCELLED]);

    expect(s.db.events.filter((e) => e.event_type === 'cancelled')).toHaveLength(2);
    expect(second.deliveries).toBe(1);
    expect(s.db.deliveries).toHaveLength(2);
  });

  it('a second departed event does not notify again (it physically happens once)', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    const departed: DetectedEvent = {
      type: 'departed',
      previousValue: { actualDepartureUtc: null },
      newValue: { actualDepartureUtc: '2026-09-11T20:05:00.000Z' },
      source: 'poll',
    };

    await s.record([departed]);
    const second = await s.record([departed]);

    expect(second.deliveries).toBe(0);
    expect(s.db.deliveries).toHaveLength(1);
  });

  it('a second gate change is new news and notifies again', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();
    expect((await s.record()).deliveries).toBe(1);
  });
});

describe('push-send', () => {
  it('sends one message per delivery and records the ticket and token fingerprint', async () => {
    const s = setup({ accessToken: FAKE_ACCESS_TOKEN });
    s.db.addTraveller({
      userId: USER_A,
      flightIds: [FLIGHT],
      token: FAKE_TOKEN_A,
      marketing: { carrier: 'DL', number: '9001' },
    });
    const { eventIds } = await s.record();

    const summary = await s.send();

    expect(summary).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    const [message] = s.expo.messages();
    expect(message).toMatchObject({
      to: FAKE_TOKEN_A,
      title: 'DL 9001 gate change: B99',
      data: { flightId: FLIGHT, eventType: 'gate_change' },
      collapseId: eventIds[0],
      sound: 'default',
      priority: 'high',
    });
    // Ids only in the payload (§5).
    expect(Object.keys(message?.data ?? {}).sort()).toEqual(['eventType', 'flightId']);
    expect(s.expo.headers[0]?.authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);

    const [row] = s.db.deliveries;
    expect(row).toMatchObject({ status: 'sent', attempts: 1, error: null, claimed_until: null });
    expect(row?.expo_ticket_id).toMatch(/^0f3a9d2c-/);
    expect(row?.push_token_sha256).toBe(pushTokenSha256(FAKE_TOKEN_A));
    expect(row?.sent_at).toBe(NOW.toISOString());
  });

  it('the same delivery is never sent twice by two runs', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();

    await s.send();
    const second = await s.send();

    expect(second.claimed).toBe(0);
    expect(s.expo.messages()).toHaveLength(1);
  });

  it('two users on one flight get one message each, in one request', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    s.db.addTraveller({ userId: USER_B, flightIds: [FLIGHT], token: FAKE_TOKEN_B });
    await s.record();

    await s.send();

    expect(s.expo.sent).toHaveLength(1);
    expect(
      s.expo
        .messages()
        .map((m) => m.to)
        .sort(),
    ).toEqual([FAKE_TOKEN_A, FAKE_TOKEN_B]);
  });

  it('batches at most 100 messages per request', async () => {
    const s = setup();
    for (let i = 0; i < 150; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      s.db.addTraveller({
        userId: id,
        flightIds: [FLIGHT],
        token: `ExponentPushToken[FAKE-many-${i}]`,
      });
    }
    await s.record();

    const summary = await s.send();

    expect(summary.sent).toBe(150);
    expect(s.expo.sent.map((batch) => batch.length)).toEqual([100, 50]);
  });

  it('a recipient with no token is skipped, not sent', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: null });
    await s.record();

    const summary = await s.send();

    expect(summary.skipped).toBe(1);
    expect(s.expo.sent).toHaveLength(0);
    expect(s.db.deliveries[0]).toMatchObject({
      status: 'skipped',
      error: DELIVERY_ERRORS.NO_PUSH_TOKEN,
    });
  });

  it('a malformed token is failed without a request', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: 'not-a-token' });
    await s.record();

    await s.send();

    expect(s.expo.sent).toHaveLength(0);
    expect(s.db.deliveries[0]).toMatchObject({
      status: 'failed',
      error: DELIVERY_ERRORS.INVALID_PUSH_TOKEN,
    });
  });

  it('a cancellation older than the short window is still sent after an outage', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record([CANCELLED]);

    s.at(later(MAX_DELIVERY_AGE_MS + 60 * 60_000));
    await s.send();

    expect(s.expo.sent).toHaveLength(1);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent' });
  });

  it('even a cancellation expires once the trip is two days past', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record([CANCELLED]);

    s.at(later(MAX_CRITICAL_DELIVERY_AGE_MS + 60_000));
    await s.send();

    expect(s.expo.sent).toHaveLength(0);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'expired', error: DELIVERY_ERRORS.EXPIRED });
  });

  it('an event older than the send window expires instead of arriving late', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();

    s.at(later(MAX_DELIVERY_AGE_MS + 60_000));
    await s.send();

    expect(s.expo.sent).toHaveLength(0);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'expired', error: DELIVERY_ERRORS.EXPIRED });
  });

  it('DeviceNotRegistered on the ticket fails the row and clears the token', async () => {
    const s = setup({ send: { tickets: (m) => errorTicket('DeviceNotRegistered', m.to) } });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();

    const summary = await s.send();

    expect(summary.tokensCleared).toBe(1);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'failed', error: 'DeviceNotRegistered' });
    expect(s.db.profiles.get(USER_A)?.expo_push_token).toBeNull();
  });

  it('429 puts the row back to pending with a back-off, then it is sent', async () => {
    let answer: FakeExpoOptions['send'] = {
      status: 429,
      body: { errors: [{ code: 'TOO_MANY_REQUESTS', message: 'x' }] },
    };
    const s = setup({ send: () => answer as never });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();

    const first = await s.send();
    expect(first.retrying).toBe(1);
    const row = s.db.deliveries[0];
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row?.not_before).toBe(later(60_000).toISOString());

    // Not claimable before the back-off.
    expect((await s.send()).claimed).toBe(0);

    answer = { tickets: () => okTicket() };
    s.at(later(61_000));
    const retry = await s.send();
    expect(retry.sent).toBe(1);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a 400 closes the rows as failed with Expo’s code', async () => {
    const s = setup({
      send: {
        status: 400,
        body: { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'x' }] },
      },
    });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();

    await s.send();

    expect(s.db.deliveries[0]).toMatchObject({
      status: 'failed',
      error: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
    });
  });

  it('a 401 is retried and raises one operator alert', async () => {
    const s = setup({
      send: { status: 401, body: { errors: [{ code: 'UNAUTHORIZED', message: 'x' }] } },
    });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();

    await s.send();

    expect(s.db.deliveries[0]?.status).toBe('pending');
    expect(s.alerts).toEqual([{ kind: 'push_unauthorized' }]);
  });

  it('InvalidCredentials on a ticket raises an operator alert', async () => {
    const s = setup({ send: { tickets: () => errorTicket('InvalidCredentials') } });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();

    await s.send();

    expect(s.alerts).toEqual([{ kind: 'push_credentials_invalid', count: 1 }]);
  });

  it('crash window: a send interrupted after the claim is re-sent once the lease passes, with the same collapse id', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    const { eventIds } = await s.record();

    // A worker claims the row and dies before recording anything.
    await s.db.pool.query({
      text: CLAIM_DELIVERIES_SQL,
      values: [100, SEND_LEASE_MS, MAX_SEND_ATTEMPTS],
    });
    expect(s.db.deliveries[0]?.status).toBe('sending');

    // Still leased: nobody else touches it.
    expect((await s.send()).claimed).toBe(0);

    s.at(later(SEND_LEASE_MS + 1_000));
    const retry = await s.send();

    expect(retry.sent).toBe(1);
    expect(s.expo.messages()[0]?.collapseId).toBe(eventIds[0]);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a network failure is retried (at-least-once), and closed as SendOutcomeUnknown when attempts run out', async () => {
    const s = setup({ send: { throws: new TypeError('fetch failed') } });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();

    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
      s.at(later(i * 20 * 60_000));
      await s.send();
    }

    expect(s.expo.sent).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(s.db.deliveries[0]).toMatchObject({
      status: 'failed',
      attempts: MAX_SEND_ATTEMPTS,
      error: DELIVERY_ERRORS.SEND_OUTCOME_UNKNOWN,
    });
  });

  it('logs no push token, no title and no body', async () => {
    const s = setup({ send: { tickets: (m) => errorTicket('DeviceNotRegistered', m.to) } });
    s.db.addTraveller({
      userId: USER_A,
      flightIds: [FLIGHT],
      token: FAKE_TOKEN_A,
      marketing: { carrier: 'DL', number: '9001' },
    });
    await s.record();

    await s.send();

    const text = s.log.text();
    expect(text).not.toContain('FAKE-test-token');
    expect(text).not.toContain('ExponentPushToken');
    expect(text).not.toContain('DL 9001');
    expect(text).not.toContain('B99');
    expect(text).toContain('DeviceNotRegistered');
  });
});

describe('push-receipts (§8.10, criterion 10)', () => {
  /** A sent delivery for USER_A, and the ticket id it got. */
  async function sentDelivery(receipt: (ticketId: string) => Record<string, unknown> | undefined) {
    let ticketId = '';
    const s = setup({
      send: {
        tickets: () => {
          const ticket = okTicket();
          ticketId = String(ticket.id);
          return ticket;
        },
      },
      receipts: () => {
        const answer = receipt(ticketId);
        return answer === undefined ? {} : { [ticketId]: answer };
      },
    });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();
    await s.send();
    return s;
  }

  it('does not ask before Expo has had 15 minutes', async () => {
    const s = await sentDelivery(() => ({ status: 'ok' }));
    s.at(later(RECEIPT_DELAY_MS - 60_000));

    await s.receipts();

    expect(s.expo.receiptRequests).toHaveLength(0);
    expect(s.db.deliveries[0]?.status).toBe('sent');
  });

  it('an ok receipt marks the row delivered', async () => {
    const s = await sentDelivery(() => ({ status: 'ok' }));
    s.at(later(RECEIPT_DELAY_MS));

    const summary = await s.receipts();

    expect(summary.delivered).toBe(1);
    expect(s.db.deliveries[0]?.status).toBe('delivered');
  });

  it('a recorded DeviceNotRegistered receipt clears that profile’s token', async () => {
    // The DeviceNotRegistered receipt from `docs/api-samples/expo-push-receipts.json`,
    // served under this row's ticket id.
    const recorded = JSON.parse(fixtureBody('expo-push-receipts')) as {
      data: Record<string, unknown>;
    };
    const s = await sentDelivery(
      () => recorded.data['0f3a9d2c-1111-4c3e-9e2a-5b7c1d000002'] as Record<string, unknown>,
    );
    s.at(later(RECEIPT_DELAY_MS));

    const summary = await s.receipts();

    expect(summary).toMatchObject({ failed: 1, tokensCleared: 1, tokensKept: 0 });
    expect(s.db.deliveries[0]).toMatchObject({ status: 'failed', error: 'DeviceNotRegistered' });
    expect(s.db.profiles.get(USER_A)?.expo_push_token).toBeNull();
  });

  it('a token replaced between send and receipt is NOT cleared', async () => {
    const s = await sentDelivery(() => errorTicket('DeviceNotRegistered', FAKE_TOKEN_A));
    // The user reinstalled and the app registered a new token meanwhile.
    const profile = s.db.profiles.get(USER_A);
    if (profile) profile.expo_push_token = FAKE_TOKEN_NEW;
    s.at(later(RECEIPT_DELAY_MS));

    const summary = await s.receipts();

    expect(summary).toMatchObject({ failed: 1, tokensCleared: 0, tokensKept: 1 });
    expect(s.db.profiles.get(USER_A)?.expo_push_token).toBe(FAKE_TOKEN_NEW);
  });

  it('InvalidCredentials raises one operator alert', async () => {
    const s = await sentDelivery(() => errorTicket('InvalidCredentials'));
    s.at(later(RECEIPT_DELAY_MS));

    await s.receipts();

    expect(s.alerts).toEqual([{ kind: 'push_credentials_invalid', count: 1 }]);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'failed', error: 'InvalidCredentials' });
  });

  it.each(['MessageTooBig', 'MismatchSenderId'])(
    '%s fails the row and keeps the token',
    async (code) => {
      const s = await sentDelivery(() => errorTicket(code));
      s.at(later(RECEIPT_DELAY_MS));

      await s.receipts();

      expect(s.db.deliveries[0]).toMatchObject({ status: 'failed', error: code });
      expect(s.db.profiles.get(USER_A)?.expo_push_token).toBe(FAKE_TOKEN_A);
      expect(s.alerts).toEqual([]);
    },
  );

  it('MessageRateExceeded sends it again later', async () => {
    const s = await sentDelivery(() => errorTicket('MessageRateExceeded'));
    s.at(later(RECEIPT_DELAY_MS));

    const summary = await s.receipts();

    expect(summary.requeued).toBe(1);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'pending', expo_ticket_id: null });
  });

  it('a missing receipt waits, and is not asked about again for 15 minutes', async () => {
    const s = await sentDelivery(() => undefined);
    s.at(later(RECEIPT_DELAY_MS));

    expect((await s.receipts()).waiting).toBe(1);
    expect((await s.receipts()).checked).toBe(0);
    expect(s.db.deliveries[0]?.status).toBe('sent');
  });

  it('past Expo’s 24 h retention the row becomes unconfirmed without a request', async () => {
    const s = await sentDelivery(() => undefined);
    s.at(later(RECEIPT_RETENTION_MS + 60_000));

    await s.receipts();

    expect(s.expo.receiptRequests).toHaveLength(0);
    expect(s.db.deliveries[0]).toMatchObject({
      status: 'unconfirmed',
      error: DELIVERY_ERRORS.RECEIPT_UNAVAILABLE,
    });
  });

  it('a failed receipts request leaves rows for the next run', async () => {
    const s = setup({ receiptsStatus: 503 });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();
    await s.send();
    s.at(later(RECEIPT_DELAY_MS));

    await s.receipts();

    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent', receipt_checked_at: null });
  });
});
