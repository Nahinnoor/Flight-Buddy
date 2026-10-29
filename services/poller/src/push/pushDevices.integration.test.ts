/**
 * Per-device push SQL (ADR 0006 sub-step ii) against a real Postgres, as
 * `flightbuddy_worker`: `deviceSends.ts`, `pushSend.ts` and `pushReceipts.ts`
 * exactly as the worker runs them, so grants, the `on conflict` upsert, the
 * aggregate CTEs and the guards are proven by Postgres, not by `memoryDb`.
 *
 * **Only against a throwaway cluster.** It seeds users, devices and pending
 * deliveries, and the worker functions it calls claim *every* due delivery; on a
 * shared database the deployed worker would also claim and send what it seeds.
 * So it is skipped unless `INTEGRATION=1`, and `connectThrowawayDb`
 * (`../throwawayDb.ts`) refuses to start without `INTEGRATION_THROWAWAY=1`, on a
 * host that is not a local socket or loopback, or when `auth.users` is not empty
 * before it seeds.
 *
 * Its own cleanup touches only the users and deliveries it seeded, and deletes
 * those users at the end, so the next integration file finds `auth.users` empty.
 * Run it with:
 *
 * ```sh
 * supabase/tests/run-local.sh --exec env INTEGRATION=1 npx vitest run \
 *   --root services/poller src/push/pushDevices.integration.test.ts
 * ```
 *
 * which replays every migration into a temporary cluster and deletes it after.
 * Tokens are synthetic. Expo is the documented-shape fake (`fakeExpo.ts`).
 */
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Pool } from '../db';
import { captureLogger } from '../engine/testFixtures';
import { ENGINE_TYPES } from '../engine/types';
import {
  connectThrowawayDb,
  integrationRequested as enabled,
  type ThrowawayDb,
} from '../throwawayDb';
import { DELIVERY_ERRORS, MAX_SEND_ATTEMPTS } from './deliveryStatus';
import {
  CLOSE_EXHAUSTED_SENDS_SQL,
  FINALIZE_SENDS_SQL,
  invalidateDeadDevice,
  recordDeviceSends,
} from './deviceSends';
import { errorTicket, fakeExpo, okTicket, type FakeExpoOptions } from './fakeExpo';
import { ADOPT_LEGACY_SENDS_SQL, runPushReceipts } from './pushReceipts';
import { CLAIM_DELIVERIES_SQL, runPushSend } from './pushSend';
import { pushTokenSha256 } from './tokens';

describe.skipIf(!enabled)('per-device push SQL on a real Postgres, as flightbuddy_worker', () => {
  let db: ThrowawayDb | undefined;
  let admin: pg.Pool;
  let worker: Pool;
  let flightId: string;
  /** Every user this file seeded; cleanup is scoped to them. */
  const seeded: string[] = [];

  const q = async <R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<R[]> => (await admin.query<R>({ text, values, types: ENGINE_TYPES })).rows;
  const log = captureLogger();
  const send = (options: FakeExpoOptions = {}) => {
    const expo = fakeExpo(options);
    return {
      expo,
      run: () => runPushSend({ pool: worker, expo: expo.client, logger: log.logger }),
    };
  };
  const receipts = (options: FakeExpoOptions) =>
    runPushReceipts({ pool: worker, expo: fakeExpo(options).client, logger: log.logger });
  const token = (name: string) => `ExponentPushToken[FAKE-it-${name}-${randomUUID().slice(0, 8)}]`;

  async function user(): Promise<string> {
    const id = randomUUID();
    await q(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@example.test`]);
    seeded.push(id);
    return id;
  }
  async function device(userId: string, value: string, registeredMinutesAgo = 60) {
    await q(
      `insert into public.push_tokens (user_id, token, last_registered_at)
       values ($1, $2, now() - ($3::int * interval '1 minute'))`,
      [userId, value, registeredMinutesAgo],
    );
  }
  async function delivery(userId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const [event] = await q<{ id: string }>(
      `insert into public.flight_events (flight_id, event_type, previous_value, new_value, source)
       values ($1, 'gate_change', '{"gate":"B1","terminal":"4"}', '{"gate":"B2","terminal":"4"}', 'poll')
       returning id`,
      [flightId],
    );
    const columns = ['flight_event_id', 'user_id', ...Object.keys(extra)];
    const values = [event?.id, userId, ...Object.values(extra)];
    const [row] = await q<{ id: string }>(
      `insert into public.notification_deliveries (${columns.join(', ')})
       values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      values,
    );
    return row?.id as string;
  }
  const parent = async (id: string) =>
    (
      await q<{
        status: string;
        error: string | null;
        attempts: number;
        expo_ticket_id: string | null;
      }>(
        `select status, error, attempts, expo_ticket_id from public.notification_deliveries where id = $1`,
        [id],
      )
    )[0];
  const children = (id: string) =>
    q<{
      token_sha256: string;
      status: string;
      error: string | null;
      expo_ticket_id: string | null;
    }>(
      `select token_sha256, status, error, expo_ticket_id
         from public.notification_device_sends where delivery_id = $1 order by token_sha256`,
      [id],
    );
  const child = async (id: string, value: string) =>
    (await children(id)).find((c) => c.token_sha256 === pushTokenSha256(value));
  /** Make device rows old enough for the receipt job, and a retried delivery due. */
  const age = (id: string) =>
    q(
      `update public.notification_device_sends set sent_at = now() - interval '20 minutes'
        where delivery_id = $1`,
      [id],
    );
  const due = (id: string) =>
    q(
      `update public.notification_deliveries set not_before = now() - interval '1 second' where id = $1`,
      [id],
    );
  /** Claim exactly as the worker does, with a lease that passes at once. */
  const claimAndDie = () =>
    worker.query({ text: CLAIM_DELIVERIES_SQL, values: [100, 1, MAX_SEND_ATTEMPTS] });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeAll(async () => {
    db = await connectThrowawayDb();
    ({ admin, worker } = db);
    const [flight] = await q<{ id: string }>(
      `insert into public.flights (operating_carrier_iata, operating_flight_number, departure_date_local,
                                   origin_iata, destination_iata, origin_tz, destination_tz, gate)
       values ('ZZ', '9999', '2099-01-01', 'JFK', 'LAX', 'America/New_York', 'America/Los_Angeles', 'B2')
       returning id`,
    );
    flightId = flight?.id as string;
  });

  beforeEach(async () => {
    // Each test starts with nothing of this file's earlier tests left to send or
    // confirm. Scoped to the users this file seeded.
    if (seeded.length === 0) return;
    await q(
      `update public.notification_deliveries set status = 'expired', claimed_until = null
        where user_id = any($1::uuid[]) and status in ('pending', 'sending')`,
      [seeded],
    );
    await q(
      `update public.notification_device_sends s set status = 'unconfirmed', expo_ticket_id = null
         from public.notification_deliveries d
        where d.id = s.delivery_id
          and d.user_id = any($1::uuid[])
          and s.status in ('sent', 'pending')`,
      [seeded],
    );
  });

  afterAll(async () => {
    // Cascades to their profiles, devices, deliveries and device rows, leaving
    // `auth.users` empty for the next integration file's guard.
    try {
      if (db !== undefined && seeded.length > 0) {
        await q(`delete from auth.users where id = any($1::uuid[])`, [seeded]);
      }
    } finally {
      await db?.end();
    }
  });

  it('a crash re-sends only the device without a ticket', async () => {
    const u = await user();
    const [phone, tablet] = [token('phone'), token('tablet')];
    await device(u, phone, 90);
    await device(u, tablet, 30);
    const d = await delivery(u);
    await claimAndDie();
    await recordDeviceSends(
      worker,
      [
        {
          deliveryId: d,
          tokenSha256: pushTokenSha256(phone),
          status: 'sent',
          ticketId: 'dead-worker',
          error: null,
        },
      ],
      new Date().toISOString(),
    );
    await pause();

    const { expo, run } = send();
    const summary = await run();

    expect(summary.closedInterrupted).toBe(0);
    expect(expo.messages().map((m) => m.to)).toEqual([tablet]);
    expect(await child(d, phone)).toMatchObject({ status: 'sent', expo_ticket_id: 'dead-worker' });
    expect(await parent(d)).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('a settled device row is never overwritten; a pending one is', async () => {
    const u = await user();
    const phone = token('phone');
    await device(u, phone);
    const d = await delivery(u);
    const sha = pushTokenSha256(phone);
    const at = new Date().toISOString();
    const record = (status: 'sent' | 'failed', ticketId: string | null) =>
      recordDeviceSends(
        worker,
        [{ deliveryId: d, tokenSha256: sha, status, ticketId, error: null }],
        at,
      );

    expect(await record('sent', 'first')).toHaveLength(1);
    expect(await record('sent', 'second')).toHaveLength(0);
    expect(await child(d, phone)).toMatchObject({ expo_ticket_id: 'first' });

    await q(
      `update public.notification_device_sends set status = 'pending', expo_ticket_id = null
        where delivery_id = $1`,
      [d],
    );
    expect(await record('sent', 'third')).toHaveLength(1);
    expect(await child(d, phone)).toMatchObject({ status: 'sent', expo_ticket_id: 'third' });
  });

  it('a retryable failure holds the delivery pending, then it is sent', async () => {
    const u = await user();
    await device(u, token('phone'));
    const d = await delivery(u);
    let calls = 0;
    const { run } = send({
      send: () => {
        calls += 1;
        return calls === 1 ? { status: 503 } : { tickets: () => okTicket() };
      },
    });

    await run();
    expect(await parent(d)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await children(d)).toHaveLength(0);

    await due(d);
    await run();
    expect(await parent(d)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a stale finalize (attempts changed by a re-claim) changes nothing', async () => {
    const u = await user();
    await device(u, token('phone'));
    const d = await delivery(u);
    await worker.query({ text: CLAIM_DELIVERIES_SQL, values: [100, 120_000, MAX_SEND_ATTEMPTS] });
    // Another worker re-claimed it.
    await q(`update public.notification_deliveries set attempts = 2 where id = $1`, [d]);

    const result = await worker.query({
      text: FINALIZE_SENDS_SQL,
      values: [[d], [1], [false], ['failed'], ['ExpoUnavailable'], [new Date()], MAX_SEND_ATTEMPTS],
    });

    expect(result.rowCount).toBe(0);
    expect(await parent(d)).toMatchObject({ status: 'sending', attempts: 2 });
  });

  it('the invalidate guard keeps a device that registered again after the send', async () => {
    const u = await user();
    const phone = token('phone');
    await device(u, phone, 0);
    const sha = pushTokenSha256(phone);
    const before = new Date(Date.now() - 60_000).toISOString();

    expect(await invalidateDeadDevice(worker, u, sha, before)).toBe(false);
    expect(await q(`select 1 from public.push_token_events where user_id = $1`, [u])).toHaveLength(
      0,
    );

    expect(
      await invalidateDeadDevice(worker, u, sha, new Date(Date.now() + 60_000).toISOString()),
    ).toBe(true);
    const [row] = await q<{ invalidated_reason: string }>(
      `select invalidated_reason from public.push_tokens where token = $1`,
      [phone],
    );
    expect(row?.invalidated_reason).toBe('device_not_registered');
    expect(
      await q(
        `select 1 from public.push_token_events where user_id = $1 and event = 'device_not_registered'`,
        [u],
      ),
    ).toHaveLength(1);
  });

  it('a receipt moves the device and its delivery to delivered', async () => {
    const u = await user();
    await device(u, token('phone'));
    const d = await delivery(u);
    await send().run();
    await age(d);
    const [{ expo_ticket_id: ticket } = { expo_ticket_id: null }] = await children(d);

    await receipts({ receipts: { [ticket as string]: { status: 'ok' } } });

    expect((await children(d))[0]).toMatchObject({ status: 'delivered' });
    expect(await parent(d)).toMatchObject({ status: 'delivered', error: null });
  });

  it('MessageRateExceeded re-sends only that device', async () => {
    const u = await user();
    const [phone, tablet] = [token('phone'), token('tablet')];
    await device(u, phone, 90);
    await device(u, tablet, 30);
    const d = await delivery(u);
    const tickets = new Map<string, string>();
    await send({
      send: {
        tickets: (m) => {
          const t = okTicket();
          tickets.set(m.to, String(t.id));
          return t;
        },
      },
    }).run();
    await age(d);

    await receipts({
      receipts: {
        [tickets.get(phone) as string]: { status: 'ok' },
        [tickets.get(tablet) as string]: errorTicket('MessageRateExceeded'),
      },
    });
    expect(await parent(d)).toMatchObject({ status: 'pending' });
    expect(await child(d, tablet)).toMatchObject({
      status: 'pending',
      error: 'MessageRateExceeded',
    });

    await due(d);
    const { expo, run } = send();
    await run();

    expect(expo.messages().map((m) => m.to)).toEqual([tablet]);
    expect(await child(d, tablet)).toMatchObject({ status: 'sent', error: null });
    expect(await parent(d)).toMatchObject({ status: 'delivered' });
  });

  it('a pending device that is gone does not hold its delivery; an expired one is closed', async () => {
    // `gone`: the tablet signs out before its re-send. `old`: the tablet is still
    // active, but the delivery is past its send window.
    const cases: { d: string; phone: string; tablet: string }[] = [];
    for (const name of ['gone', 'old']) {
      const u = await user();
      const [phone, tablet] = [token(`${name}-phone`), token(`${name}-tablet`)];
      await device(u, phone, 90);
      await device(u, tablet, 30);
      const d = await delivery(u);
      await q(
        `insert into public.notification_device_sends (delivery_id, token_sha256, status, expo_ticket_id, error)
         values ($1, $2, 'sent', $3, null), ($1, $4, 'pending', null, 'MessageRateExceeded')`,
        [d, pushTokenSha256(phone), `t-${name}`, pushTokenSha256(tablet)],
      );
      cases.push({ d, phone, tablet });
    }
    const [gone, old] = cases as [(typeof cases)[0], (typeof cases)[0]];
    await q(`delete from public.push_tokens where token = $1`, [gone.tablet]);
    await q(
      `update public.flight_events e set detected_at = now() - interval '4 hours'
         from public.notification_deliveries d where d.flight_event_id = e.id and d.id = $1`,
      [old.d],
    );

    const { expo, run } = send();
    const summary = await run();

    expect(summary.expired).toBe(1);
    expect(expo.sent).toHaveLength(0);
    for (const [name, c] of [
      ['gone', gone],
      ['old', old],
    ] as const) {
      expect(await child(c.d, c.tablet)).toMatchObject({
        status: 'failed',
        error: 'MessageRateExceeded',
      });
      // The phone's earlier ticket decides: sent, never pending or NoPushToken.
      expect(await parent(c.d)).toMatchObject({ status: 'sent', expo_ticket_id: `t-${name}` });
    }
    expect((await run()).claimed).toBe(0);
  });

  it('legacy adoption is idempotent', async () => {
    const u = await user();
    const phone = token('phone');
    await device(u, phone);
    const d = await delivery(u, {
      status: 'sent',
      attempts: 1,
      expo_ticket_id: 'legacy',
      push_token_sha256: pushTokenSha256(phone),
      sent_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    });

    const first = await worker.query({ text: ADOPT_LEGACY_SENDS_SQL, values: [1000] });
    const second = await worker.query({ text: ADOPT_LEGACY_SENDS_SQL, values: [1000] });

    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);
    expect(await children(d)).toEqual([
      expect.objectContaining({ status: 'sent', expo_ticket_id: 'legacy' }),
    ]);
  });

  it('CLOSE_EXHAUSTED keeps a device ticket, and is SendOutcomeUnknown without one', async () => {
    const u = await user();
    const phone = token('phone');
    await device(u, phone);
    const withTicket = await delivery(u, { attempts: MAX_SEND_ATTEMPTS - 1 });
    const without = await delivery(u, { attempts: MAX_SEND_ATTEMPTS - 1 });
    await claimAndDie();
    await recordDeviceSends(
      worker,
      [
        {
          deliveryId: withTicket,
          tokenSha256: pushTokenSha256(phone),
          status: 'sent',
          ticketId: 'kept',
          error: null,
        },
      ],
      new Date().toISOString(),
    );
    await pause();

    const result = await worker.query({
      text: CLOSE_EXHAUSTED_SENDS_SQL,
      values: [MAX_SEND_ATTEMPTS, DELIVERY_ERRORS.SEND_OUTCOME_UNKNOWN],
    });

    expect(result.rowCount).toBe(2);
    expect(await parent(withTicket)).toMatchObject({
      status: 'sent',
      error: null,
      expo_ticket_id: 'kept',
    });
    expect(await parent(without)).toMatchObject({
      status: 'failed',
      error: DELIVERY_ERRORS.SEND_OUTCOME_UNKNOWN,
    });
  });

  it('no active device → skipped / NoPushToken', async () => {
    const u = await user();
    const phone = token('phone');
    await device(u, phone);
    await q(
      `update public.push_tokens set invalidated_at = now(), invalidated_reason = 'device_not_registered'
        where token = $1`,
      [phone],
    );
    const d = await delivery(u);

    const { expo, run } = send();
    await run();

    expect(expo.sent).toHaveLength(0);
    expect(await parent(d)).toMatchObject({
      status: 'skipped',
      error: DELIVERY_ERRORS.NO_PUSH_TOKEN,
    });
  });
});
