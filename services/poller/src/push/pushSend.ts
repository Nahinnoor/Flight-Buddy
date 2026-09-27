/**
 * `push-send`: pending `notification_deliveries` → Expo Push (§9, wave 5).
 *
 * ```
 * close rows whose interrupted sends ran out of attempts
 * loop (≤ MAX_BATCHES):
 *   claim ≤ 100 rows          pending (not_before passed) or sending (lease passed)
 *                             → sending, attempts + 1, lease   [commit]
 *   read the message facts    event, flight, recipient token, the user's own segment
 *   per row: expired? no token? malformed token? → closed without sending
 *   one Expo request          one message per row, ticket i = row i
 *   per ticket: ok → sent (ticket id, token fingerprint)
 *               DeviceNotRegistered → failed, token cleared if still the same
 *               MessageRateExceeded → pending with back-off
 *               InvalidCredentials → failed, operator alert
 *               other error → failed (code only)
 *   request failed: 429/5xx/401 → pending with back-off; network/timeout →
 *               pending (at-least-once, see deliveryStatus.ts); other 4xx → failed
 * ```
 *
 * The status lifecycle and the crash window are in `deliveryStatus.ts`; the one
 * line version is: we prefer a rare duplicate (coalesced by iOS through
 * `collapseId`) to a dropped gate change.
 *
 * ## How it is triggered
 *
 * A pg-boss job on the `push-send` queue, scheduled every minute as a sweep, and
 * also sent by the poll and webhook paths the moment they create deliveries
 * (`onDeliveriesCreated` in `main.ts`), so a gate change reaches the phone in
 * seconds. pg-boss runs one handler at a time per process; across two processes
 * (a deploy overlap) the claim's `for update skip locked` and lease keep each row
 * with one sender.
 *
 * ## What reaches a log
 *
 * Delivery and event ids, counts, and Expo error **codes**. Never a push token,
 * never a title or body, never an Expo error message (it quotes the token).
 */
import { z } from 'zod';

import type { Pool } from '../db';
import { FLIGHT_EVENT_TYPES } from '../engine/changeDetector';
import { ENGINE_TYPES } from '../engine/types';
import type { Logger } from '../logger';
import {
  DELIVERY_ERRORS,
  maxDeliveryAgeMs,
  MAX_SEND_ATTEMPTS,
  SEND_LEASE_MS,
  retryDelayMs,
  type DeliveryStatus,
} from './deliveryStatus';
import {
  EXPO_ERROR_CODES,
  ExpoRequestError,
  MAX_MESSAGES_PER_REQUEST,
  type ExpoPushClient,
  type ExpoPushMessage,
  type ExpoTicket,
} from './expoClient';
import { buildPushCopy, type MessageFacts } from './messages';
import type { OperatorAlertSink } from './operatorAlerts';
import { isExpoPushToken, pushTokenSha256 } from './tokens';

/** Android channel the app registers (`apps/mobile/src/lib/push.ts`). */
export const ANDROID_CHANNEL_ID = 'flight-updates';

/** Batches per run: 1,000 messages, well inside Expo's 600/s per project. */
export const MAX_BATCHES_PER_RUN = 10;

// --- SQL --------------------------------------------------------------------

/**
 * Close `sending` rows whose sender died (lease passed) and that have no attempts
 * left. Their outcome is unknown: Expo may have taken the last one.
 */
export const CLOSE_EXHAUSTED_SENDS_SQL = `update public.notification_deliveries
   set status = 'failed',
       error = $2,
       claimed_until = null
 where status = 'sending'
   and claimed_until < now()
   and attempts >= $1
returning id`;

/**
 * Claim up to `$1` rows for `$2` ms. `$3` = `MAX_SEND_ATTEMPTS`. A `sending` row
 * whose lease has passed is an interrupted send, and is claimed again.
 */
export const CLAIM_DELIVERIES_SQL = `update public.notification_deliveries d
   set status = 'sending',
       attempts = d.attempts + 1,
       claimed_until = now() + ($2::double precision * interval '1 millisecond')
 where d.id in (
         select id
           from public.notification_deliveries
          where attempts < $3
            and ((status = 'pending' and (not_before is null or not_before <= now()))
                 or (status = 'sending' and claimed_until < now()))
          order by created_at, id
          limit $1
          for update skip locked)
returning d.id`;

/**
 * Everything one message is built from, for the claimed ids.
 *
 * The token is read here, at send time, so a token registered after the event
 * is the one used. The flight number is the one on the recipient's **own**
 * segment for this flight (what they typed, §7.2). Only columns the worker role
 * holds a grant on: `profiles(id, expo_push_token)`, `trip_segments(id, trip_id,
 * flight_id, marketing_*)`, `trips(id, traveler_id)`, `travelers(id, user_id)`.
 */
export const LOAD_DELIVERY_FACTS_SQL = `select d.id as delivery_id,
       d.user_id,
       d.attempts,
       e.id as event_id,
       e.event_type,
       e.previous_value,
       e.new_value,
       e.detected_at,
       f.id as flight_id,
       f.operating_carrier_iata,
       f.operating_flight_number,
       f.origin_iata,
       f.destination_iata,
       f.origin_tz,
       f.destination_tz,
       f.departure_date_local,
       f.status,
       f.scheduled_departure_utc,
       f.estimated_departure_utc,
       f.scheduled_arrival_utc,
       f.estimated_arrival_utc,
       p.expo_push_token,
       seg.marketing_carrier_iata,
       seg.marketing_flight_number
  from public.notification_deliveries d
  join public.flight_events e on e.id = d.flight_event_id
  join public.flights f on f.id = e.flight_id
  left join public.profiles p on p.id = d.user_id
  left join lateral (
         select s.marketing_carrier_iata, s.marketing_flight_number
           from public.trip_segments s
           join public.trips t on t.id = s.trip_id
           join public.travelers tr on tr.id = t.traveler_id
          where s.flight_id = f.id
            and tr.user_id = d.user_id
          order by s.id
          limit 1) seg on true
 where d.id = any($1::uuid[])
   and d.status = 'sending'`;

/**
 * Write the outcome of every claimed row in one statement. Only rows still
 * `sending` are touched, so a row another worker reclaimed after our lease ran out
 * is not overwritten by a late answer. `sent_at` is set for `sent` rows.
 */
export const FINALIZE_SENDS_SQL = `update public.notification_deliveries d
   set status = u.status,
       expo_ticket_id = u.ticket_id,
       push_token_sha256 = u.token_sha256,
       error = u.error,
       not_before = u.not_before,
       sent_at = case when u.status = 'sent' then now() else d.sent_at end,
       claimed_until = null
  from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
       as u(id, status, ticket_id, token_sha256, error, not_before)
 where d.id = u.id
   and d.status = 'sending'`;

/**
 * §8.10 / criterion 10: clear a dead token — **only if the profile still holds
 * the token that failed**. `$2` is its SHA-256; a token registered since has a
 * different hash and survives. Needs `select` and `update` on
 * `profiles.expo_push_token` and `select` on `profiles.id`, which the worker role
 * has, and nothing else.
 */
export const CLEAR_DEAD_TOKEN_SQL = `update public.profiles
   set expo_push_token = null
 where id = $1
   and expo_push_token is not null
   and encode(sha256(convert_to(expo_push_token, 'UTF8')), 'hex') = $2
returning id`;

// --- types ------------------------------------------------------------------

const eventTypeSchema = z.enum(FLIGHT_EVENT_TYPES);
const flightStatusSchema = z.enum([
  'scheduled',
  'delayed',
  'boarding',
  'departed',
  'en_route',
  'diverted',
  'landed',
  'cancelled',
  'unknown',
]);

interface FactsRow {
  delivery_id: string;
  user_id: string;
  attempts: number;
  event_id: string;
  event_type: string;
  previous_value: unknown;
  new_value: unknown;
  detected_at: string;
  flight_id: string;
  operating_carrier_iata: string;
  operating_flight_number: string;
  origin_iata: string;
  destination_iata: string;
  origin_tz: string;
  destination_tz: string;
  departure_date_local: string;
  status: string;
  scheduled_departure_utc: string | null;
  estimated_departure_utc: string | null;
  scheduled_arrival_utc: string | null;
  estimated_arrival_utc: string | null;
  expo_push_token: string | null;
  marketing_carrier_iata: string | null;
  marketing_flight_number: string | null;
}

interface Outcome {
  id: string;
  status: DeliveryStatus;
  ticketId: string | null;
  tokenSha256: string | null;
  error: string | null;
  notBefore: Date | null;
}

export interface PushSendDeps {
  pool: Pool;
  expo: ExpoPushClient;
  logger: Logger;
  /** InvalidCredentials and a rejected access token reach the operator. */
  operatorAlerts?: OperatorAlertSink;
  now?: () => Date;
  batchSize?: number;
  maxBatches?: number;
}

export interface PushSendSummary {
  claimed: number;
  sent: number;
  failed: number;
  retrying: number;
  skipped: number;
  expired: number;
  unconfirmed: number;
  tokensCleared: number;
  closedInterrupted: number;
}

function emptySummary(): PushSendSummary {
  return {
    claimed: 0,
    sent: 0,
    failed: 0,
    retrying: 0,
    skipped: 0,
    expired: 0,
    unconfirmed: 0,
    tokensCleared: 0,
    closedInterrupted: 0,
  };
}

function toFacts(row: FactsRow): MessageFacts | null {
  const eventType = eventTypeSchema.safeParse(row.event_type);
  const status = flightStatusSchema.safeParse(row.status);
  if (!eventType.success || !status.success) return null;
  return {
    eventType: eventType.data,
    flightId: row.flight_id,
    previousValue: row.previous_value,
    newValue: row.new_value,
    marketingCarrierIata: row.marketing_carrier_iata,
    marketingFlightNumber: row.marketing_flight_number,
    operatingCarrierIata: row.operating_carrier_iata,
    operatingFlightNumber: row.operating_flight_number,
    originIata: row.origin_iata,
    destinationIata: row.destination_iata,
    originTz: row.origin_tz,
    destinationTz: row.destination_tz,
    departureDateLocal: row.departure_date_local,
    status: status.data,
    scheduledDepartureUtc: row.scheduled_departure_utc,
    estimatedDepartureUtc: row.estimated_departure_utc,
    scheduledArrivalUtc: row.scheduled_arrival_utc,
    estimatedArrivalUtc: row.estimated_arrival_utc,
  };
}

/** Build a push message. Exported for the operator path and tests. */
export function toExpoMessage(
  token: string,
  copy: { title: string; body: string; data: Record<string, string> },
  collapseId?: string,
): ExpoPushMessage {
  return {
    to: token,
    title: copy.title,
    body: copy.body,
    data: copy.data,
    sound: 'default',
    priority: 'high',
    channelId: ANDROID_CHANNEL_ID,
    ...(collapseId === undefined ? {} : { collapseId }),
  };
}

/** Retry later, or close when the attempts are spent. */
function retryOrClose(id: string, attempts: number, now: Date, closeError: string): Outcome {
  if (attempts >= MAX_SEND_ATTEMPTS) {
    return {
      id,
      status: 'failed',
      ticketId: null,
      tokenSha256: null,
      error: closeError,
      notBefore: null,
    };
  }
  return {
    id,
    status: 'pending',
    ticketId: null,
    tokenSha256: null,
    error: null,
    notBefore: new Date(now.getTime() + retryDelayMs(attempts)),
  };
}

/**
 * Clear a dead token if the profile still holds it. Returns whether it did.
 * Shared with the receipt job and the operator path.
 */
export async function clearDeadToken(
  pool: Pool,
  userId: string,
  tokenSha256: string,
): Promise<boolean> {
  const result = await pool.query<{ id: string }>({
    text: CLEAR_DEAD_TOKEN_SQL,
    values: [userId, tokenSha256],
    types: ENGINE_TYPES,
  });
  return result.rows.length > 0;
}

async function finalize(pool: Pool, outcomes: readonly Outcome[]): Promise<void> {
  if (outcomes.length === 0) return;
  await pool.query({
    text: FINALIZE_SENDS_SQL,
    values: [
      outcomes.map((o) => o.id),
      outcomes.map((o) => o.status),
      outcomes.map((o) => o.ticketId),
      outcomes.map((o) => o.tokenSha256),
      outcomes.map((o) => o.error),
      outcomes.map((o) => o.notBefore),
    ],
    types: ENGINE_TYPES,
  });
}

interface Outgoing {
  row: FactsRow;
  token: string;
  tokenSha256: string;
  message: ExpoPushMessage;
}

/** One claim → send → record cycle. Returns how many rows it claimed. */
async function runBatch(
  deps: PushSendDeps,
  summary: PushSendSummary,
  batchSize: number,
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const { logger } = deps;

  const claimed = await deps.pool.query<{ id: string }>({
    text: CLAIM_DELIVERIES_SQL,
    values: [batchSize, SEND_LEASE_MS, MAX_SEND_ATTEMPTS],
    types: ENGINE_TYPES,
  });
  const ids = claimed.rows.map((row) => row.id);
  if (ids.length === 0) return 0;
  summary.claimed += ids.length;

  const facts = await deps.pool.query<FactsRow>({
    text: LOAD_DELIVERY_FACTS_SQL,
    values: [ids],
    types: ENGINE_TYPES,
  });

  const outcomes: Outcome[] = [];
  const outgoing: Outgoing[] = [];

  for (const row of facts.rows) {
    const close = (status: DeliveryStatus, error: string): void => {
      outcomes.push({
        id: row.delivery_id,
        status,
        ticketId: null,
        tokenSha256: null,
        error,
        notBefore: null,
      });
    };

    const detectedMs = Date.parse(row.detected_at);
    if (Number.isNaN(detectedMs) || now.getTime() - detectedMs > maxDeliveryAgeMs(row.event_type)) {
      close('expired', DELIVERY_ERRORS.EXPIRED);
      summary.expired += 1;
      continue;
    }
    if (row.expo_push_token === null || row.expo_push_token === '') {
      close('skipped', DELIVERY_ERRORS.NO_PUSH_TOKEN);
      summary.skipped += 1;
      continue;
    }
    if (!isExpoPushToken(row.expo_push_token)) {
      // Not something Expo would accept; the app only ever stores Expo tokens.
      // Left on the profile — the app's next registration replaces it.
      close('failed', DELIVERY_ERRORS.INVALID_PUSH_TOKEN);
      summary.failed += 1;
      continue;
    }
    const messageFacts = toFacts(row);
    if (messageFacts === null) {
      close('failed', DELIVERY_ERRORS.UNBUILDABLE_MESSAGE);
      summary.failed += 1;
      continue;
    }

    const token = row.expo_push_token;
    outgoing.push({
      row,
      token,
      tokenSha256: pushTokenSha256(token),
      // collapseId = the event: a re-sent duplicate replaces the first on iOS.
      message: toExpoMessage(token, buildPushCopy(messageFacts), row.event_id),
    });
  }

  if (outgoing.length > 0) {
    let tickets: ExpoTicket[] | null = null;
    try {
      tickets = await deps.expo.send(outgoing.map((item) => item.message));
    } catch (error) {
      if (!(error instanceof ExpoRequestError)) throw error;
      const retryable = error.kind !== 'rejected';
      for (const item of outgoing) {
        if (retryable) {
          const outcome = retryOrClose(
            item.row.delivery_id,
            item.row.attempts,
            now,
            error.kind === 'ambiguous'
              ? DELIVERY_ERRORS.SEND_OUTCOME_UNKNOWN
              : DELIVERY_ERRORS.EXPO_UNAVAILABLE,
          );
          outcomes.push(outcome);
          if (outcome.status === 'pending') summary.retrying += 1;
          else summary.failed += 1;
        } else {
          outcomes.push({
            id: item.row.delivery_id,
            status: 'failed',
            ticketId: null,
            tokenSha256: null,
            error: error.code ?? `Http${error.status ?? 'Error'}`,
            notBefore: null,
          });
          summary.failed += 1;
        }
      }
      const fields = {
        kind: error.kind,
        status: error.status,
        code: error.code,
        messageCount: outgoing.length,
      };
      if (error.kind === 'unauthorized') {
        logger.error(fields, 'Expo refused the push request: check EXPO_ACCESS_TOKEN');
        await deps.operatorAlerts?.raise({ kind: 'push_unauthorized' });
      } else if (error.kind === 'rejected') {
        logger.error(fields, 'Expo rejected the push request; deliveries closed as failed');
      } else {
        logger.warn(fields, 'Expo push request failed; deliveries will be retried');
      }
    }

    if (tickets !== null) {
      let invalidCredentials = 0;
      for (const [index, item] of outgoing.entries()) {
        const ticket = tickets[index] as ExpoTicket;
        const id = item.row.delivery_id;

        if (ticket.status === 'ok') {
          outcomes.push({
            id,
            status: 'sent',
            ticketId: ticket.id,
            tokenSha256: item.tokenSha256,
            error: null,
            notBefore: null,
          });
          summary.sent += 1;
          continue;
        }
        if (ticket.status === 'unreadable') {
          outcomes.push({
            id,
            status: 'unconfirmed',
            ticketId: null,
            tokenSha256: item.tokenSha256,
            error: DELIVERY_ERRORS.UNREADABLE_TICKET,
            notBefore: null,
          });
          summary.unconfirmed += 1;
          continue;
        }

        const code = ticket.errorCode;
        if (code === EXPO_ERROR_CODES.MESSAGE_RATE_EXCEEDED) {
          const outcome = retryOrClose(id, item.row.attempts, now, code);
          outcomes.push(outcome);
          if (outcome.status === 'pending') summary.retrying += 1;
          else summary.failed += 1;
          continue;
        }

        outcomes.push({
          id,
          status: 'failed',
          ticketId: null,
          tokenSha256: item.tokenSha256,
          error: code,
          notBefore: null,
        });
        summary.failed += 1;

        if (code === EXPO_ERROR_CODES.DEVICE_NOT_REGISTERED) {
          if (await clearDeadToken(deps.pool, item.row.user_id, item.tokenSha256))
            summary.tokensCleared += 1;
        } else if (code === EXPO_ERROR_CODES.INVALID_CREDENTIALS) {
          invalidCredentials += 1;
        }
      }

      const errorCodes = outgoing.flatMap((_, index) => {
        const ticket = tickets?.[index];
        return ticket?.status === 'error' ? [ticket.errorCode] : [];
      });
      if (errorCodes.length > 0) {
        logger.warn({ codes: countCodes(errorCodes) }, 'Expo returned error tickets');
      }
      if (invalidCredentials > 0) {
        logger.error(
          { count: invalidCredentials },
          'Expo reports InvalidCredentials: the push key on EAS is broken',
        );
        await deps.operatorAlerts?.raise({
          kind: 'push_credentials_invalid',
          count: invalidCredentials,
        });
      }
    }
  }

  // Claimed rows whose facts vanished (e.g. a flight deleted by cascade between
  // the claim and the read) are simply left: the cascade deletes them too.
  await finalize(deps.pool, outcomes);
  return ids.length;
}

/** `{ DeviceNotRegistered: 2, … }`: codes and counts, the only shape logged. */
export function countCodes(codes: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of codes) counts[code] = (counts[code] ?? 0) + 1;
  return counts;
}

/**
 * One run: close exhausted interrupted sends, then send in batches of ≤ 100
 * until nothing is left or `MAX_BATCHES_PER_RUN` is reached (the next run, a
 * minute later at most, continues).
 *
 * @throws on a database failure; pg-boss records the job failed and the next
 *   minute's sweep runs again. Expo failures never throw: they become row states.
 */
export async function runPushSend(deps: PushSendDeps): Promise<PushSendSummary> {
  const summary = emptySummary();
  const batchSize = Math.min(deps.batchSize ?? MAX_MESSAGES_PER_REQUEST, MAX_MESSAGES_PER_REQUEST);
  const maxBatches = deps.maxBatches ?? MAX_BATCHES_PER_RUN;

  const closed = await deps.pool.query<{ id: string }>({
    text: CLOSE_EXHAUSTED_SENDS_SQL,
    values: [MAX_SEND_ATTEMPTS, DELIVERY_ERRORS.SEND_OUTCOME_UNKNOWN],
    types: ENGINE_TYPES,
  });
  summary.closedInterrupted = closed.rows.length;
  if (closed.rows.length > 0) {
    deps.logger.warn(
      { deliveryIds: closed.rows.map((row) => row.id) },
      'interrupted push sends ran out of attempts; closed as SendOutcomeUnknown',
    );
  }

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const claimed = await runBatch(deps, summary, batchSize);
    if (claimed < batchSize) break;
  }

  if (summary.claimed > 0 || summary.closedInterrupted > 0) {
    deps.logger.info({ ...summary }, 'push send run complete');
  }
  return summary;
}

/** The pg-boss handler for `push-send` (scheduled sweep and on-demand wake-ups). */
export function createPushSendHandler(deps: PushSendDeps) {
  return async function handlePushSend(): Promise<void> {
    await runPushSend(deps);
  };
}
