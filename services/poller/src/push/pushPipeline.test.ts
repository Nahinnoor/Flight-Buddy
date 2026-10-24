/**
 * Wave 5 end to end over the stateful memory database: flight event → recipients
 * → `notification_deliveries` → every active device (ADR 0006) → Expo (a fake
 * `fetch` answering documented shapes) → receipts per device → dead-device
 * invalidation (PHASE2_PLAN criteria 8 and 10, §8.10, §9). Tokens are synthetic.
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
import { MAX_DEVICES_PER_RECIPIENT, recordDeviceSends } from './deviceSends';
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

  it('a recipient whose only device is invalidated is skipped as NoPushToken', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    const dead = s.db.device(FAKE_TOKEN_A);
    if (dead) {
      dead.invalidated_at = NOW.toISOString();
      dead.invalidated_reason = 'device_not_registered';
    }
    await s.record();

    await s.send();

    expect(s.expo.sent).toHaveLength(0);
    expect(s.db.deviceSends).toHaveLength(0);
    expect(s.db.deliveries[0]).toMatchObject({
      status: 'skipped',
      error: DELIVERY_ERRORS.NO_PUSH_TOKEN,
    });
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

  it('DeviceNotRegistered on the ticket fails the row and invalidates that device', async () => {
    const s = setup({ send: { tickets: (m) => errorTicket('DeviceNotRegistered', m.to) } });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();

    const summary = await s.send();

    expect(summary.devicesInvalidated).toBe(1);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'failed', error: 'DeviceNotRegistered' });
    expect(s.db.device(FAKE_TOKEN_A)).toMatchObject({
      invalidated_at: NOW.toISOString(),
      invalidated_reason: 'device_not_registered',
    });
    expect(s.db.pushTokenEvents).toEqual([
      expect.objectContaining({
        user_id: USER_A,
        token_sha256: pushTokenSha256(FAKE_TOKEN_A),
        event: 'device_not_registered',
      }),
    ]);
    // The legacy column is no longer the worker's to write (ADR 0006).
    expect(s.db.profiles.get(USER_A)?.expo_push_token).toBe(FAKE_TOKEN_A);
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

describe('every active device (ADR 0006, sub-step ii)', () => {
  const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

  /** USER_A with a phone (registered earlier) and a tablet (registered later). */
  function twoDevices(expoOptions: FakeExpoOptions = {}) {
    const s = setup(expoOptions);
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT] });
    s.db.registerDevice(USER_A, FAKE_TOKEN_A, at(60));
    s.db.registerDevice(USER_A, FAKE_TOKEN_B, at(30));
    return s;
  }

  it('two devices both get the message: one delivery, two device rows, same collapse id', async () => {
    const s = twoDevices();
    const { eventIds } = await s.record();

    const summary = await s.send();

    expect(s.db.deliveries).toHaveLength(1);
    expect(summary).toMatchObject({ claimed: 1, messages: 2, sent: 2, failed: 0 });
    expect(s.expo.sent).toHaveLength(1);
    // Newest device first.
    expect(s.expo.messages().map((m) => m.to)).toEqual([FAKE_TOKEN_B, FAKE_TOKEN_A]);
    expect(s.expo.messages().every((m) => m.collapseId === eventIds[0])).toBe(true);
    expect(s.db.deviceSends.map((d) => d.status)).toEqual(['sent', 'sent']);
    expect(s.db.deviceSends.every((d) => d.expo_ticket_id !== null)).toBe(true);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent', error: null });
  });

  it('one dead device is invalidated while the other stays and the delivery is sent', async () => {
    const s = twoDevices({
      send: {
        tickets: (m) =>
          m.to === FAKE_TOKEN_B ? errorTicket('DeviceNotRegistered', m.to) : okTicket(),
      },
    });
    await s.record();

    const summary = await s.send();

    expect(summary).toMatchObject({ sent: 1, failed: 1, devicesInvalidated: 1 });
    expect(s.db.device(FAKE_TOKEN_B)?.invalidated_reason).toBe('device_not_registered');
    expect(s.db.device(FAKE_TOKEN_A)?.invalidated_at).toBeNull();
    expect(s.db.pushTokenEvents.map((e) => e.token_sha256)).toEqual([
      pushTokenSha256(FAKE_TOKEN_B),
    ]);
    // `sent` if any device got a ticket; the representative ticket is the phone's.
    expect(s.db.deliveries[0]).toMatchObject({
      status: 'sent',
      error: null,
      push_token_sha256: pushTokenSha256(FAKE_TOKEN_A),
    });

    // The next event goes to the surviving device only.
    await s.record();
    await s.send();
    expect(s.expo.sent[1]?.map((m) => m.to)).toEqual([FAKE_TOKEN_A]);
  });

  it('receipts per device: one delivered, one dead → delivered, only the dead device invalidated', async () => {
    const tickets = new Map<string, string>();
    const s = twoDevices({
      send: {
        tickets: (m) => {
          const ticket = okTicket();
          tickets.set(m.to, String(ticket.id));
          return ticket;
        },
      },
      receipts: () => ({
        [tickets.get(FAKE_TOKEN_A) ?? '']: { status: 'ok' },
        [tickets.get(FAKE_TOKEN_B) ?? '']: errorTicket('DeviceNotRegistered', FAKE_TOKEN_B),
      }),
    });
    await s.record();
    await s.send();
    s.at(later(RECEIPT_DELAY_MS));

    const summary = await s.receipts();

    expect(summary).toMatchObject({ checked: 2, delivered: 1, failed: 1, devicesInvalidated: 1 });
    expect(s.expo.receiptRequests).toHaveLength(1);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'delivered', error: null });
    expect(s.db.device(FAKE_TOKEN_A)?.invalidated_at).toBeNull();
    expect(s.db.device(FAKE_TOKEN_B)?.invalidated_at).not.toBeNull();
  });

  it('every device dead → failed with the device code', async () => {
    const s = twoDevices({ send: { tickets: (m) => errorTicket('DeviceNotRegistered', m.to) } });
    await s.record();

    await s.send();

    expect(s.db.deliveries[0]).toMatchObject({ status: 'failed', error: 'DeviceNotRegistered' });
    expect(s.db.pushTokens.every((t) => t.invalidated_at !== null)).toBe(true);
    expect(s.db.pushTokenEvents).toHaveLength(2);
  });

  it('a retry after a crash does not re-send to a device that already holds a ticket', async () => {
    const s = twoDevices();
    await s.record();

    // A worker claims the delivery, gets a ticket for the phone, records it, and
    // dies before the tablet's request (or the finalize) is written.
    await s.db.pool.query({
      text: CLAIM_DELIVERIES_SQL,
      values: [100, SEND_LEASE_MS, MAX_SEND_ATTEMPTS],
    });
    const deliveryId = s.db.deliveries[0]?.id as string;
    await recordDeviceSends(s.db.pool, [
      {
        deliveryId,
        tokenSha256: pushTokenSha256(FAKE_TOKEN_A),
        status: 'sent',
        ticketId: 'ticket-from-the-dead-worker',
        error: null,
      },
    ]);

    s.at(later(SEND_LEASE_MS + 1_000));
    const retry = await s.send();

    expect(retry).toMatchObject({ claimed: 1, messages: 1, sent: 1 });
    expect(s.expo.messages().map((m) => m.to)).toEqual([FAKE_TOKEN_B]);
    expect(
      s.db.deviceSends.find((d) => d.token_sha256 === pushTokenSha256(FAKE_TOKEN_A)),
    ).toMatchObject({ status: 'sent', expo_ticket_id: 'ticket-from-the-dead-worker' });
    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a crash after every device row was written: re-claimed, nothing re-sent, delivery sent', async () => {
    const s = twoDevices();
    await s.record();
    await s.db.pool.query({
      text: CLAIM_DELIVERIES_SQL,
      values: [100, SEND_LEASE_MS, MAX_SEND_ATTEMPTS],
    });
    const deliveryId = s.db.deliveries[0]?.id as string;
    await recordDeviceSends(
      s.db.pool,
      [FAKE_TOKEN_A, FAKE_TOKEN_B].map((token, i) => ({
        deliveryId,
        tokenSha256: pushTokenSha256(token),
        status: 'sent' as const,
        ticketId: `ticket-${i}`,
        error: null,
      })),
    );

    s.at(later(SEND_LEASE_MS + 1_000));
    const retry = await s.send();

    expect(retry).toMatchObject({ claimed: 1, messages: 0 });
    expect(s.expo.sent).toHaveLength(0);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent', error: null });
  });

  it('a crash on the last attempt still counts a device that got a ticket', async () => {
    const s = twoDevices();
    await s.record();
    const delivery = s.db.deliveries[0];
    if (delivery) delivery.attempts = MAX_SEND_ATTEMPTS - 1;
    await s.db.pool.query({
      text: CLAIM_DELIVERIES_SQL,
      values: [100, SEND_LEASE_MS, MAX_SEND_ATTEMPTS],
    });
    await recordDeviceSends(s.db.pool, [
      {
        deliveryId: delivery?.id as string,
        tokenSha256: pushTokenSha256(FAKE_TOKEN_A),
        status: 'sent',
        ticketId: 'ticket-0',
        error: null,
      },
    ]);

    s.at(later(SEND_LEASE_MS + 1_000));
    const run = await s.send();

    expect(run.closedInterrupted).toBe(1);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent', expo_ticket_id: 'ticket-0' });
  });

  it('one device rate-limited: only that device is retried, the other is not sent twice', async () => {
    let round = 0;
    const s = twoDevices({
      send: () => {
        round += 1;
        return {
          tickets: (m) =>
            round === 1 && m.to === FAKE_TOKEN_B ? errorTicket('MessageRateExceeded') : okTicket(),
        };
      },
    });
    await s.record();

    const first = await s.send();
    expect(first).toMatchObject({ sent: 1, retrying: 1 });
    // Retry wins while attempts remain, even though the phone got it.
    expect(s.db.deliveries[0]).toMatchObject({ status: 'pending', attempts: 1 });

    s.at(later(61_000));
    const second = await s.send();

    expect(second).toMatchObject({ messages: 1, sent: 1 });
    expect(s.expo.sent.map((batch) => batch.map((m) => m.to))).toEqual([
      [FAKE_TOKEN_B, FAKE_TOKEN_A],
      [FAKE_TOKEN_B],
    ]);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(s.db.deviceSends.map((d) => d.status)).toEqual(['sent', 'sent']);
  });

  it('a request failure retries every device of the batch; none is sent twice once recorded', async () => {
    let calls = 0;
    const s = twoDevices({
      send: () => {
        calls += 1;
        return calls === 1 ? { status: 503 } : { tickets: () => okTicket() };
      },
    });
    await s.record();

    await s.send();
    expect(s.db.deliveries[0]).toMatchObject({ status: 'pending' });
    expect(s.db.deviceSends).toHaveLength(0);

    s.at(later(61_000));
    await s.send();
    s.at(later(10 * 60_000));
    await s.send();

    expect(s.expo.messages()).toHaveLength(4);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('batching across devices: 60 people × 2 devices = 120 messages in requests of 100 and 20', async () => {
    const s = setup();
    for (let i = 0; i < 60; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      s.db.addTraveller({
        userId: id,
        flightIds: [FLIGHT],
        tokens: [`ExponentPushToken[FAKE-phone-${i}]`, `ExponentPushToken[FAKE-tablet-${i}]`],
      });
    }
    await s.record();

    const summary = await s.send();

    expect(summary).toMatchObject({ claimed: 60, messages: 120, sent: 120 });
    expect(s.expo.sent.map((batch) => batch.length)).toEqual([100, 20]);
    expect(s.db.deviceSends).toHaveLength(120);
    expect(s.db.deliveries.every((d) => d.status === 'sent')).toBe(true);
  });

  it('a 503 on the first request stops the batch: later requests are not attempted', async () => {
    const s = setup({ send: { status: 503 } });
    for (let i = 0; i < 60; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      s.db.addTraveller({
        userId: id,
        flightIds: [FLIGHT],
        tokens: [`ExponentPushToken[FAKE-phone-${i}]`, `ExponentPushToken[FAKE-tablet-${i}]`],
      });
    }
    await s.record();

    const summary = await s.send();

    expect(s.expo.sent).toHaveLength(1);
    expect(summary).toMatchObject({ messages: 100, retrying: 120 });
    expect(s.db.deliveries.every((d) => d.status === 'pending')).toBe(true);
  });

  it('the person’s device cap bounds the fan-out', async () => {
    const s = setup();
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT] });
    for (let i = 0; i < MAX_DEVICES_PER_RECIPIENT + 2; i += 1) {
      s.db.registerDevice(USER_A, `ExponentPushToken[FAKE-device-${i}]`, at(100 - i));
    }
    await s.record();

    await s.send();

    expect(s.expo.messages()).toHaveLength(MAX_DEVICES_PER_RECIPIENT);
    expect(s.expo.messages().map((m) => m.to)).not.toContain('ExponentPushToken[FAKE-device-0]');
  });

  it('logs no token of any device', async () => {
    const s = twoDevices({
      send: { tickets: (m) => errorTicket('DeviceNotRegistered', m.to) },
    });
    await s.record();

    await s.send();

    expect(s.log.text()).not.toContain('ExponentPushToken');
    expect(s.log.text()).not.toContain('FAKE-test-token');
  });
});

describe('deliveries sent by the previous, single-device build', () => {
  it('are adopted by the receipt job and confirmed per device', async () => {
    const s = setup({ receipts: { 'legacy-ticket': { status: 'ok' } } });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();
    // What the old worker wrote: ticket and token hash on the parent, no device row.
    Object.assign(s.db.deliveries[0] ?? {}, {
      status: 'sent',
      attempts: 1,
      expo_ticket_id: 'legacy-ticket',
      push_token_sha256: pushTokenSha256(FAKE_TOKEN_A),
      sent_at: NOW.toISOString(),
    });
    s.at(later(RECEIPT_DELAY_MS));

    const summary = await s.receipts();

    expect(summary).toMatchObject({ adopted: 1, delivered: 1 });
    expect(s.db.deviceSends).toEqual([
      expect.objectContaining({ status: 'delivered', expo_ticket_id: 'legacy-ticket' }),
    ]);
    expect(s.db.deliveries[0]?.status).toBe('delivered');
    expect((await s.receipts()).adopted).toBe(0);
  });

  it('a legacy DeviceNotRegistered invalidates the device, not the profile column', async () => {
    const s = setup({
      receipts: { 'legacy-ticket': errorTicket('DeviceNotRegistered', FAKE_TOKEN_A) },
    });
    s.db.addTraveller({ userId: USER_A, flightIds: [FLIGHT], token: FAKE_TOKEN_A });
    await s.record();
    Object.assign(s.db.deliveries[0] ?? {}, {
      status: 'sent',
      attempts: 1,
      expo_ticket_id: 'legacy-ticket',
      push_token_sha256: pushTokenSha256(FAKE_TOKEN_A),
      sent_at: NOW.toISOString(),
    });
    s.at(later(RECEIPT_DELAY_MS));

    await s.receipts();

    expect(s.db.device(FAKE_TOKEN_A)?.invalidated_reason).toBe('device_not_registered');
    expect(s.db.profiles.get(USER_A)?.expo_push_token).toBe(FAKE_TOKEN_A);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'failed', error: 'DeviceNotRegistered' });
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

  it('a recorded DeviceNotRegistered receipt invalidates that device', async () => {
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

    expect(summary).toMatchObject({ failed: 1, devicesInvalidated: 1, devicesKept: 0 });
    expect(s.db.deliveries[0]).toMatchObject({ status: 'failed', error: 'DeviceNotRegistered' });
    expect(s.db.deviceSends[0]).toMatchObject({ status: 'failed', error: 'DeviceNotRegistered' });
    expect(s.db.device(FAKE_TOKEN_A)?.invalidated_reason).toBe('device_not_registered');
    expect(s.db.profiles.get(USER_A)?.expo_push_token).toBe(FAKE_TOKEN_A);
  });

  it('a device that registered again after the send is NOT invalidated', async () => {
    const s = await sentDelivery(() => errorTicket('DeviceNotRegistered', FAKE_TOKEN_A));
    // The app relaunched (or was reinstalled with the same token) after the send.
    s.db.registerDevice(USER_A, FAKE_TOKEN_A, later(60_000));
    s.at(later(RECEIPT_DELAY_MS));

    const summary = await s.receipts();

    expect(summary).toMatchObject({ failed: 1, devicesInvalidated: 0, devicesKept: 1 });
    expect(s.db.device(FAKE_TOKEN_A)?.invalidated_at).toBeNull();
    expect(s.db.pushTokenEvents).toEqual([]);
  });

  it('a new token registered since the send survives; only the dead one goes', async () => {
    const s = await sentDelivery(() => errorTicket('DeviceNotRegistered', FAKE_TOKEN_A));
    // The user reinstalled and the app registered a new token meanwhile.
    s.db.registerDevice(USER_A, FAKE_TOKEN_NEW, later(60_000));
    s.at(later(RECEIPT_DELAY_MS));

    const summary = await s.receipts();

    expect(summary.devicesInvalidated).toBe(1);
    expect(s.db.device(FAKE_TOKEN_A)?.invalidated_at).not.toBeNull();
    expect(s.db.device(FAKE_TOKEN_NEW)?.invalidated_at).toBeNull();
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
      expect(s.db.device(FAKE_TOKEN_A)?.invalidated_at).toBeNull();
      expect(s.alerts).toEqual([]);
    },
  );

  it('MessageRateExceeded sends it again later', async () => {
    const s = await sentDelivery(() => errorTicket('MessageRateExceeded'));
    s.at(later(RECEIPT_DELAY_MS));

    const summary = await s.receipts();

    expect(summary.requeued).toBe(1);
    expect(s.db.deliveries[0]).toMatchObject({ status: 'pending', expo_ticket_id: null });
    expect(s.db.deviceSends[0]).toMatchObject({ status: 'pending', expo_ticket_id: null });

    // Re-sent to that device after the back-off, under a new ticket.
    s.at(later(RECEIPT_DELAY_MS + 2 * 60_000));
    await s.send();
    expect(s.expo.messages()).toHaveLength(2);
    expect(s.db.deliveries[0]?.status).toBe('sent');
    expect(s.db.deviceSends[0]?.status).toBe('sent');
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
    expect(s.db.deviceSends[0]).toMatchObject({ status: 'sent', receipt_checked_at: null });
  });
});
