/**
 * `push-receipts`: confirm what Expo accepted, and clear dead tokens
 * (overview §8.10, PHASE2_PLAN criterion 10).
 *
 * A ticket only says Expo took the message; the receipt says whether Apple (or
 * Google) did. Expo recommends asking about 15 minutes after sending and keeps
 * receipts for 24 hours. So every five minutes this job asks about `sent` rows at
 * least `RECEIPT_DELAY_MS` old, at most 1,000 ids per request, and re-asks a row
 * whose receipt is not there yet no more than once per `RECEIPT_DELAY_MS`.
 *
 * | Receipt | Row | Also |
 * |---|---|---|
 * | ok | `delivered` | |
 * | `DeviceNotRegistered` | `failed` | clear the profile's token **only if it is still the one that failed** |
 * | `MessageTooBig` | `failed` | `error` log: our copy is far under 4 KB, so this is a bug in this module's caller |
 * | `MessageRateExceeded` | `pending` with back-off | re-sent by `push-send` (APNs said "slow down", not "no") |
 * | `MismatchSenderId` | `failed` | `error` log: an Android FCM configuration fault (iOS-only today) |
 * | `InvalidCredentials` | `failed` | **operator alert**: the APNs key on EAS is broken, every user is affected |
 * | anything else | `failed` | the sanitised code |
 * | none after 24 h | `unconfirmed` | |
 *
 * ## "Only if it is still the one that failed"
 *
 * Between the send and the receipt the user may reinstall, sign in again, and
 * register a **new** token. Clearing by user id alone would delete that new,
 * working token and silence them. So the row carries the SHA-256 of the token it
 * was sent to, and the clear is conditional on the profile's current token having
 * the same hash (`CLEAR_DEAD_TOKEN_SQL`). The token itself is never stored on the
 * delivery, never logged.
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
  type DeliveryStatus,
} from './deliveryStatus';
import {
  EXPO_ERROR_CODES,
  ExpoRequestError,
  MAX_RECEIPT_IDS_PER_REQUEST,
  type ExpoPushClient,
} from './expoClient';
import type { OperatorAlertSink } from './operatorAlerts';
import { clearDeadToken, countCodes } from './pushSend';

/** Receipt requests per run. */
export const MAX_RECEIPT_BATCHES_PER_RUN = 5;

/** `sent` rows old enough to ask about, and not asked about recently. `$1` = delay ms, `$2` = limit. */
export const SELECT_AWAITING_RECEIPTS_SQL = `select d.id,
       d.user_id,
       d.expo_ticket_id,
       d.push_token_sha256,
       d.sent_at,
       d.attempts,
       e.detected_at
  from public.notification_deliveries d
  join public.flight_events e on e.id = d.flight_event_id
 where d.status = 'sent'
   and d.expo_ticket_id is not null
   and d.sent_at <= now() - ($1::double precision * interval '1 millisecond')
   and (d.receipt_checked_at is null
        or d.receipt_checked_at <= now() - ($1::double precision * interval '1 millisecond'))
 order by d.sent_at, d.id
 limit $2`;

/**
 * Record what each receipt said. `status = 'sent'` rows only, so a second worker
 * reading the same receipt changes nothing. A row going back to `pending` loses
 * its ticket (a new send gets a new one).
 */
export const FINALIZE_RECEIPTS_SQL = `update public.notification_deliveries d
   set status = u.status,
       error = u.error,
       not_before = u.not_before,
       expo_ticket_id = case when u.status = 'pending' then null else d.expo_ticket_id end,
       receipt_checked_at = now()
  from unnest($1::uuid[], $2::text[], $3::text[], $4::timestamptz[])
       as u(id, status, error, not_before)
 where d.id = u.id
   and d.status = 'sent'`;

interface AwaitingRow {
  id: string;
  user_id: string;
  expo_ticket_id: string;
  push_token_sha256: string | null;
  sent_at: string;
  attempts: number;
  detected_at: string;
}

interface ReceiptOutcome {
  id: string;
  status: DeliveryStatus;
  error: string | null;
  notBefore: Date | null;
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

export interface PushReceiptsSummary {
  checked: number;
  delivered: number;
  failed: number;
  requeued: number;
  waiting: number;
  unconfirmed: number;
  tokensCleared: number;
  /** Tokens NOT cleared because the profile holds a newer one (criterion 10). */
  tokensKept: number;
}

async function finalize(pool: Pool, outcomes: readonly ReceiptOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;
  await pool.query({
    text: FINALIZE_RECEIPTS_SQL,
    values: [
      outcomes.map((o) => o.id),
      outcomes.map((o) => o.status),
      outcomes.map((o) => o.error),
      outcomes.map((o) => o.notBefore),
    ],
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
    checked: 0,
    delivered: 0,
    failed: 0,
    requeued: 0,
    waiting: 0,
    unconfirmed: 0,
    tokensCleared: 0,
    tokensKept: 0,
  };
  const codes: string[] = [];
  let invalidCredentials = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const selected = await deps.pool.query<AwaitingRow>({
      text: SELECT_AWAITING_RECEIPTS_SQL,
      values: [RECEIPT_DELAY_MS, batchSize],
      types: ENGINE_TYPES,
    });
    const rows = selected.rows;
    if (rows.length === 0) break;

    const outcomes: ReceiptOutcome[] = [];
    const ask: AwaitingRow[] = [];
    for (const row of rows) {
      // Past Expo's retention there is nothing to ask for.
      if (now.getTime() - Date.parse(row.sent_at) > RECEIPT_RETENTION_MS) {
        outcomes.push({
          id: row.id,
          status: 'unconfirmed',
          error: DELIVERY_ERRORS.RECEIPT_UNAVAILABLE,
          notBefore: null,
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
      await finalize(deps.pool, outcomes);
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

      if (receipt === undefined) {
        // Not ready yet. Stays `sent`; `receipt_checked_at` spaces the next ask.
        outcomes.push({ id: row.id, status: 'sent', error: null, notBefore: null });
        summary.waiting += 1;
        continue;
      }
      if (receipt.status === 'ok') {
        outcomes.push({ id: row.id, status: 'delivered', error: null, notBefore: null });
        summary.delivered += 1;
        continue;
      }

      const code = receipt.errorCode;
      codes.push(code);

      if (code === EXPO_ERROR_CODES.MESSAGE_RATE_EXCEEDED) {
        const age = now.getTime() - Date.parse(row.detected_at);
        if (row.attempts < MAX_SEND_ATTEMPTS && age < MAX_DELIVERY_AGE_MS) {
          outcomes.push({
            id: row.id,
            status: 'pending',
            error: null,
            notBefore: new Date(now.getTime() + retryDelayMs(row.attempts)),
          });
          summary.requeued += 1;
          continue;
        }
      }

      outcomes.push({ id: row.id, status: 'failed', error: code, notBefore: null });
      summary.failed += 1;

      if (code === EXPO_ERROR_CODES.DEVICE_NOT_REGISTERED && row.push_token_sha256 !== null) {
        if (await clearDeadToken(deps.pool, row.user_id, row.push_token_sha256)) {
          summary.tokensCleared += 1;
        } else {
          summary.tokensKept += 1;
        }
      } else if (code === EXPO_ERROR_CODES.INVALID_CREDENTIALS) {
        invalidCredentials += 1;
      } else if (
        code === EXPO_ERROR_CODES.MESSAGE_TOO_BIG ||
        code === EXPO_ERROR_CODES.MISMATCH_SENDER_ID
      ) {
        logger.error(
          { deliveryId: row.id, code },
          'Expo receipt reports a configuration or payload fault',
        );
      }
    }

    await finalize(deps.pool, outcomes);
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
  if (summary.checked > 0 || summary.unconfirmed > 0) {
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
