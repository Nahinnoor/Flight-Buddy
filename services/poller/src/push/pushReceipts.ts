/**
 * `push-receipts`: confirm what Expo accepted, per device, and invalidate dead
 * devices (overview §8.10, PHASE2_PLAN criterion 10; ADR 0006 sub-step ii).
 *
 * A ticket only says Expo took the message; the receipt says whether Apple (or
 * Google) did. Expo recommends asking about 15 minutes after sending and keeps
 * receipts for 24 hours. So every five minutes this job asks about `sent`
 * **device** rows (`notification_device_sends`) at least `RECEIPT_DELAY_MS` old,
 * at most 1,000 tickets per request, and re-asks one whose receipt is not there
 * yet no more than once per `RECEIPT_DELAY_MS`. Then each touched delivery's
 * status is re-derived from its devices (`deliveryStatus.ts`, "Parent status").
 *
 * | Receipt | Device row | Also |
 * |---|---|---|
 * | ok | `delivered` | |
 * | `DeviceNotRegistered` | `failed` | invalidate **that device only**, and only if it has not registered again since the send |
 * | `MessageTooBig` | `failed` | `error` log: our copy is far under 4 KB, so this is a bug in this module's caller |
 * | `MessageRateExceeded` | `pending` (re-sent to this device only, with back-off) | |
 * | `MismatchSenderId` | `failed` | `error` log: an Android FCM configuration fault (iOS-only today) |
 * | `InvalidCredentials` | `failed` | **operator alert**: the APNs key on EAS is broken, every user is affected |
 * | anything else | `failed` | the sanitised code |
 * | none after 24 h | `unconfirmed` | |
 *
 * ## "Only that device, and only if it has not registered since"
 *
 * Between the send and the receipt the user may reinstall, sign in again, and
 * register a **new** token (a different `push_tokens` row), or the same device
 * may register again (a newer `last_registered_at`). Either way only the device
 * that failed, as it was when the message went out, is invalidated
 * (`INVALIDATE_DEVICE_SQL`); the person's other devices stay active. The worker
 * no longer writes `profiles.expo_push_token` (legacy, dual-written by the app's
 * functions until a later sub-step drops it).
 *
 * ## Deliveries sent by the previous build
 *
 * A delivery the single-device worker sent carries its ticket and token hash on
 * the parent and has no device row. Each run first **adopts** such rows (one
 * device row from the parent's own columns, `ADOPT_LEGACY_SENDS_SQL`), so they
 * get receipts and dead-device handling like any other. Expo forgets tickets
 * after 24 hours, so after a day there is nothing left to adopt.
 *
 * ## No loops
 *
 * Operator pushes are not delivery rows (`operatorAlerts.ts`) and their tickets
 * are not kept, so a broken key cannot make this job alert about its own alert.
 * Repeated `InvalidCredentials` alerts are throttled by the sink.
 */
import type { Pool } from '../db';
import { ENGINE_TYPES } from '../engine/types';
import type { Logger } from '../logger';
import {
  DELIVERY_ERRORS,
  MAX_DELIVERY_AGE_MS,
  MAX_SEND_ATTEMPTS,
  RECEIPT_DELAY_MS,
  RECEIPT_RETENTION_MS,
  retryDelayMs,
} from './deliveryStatus';
import { SETTLE_DELIVERIES_SQL, invalidateDeadDevice, type DeviceSendStatus } from './deviceSends';
import {
  EXPO_ERROR_CODES,
  ExpoRequestError,
  MAX_RECEIPT_IDS_PER_REQUEST,
  type ExpoPushClient,
} from './expoClient';
import type { OperatorAlertSink } from './operatorAlerts';
import { countCodes } from './pushSend';

export { SETTLE_DELIVERIES_SQL } from './deviceSends';

/** Receipt requests per run. */
export const MAX_RECEIPT_BATCHES_PER_RUN = 5;

/** Legacy deliveries adopted per run (see "Deliveries sent by the previous build"). */
export const MAX_LEGACY_ADOPTIONS_PER_RUN = 1000;

/**
 * One device row for each `sent` delivery that has none: a delivery the
 * previous, single-device build sent. Its ticket, token hash and send time come
 * from the parent. `$1` = limit. Deliveries this build sends always have a
 * device row before they can be `sent`, so only legacy rows match.
 */
export const ADOPT_LEGACY_SENDS_SQL = `insert into public.notification_device_sends
       (delivery_id, token_sha256, status, expo_ticket_id, sent_at)
select d.id, d.push_token_sha256, 'sent', d.expo_ticket_id, d.sent_at
  from public.notification_deliveries d
 where d.status = 'sent'
   and d.expo_ticket_id is not null
   and d.push_token_sha256 is not null
   and d.sent_at is not null
   and not exists (select 1
                     from public.notification_device_sends s
                    where s.delivery_id = d.id)
 order by d.sent_at, d.id
 limit $1
on conflict (delivery_id, token_sha256) do nothing`;

/**
 * `sent` device rows old enough to ask about, and not asked about recently.
 * `$1` = delay ms, `$2` = limit. The delivery's status, attempts and event time
 * decide whether a MessageRateExceeded device may be re-sent.
 */
export const SELECT_AWAITING_RECEIPTS_SQL = `select s.delivery_id,
       s.token_sha256,
       s.expo_ticket_id,
       s.sent_at,
       d.user_id,
       d.status as delivery_status,
       d.attempts,
       e.detected_at
  from public.notification_device_sends s
  join public.notification_deliveries d on d.id = s.delivery_id
  join public.flight_events e on e.id = d.flight_event_id
 where s.status = 'sent'
   and s.expo_ticket_id is not null
   and s.sent_at <= now() - ($1::double precision * interval '1 millisecond')
   and (s.receipt_checked_at is null
        or s.receipt_checked_at <= now() - ($1::double precision * interval '1 millisecond'))
 order by s.sent_at, s.delivery_id, s.token_sha256
 limit $2`;

/**
 * Record what each receipt said, per device. `status = 'sent'` rows only, so a
 * second worker reading the same receipt changes nothing. A device going back
 * to `pending` loses its ticket (its re-send gets a new one).
 */
export const FINALIZE_RECEIPTS_SQL = `update public.notification_device_sends s
   set status = u.status,
       error = u.error,
       expo_ticket_id = case when u.status = 'pending' then null else s.expo_ticket_id end,
       receipt_checked_at = now()
  from unnest($1::uuid[], $2::text[], $3::text[], $4::text[])
       as u(delivery_id, token_sha256, status, error)
 where s.delivery_id = u.delivery_id
   and s.token_sha256 = u.token_sha256
   and s.status = 'sent'`;

interface AwaitingRow {
  delivery_id: string;
  token_sha256: string;
  expo_ticket_id: string;
  sent_at: string;
  user_id: string;
  delivery_status: string;
  attempts: number;
  detected_at: string;
}

interface ReceiptOutcome {
  deliveryId: string;
  tokenSha256: string;
  status: DeviceSendStatus;
  error: string | null;
}

export interface PushReceiptsDeps {
  pool: Pool;
  expo: ExpoPushClient;
  logger: Logger;
  operatorAlerts?: OperatorAlertSink;
  now?: () => Date;
  batchSize?: number;
  maxBatches?: number;
}

/** Counts are per device, except `adopted` (legacy deliveries). */
export interface PushReceiptsSummary {
  adopted: number;
  checked: number;
  delivered: number;
  failed: number;
  requeued: number;
  waiting: number;
  unconfirmed: number;
  devicesInvalidated: number;
  /** Dead devices NOT invalidated: registered again since the send, or already gone. */
  devicesKept: number;
}

/**
 * Device rows, then their deliveries, in **one transaction**: a crash between
 * the two cannot leave a delivery `sent` whose device was set back to `pending`
 * (the receipt job only re-reads `sent` device rows, so nothing would requeue it).
 */
async function finalize(
  pool: Pool,
  outcomes: readonly ReceiptOutcome[],
  requeue: ReadonlyMap<string, Date>,
): Promise<void> {
  if (outcomes.length === 0) return;
  // Not `withClient` (db.ts): a connection whose rollback failed must be
  // released with the error, so pg discards it instead of reusing it.
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    await writeReceipts(client, outcomes, requeue);
    await client.query('commit');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

async function writeReceipts(
  client: Pick<Pool, 'query'>,
  outcomes: readonly ReceiptOutcome[],
  requeue: ReadonlyMap<string, Date>,
): Promise<void> {
  await client.query({
    text: FINALIZE_RECEIPTS_SQL,
    values: [
      outcomes.map((o) => o.deliveryId),
      outcomes.map((o) => o.tokenSha256),
      outcomes.map((o) => o.status),
      outcomes.map((o) => o.error),
    ],
    types: ENGINE_TYPES,
  });
  const deliveryIds = [...new Set(outcomes.map((o) => o.deliveryId))];
  await client.query({
    text: SETTLE_DELIVERIES_SQL,
    values: [deliveryIds, deliveryIds.map((id) => requeue.get(id) ?? null)],
    types: ENGINE_TYPES,
  });
}

/**
 * One run. A receipts request that fails leaves its rows untouched for the next
 * run (five minutes) and ends this one.
 *
 * @throws on a database failure only.
 */
export async function runPushReceipts(deps: PushReceiptsDeps): Promise<PushReceiptsSummary> {
  const { logger } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const batchSize = Math.min(
    deps.batchSize ?? MAX_RECEIPT_IDS_PER_REQUEST,
    MAX_RECEIPT_IDS_PER_REQUEST,
  );
  const maxBatches = deps.maxBatches ?? MAX_RECEIPT_BATCHES_PER_RUN;
  const summary: PushReceiptsSummary = {
    adopted: 0,
    checked: 0,
    delivered: 0,
    failed: 0,
    requeued: 0,
    waiting: 0,
    unconfirmed: 0,
    devicesInvalidated: 0,
    devicesKept: 0,
  };
  const codes: string[] = [];
  let invalidCredentials = 0;

  const adopted = await deps.pool.query({
    text: ADOPT_LEGACY_SENDS_SQL,
    values: [MAX_LEGACY_ADOPTIONS_PER_RUN],
    types: ENGINE_TYPES,
  });
  summary.adopted = adopted.rowCount ?? 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const selected = await deps.pool.query<AwaitingRow>({
      text: SELECT_AWAITING_RECEIPTS_SQL,
      values: [RECEIPT_DELAY_MS, batchSize],
      types: ENGINE_TYPES,
    });
    const rows = selected.rows;
    if (rows.length === 0) break;

    const outcomes: ReceiptOutcome[] = [];
    const requeue = new Map<string, Date>();
    const ask: AwaitingRow[] = [];
    for (const row of rows) {
      // Past Expo's retention there is nothing to ask for.
      if (now.getTime() - Date.parse(row.sent_at) > RECEIPT_RETENTION_MS) {
        outcomes.push({
          deliveryId: row.delivery_id,
          tokenSha256: row.token_sha256,
          status: 'unconfirmed',
          error: DELIVERY_ERRORS.RECEIPT_UNAVAILABLE,
        });
        summary.unconfirmed += 1;
      } else {
        ask.push(row);
      }
    }

    let receipts;
    try {
      receipts = await deps.expo.getReceipts(ask.map((row) => row.expo_ticket_id));
    } catch (error) {
      if (!(error instanceof ExpoRequestError)) throw error;
      await finalize(deps.pool, outcomes, requeue);
      logger.warn(
        { kind: error.kind, status: error.status, code: error.code, ids: ask.length },
        'Expo receipts request failed; rows will be asked about again',
      );
      if (error.kind === 'unauthorized')
        await deps.operatorAlerts?.raise({ kind: 'push_unauthorized' });
      break;
    }

    for (const row of ask) {
      summary.checked += 1;
      const receipt = receipts.get(row.expo_ticket_id);
      const base = { deliveryId: row.delivery_id, tokenSha256: row.token_sha256 };

      if (receipt === undefined) {
        // Not ready yet. Stays `sent`; `receipt_checked_at` spaces the next ask.
        outcomes.push({ ...base, status: 'sent', error: null });
        summary.waiting += 1;
        continue;
      }
      if (receipt.status === 'ok') {
        outcomes.push({ ...base, status: 'delivered', error: null });
        summary.delivered += 1;
        continue;
      }

      const code = receipt.errorCode;
      codes.push(code);

      if (code === EXPO_ERROR_CODES.MESSAGE_RATE_EXCEEDED) {
        const age = now.getTime() - Date.parse(row.detected_at);
        // A `sent` delivery goes back to `pending`; one already being retried
        // (`pending`/`sending`) picks this device up on its own. A `delivered`
        // one has reached the person already.
        const retryable =
          ['sent', 'pending', 'sending'].includes(row.delivery_status) &&
          row.attempts < MAX_SEND_ATTEMPTS &&
          age < MAX_DELIVERY_AGE_MS;
        if (retryable) {
          // The code stays on the row: if the device is gone before its re-send,
          // the row is closed `failed` with it (CLOSE_STALE_PENDING_SENDS_SQL).
          outcomes.push({ ...base, status: 'pending', error: code });
          if (row.delivery_status === 'sent') {
            requeue.set(row.delivery_id, new Date(now.getTime() + retryDelayMs(row.attempts)));
          }
          summary.requeued += 1;
          continue;
        }
      }

      outcomes.push({ ...base, status: 'failed', error: code });
      summary.failed += 1;

      if (code === EXPO_ERROR_CODES.DEVICE_NOT_REGISTERED) {
        if (await invalidateDeadDevice(deps.pool, row.user_id, row.token_sha256, row.sent_at)) {
          summary.devicesInvalidated += 1;
        } else {
          summary.devicesKept += 1;
        }
      } else if (code === EXPO_ERROR_CODES.INVALID_CREDENTIALS) {
        invalidCredentials += 1;
      } else if (
        code === EXPO_ERROR_CODES.MESSAGE_TOO_BIG ||
        code === EXPO_ERROR_CODES.MISMATCH_SENDER_ID
      ) {
        logger.error(
          { deliveryId: row.delivery_id, code },
          'Expo receipt reports a configuration or payload fault',
        );
      }
    }

    await finalize(deps.pool, outcomes, requeue);
    if (rows.length < batchSize) break;
  }

  if (codes.length > 0) logger.warn({ codes: countCodes(codes) }, 'Expo receipts reported errors');
  if (invalidCredentials > 0) {
    logger.error(
      { count: invalidCredentials },
      'Expo receipts report InvalidCredentials: the push key on EAS is broken; every user is affected',
    );
    await deps.operatorAlerts?.raise({
      kind: 'push_credentials_invalid',
      count: invalidCredentials,
    });
  }
  if (summary.checked > 0 || summary.unconfirmed > 0 || summary.adopted > 0) {
    logger.info({ ...summary }, 'push receipts checked');
  }
  return summary;
}

/** The pg-boss handler for the scheduled `push-receipts` job. */
export function createPushReceiptsHandler(deps: PushReceiptsDeps) {
  return async function handlePushReceipts(): Promise<void> {
    await runPushReceipts(deps);
  };
}
