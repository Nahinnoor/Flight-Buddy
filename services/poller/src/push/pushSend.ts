/**
 * `push-send`: pending `notification_deliveries` → Expo Push, one message per
 * active device of the recipient (§9, wave 5; ADR 0006 sub-step ii).
 *
 * ```
 * close rows whose interrupted sends ran out of attempts
 * loop (≤ MAX_BATCHES):
 *   claim ≤ 100 rows          pending (not_before passed) or sending (lease passed)
 *                             → sending, attempts + 1, lease   [commit]
 *   read the message facts    event, flight, the user's own segment
 *   read the devices          the recipient's active push_tokens (≤ 10) that have
 *                             no recorded outcome for this delivery yet
 *   per row: expired? no device? unbuildable? → closed without sending
 *   Expo requests             ≤ 100 messages each, one per device; collapseId =
 *                             the event id on every one; each request's device
 *                             outcomes are written as soon as it answers
 *   per ticket: ok → device sent (ticket id)
 *               DeviceNotRegistered → device failed, that device invalidated
 *               MessageRateExceeded → device retried with back-off
 *               InvalidCredentials → device failed, operator alert
 *               other error → device failed (code only)
 *   request failed: 429/5xx/401/network/timeout → its devices retried (and no
 *               further request this batch); other 4xx → its devices failed
 *   per row: status derived from its devices (deliveryStatus.ts, "Parent status")
 * ```
 *
 * The status lifecycle and the crash window are in `deliveryStatus.ts`; the one
 * line version is: we prefer a rare duplicate (coalesced by iOS through
 * `collapseId`) to a dropped gate change, and a device that already holds a
 * ticket is never sent the same delivery again.
 *
 * ## How it is triggered
 *
 * A pg-boss job on the `push-send` queue, scheduled every minute as a sweep, and
 * also sent by the poll and webhook paths the moment they create deliveries
 * (`onDeliveriesCreated` in `main.ts`), so a gate change reaches the phone in
 * seconds. pg-boss runs one handler at a time per process; across two processes
 * (a deploy overlap) the claim's `for update skip locked` and lease keep each row
 * with one sender, and the device rows keep a late second sender from re-sending
 * to a device that already has a ticket.
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
  CLOSE_EXHAUSTED_SENDS_SQL,
  FINALIZE_SENDS_SQL,
  LOAD_SENDABLE_DEVICES_SQL,
  MAX_DEVICES_PER_RECIPIENT,
  invalidateDeadDevice,
  recordDeviceSends,
  type DeviceSendRecord,
} from './deviceSends';
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

export { CLOSE_EXHAUSTED_SENDS_SQL, FINALIZE_SENDS_SQL } from './deviceSends';

/** Android channel the app registers (`apps/mobile/src/lib/push.ts`). */
export const ANDROID_CHANNEL_ID = 'flight-updates';

/** Batches per run: 1,000 deliveries, well inside Expo's 600/s per project. */
export const MAX_BATCHES_PER_RUN = 10;

// --- SQL --------------------------------------------------------------------

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
 * Everything one message is built from, for the claimed ids. The devices are a
 * separate read (`LOAD_SENDABLE_DEVICES_SQL`), also at send time.
 *
 * The flight number is the one on the recipient's **own** segment for this
 * flight (what they typed, §7.2). Only columns the worker role holds a grant on:
 * `trip_segments(id, trip_id, flight_id, marketing_*)`, `trips(id, traveler_id)`,
 * `travelers(id, user_id)`.
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
       seg.marketing_carrier_iata,
       seg.marketing_flight_number
  from public.notification_deliveries d
  join public.flight_events e on e.id = d.flight_event_id
  join public.flights f on f.id = e.flight_id
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
  marketing_carrier_iata: string | null;
  marketing_flight_number: string | null;
}

interface DeviceRow {
  delivery_id: string;
  token: string;
  token_sha256: string;
}

/** What this attempt concluded for one delivery; SQL derives the final status. */
interface ParentOutcome {
  id: string;
  attempts: number;
  /** A device still needs a retry (and attempts remain). */
  retry: boolean;
  /** Used only when no device row decides (deliveryStatus.ts, "Parent status"). */
  status: DeliveryStatus;
  error: string | null;
  notBefore: Date;
}

export interface PushSendDeps {
  pool: Pool;
  expo: ExpoPushClient;
  logger: Logger;
  /** InvalidCredentials and a rejected access token reach the operator. */
  operatorAlerts?: OperatorAlertSink;
  now?: () => Date;
  /** Deliveries claimed per batch (≤ 100). Messages per Expo request are always ≤ 100. */
  batchSize?: number;
  maxBatches?: number;
}

/**
 * `claimed`, `skipped` and `expired` count deliveries (people); `messages`,
 * `sent`, `failed`, `retrying` and `unconfirmed` count devices (`failed` also
 * counts deliveries closed as `UnbuildableMessage`). `skipped` = no device left
 * to send to this attempt; a re-claimed delivery whose devices all have rows
 * already is counted here but still ends `sent` (its rows decide).
 */
export interface PushSendSummary {
  claimed: number;
  messages: number;
  sent: number;
  failed: number;
  retrying: number;
  skipped: number;
  expired: number;
  unconfirmed: number;
  devicesInvalidated: number;
  closedInterrupted: number;
}

function emptySummary(): PushSendSummary {
  return {
    claimed: 0,
    messages: 0,
    sent: 0,
    failed: 0,
    retrying: 0,
    skipped: 0,
    expired: 0,
    unconfirmed: 0,
    devicesInvalidated: 0,
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

async function finalize(pool: Pool, outcomes: readonly ParentOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;
  await pool.query({
    text: FINALIZE_SENDS_SQL,
    values: [
      outcomes.map((o) => o.id),
      outcomes.map((o) => o.attempts),
      outcomes.map((o) => o.retry),
      outcomes.map((o) => o.status),
      outcomes.map((o) => o.error),
      outcomes.map((o) => o.notBefore),
      MAX_SEND_ATTEMPTS,
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

/** Per delivery: the retryable failure codes of its devices this attempt. */
type RetryCodes = Map<string, string[]>;

/** `{ DeviceNotRegistered: 2, … }`: codes and counts, the only shape logged. */
export function countCodes(codes: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of codes) counts[code] = (counts[code] ?? 0) + 1;
  return counts;
}

/**
 * Write one request's device outcomes, then invalidate its dead devices. A row
 * the insert did not write (another sender recorded this device first) is not
 * acted on.
 */
async function recordChunk(
  deps: PushSendDeps,
  summary: PushSendSummary,
  records: readonly DeviceSendRecord[],
  userOf: ReadonlyMap<string, string>,
): Promise<void> {
  const written = await recordDeviceSends(deps.pool, records);
  for (const row of written) {
    const record = records.find(
      (r) => r.deliveryId === row.delivery_id && r.tokenSha256 === row.token_sha256,
    );
    if (record?.error !== EXPO_ERROR_CODES.DEVICE_NOT_REGISTERED) continue;
    const userId = userOf.get(row.delivery_id);
    if (userId === undefined) continue;
    if (await invalidateDeadDevice(deps.pool, userId, row.token_sha256, row.sent_at)) {
      summary.devicesInvalidated += 1;
    }
  }
}

/**
 * A device whose send failed retryably: retried with its delivery while
 * attempts remain, else closed as its own `failed` row with `code`.
 */
function retryOrCloseDevice(
  item: Outgoing,
  code: string,
  retries: RetryCodes,
  records: DeviceSendRecord[],
  summary: PushSendSummary,
): void {
  if (item.row.attempts >= MAX_SEND_ATTEMPTS) {
    records.push({
      deliveryId: item.row.delivery_id,
      tokenSha256: item.tokenSha256,
      status: 'failed',
      ticketId: null,
      error: code,
    });
    summary.failed += 1;
    return;
  }
  const codes = retries.get(item.row.delivery_id) ?? [];
  codes.push(code);
  retries.set(item.row.delivery_id, codes);
  summary.retrying += 1;
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
  const devices = await deps.pool.query<DeviceRow>({
    text: LOAD_SENDABLE_DEVICES_SQL,
    values: [ids, MAX_DEVICES_PER_RECIPIENT],
    types: ENGINE_TYPES,
  });
  const devicesOf = new Map<string, DeviceRow[]>();
  for (const device of devices.rows) {
    const list = devicesOf.get(device.delivery_id) ?? [];
    list.push(device);
    devicesOf.set(device.delivery_id, list);
  }

  /** Deliveries closed without a send, by their fallback status. */
  const closed = new Map<string, { status: DeliveryStatus; error: string }>();
  const outgoing: Outgoing[] = [];
  const unsendable: DeviceSendRecord[] = [];
  const userOf = new Map<string, string>();

  for (const row of facts.rows) {
    userOf.set(row.delivery_id, row.user_id);
    const detectedMs = Date.parse(row.detected_at);
    if (Number.isNaN(detectedMs) || now.getTime() - detectedMs > maxDeliveryAgeMs(row.event_type)) {
      closed.set(row.delivery_id, { status: 'expired', error: DELIVERY_ERRORS.EXPIRED });
      summary.expired += 1;
      continue;
    }
    const messageFacts = toFacts(row);
    if (messageFacts === null) {
      closed.set(row.delivery_id, {
        status: 'failed',
        error: DELIVERY_ERRORS.UNBUILDABLE_MESSAGE,
      });
      summary.failed += 1;
      continue;
    }
    const targets = devicesOf.get(row.delivery_id) ?? [];
    if (targets.length === 0) {
      // No active device needing this message. If an earlier attempt already
      // reached a device, the device rows outrank this fallback.
      closed.set(row.delivery_id, { status: 'skipped', error: DELIVERY_ERRORS.NO_PUSH_TOKEN });
      summary.skipped += 1;
      continue;
    }

    const copy = buildPushCopy(messageFacts);
    for (const device of targets) {
      if (!isExpoPushToken(device.token)) {
        // The table's check constraint makes this unreachable; never sent.
        unsendable.push({
          deliveryId: row.delivery_id,
          tokenSha256: device.token_sha256,
          status: 'failed',
          ticketId: null,
          error: DELIVERY_ERRORS.INVALID_PUSH_TOKEN,
        });
        summary.failed += 1;
        continue;
      }
      outgoing.push({
        row,
        token: device.token,
        // Recomputed, not trusted from the row: it must be the hash of what we send.
        tokenSha256: pushTokenSha256(device.token),
        // collapseId = the event on every device: a re-sent duplicate replaces
        // the first on iOS.
        message: toExpoMessage(device.token, copy, row.event_id),
      });
    }
  }

  await recordChunk(deps, summary, unsendable, userOf);

  const retries: RetryCodes = new Map();
  const errorCodes: string[] = [];
  let invalidCredentials = 0;
  let unauthorized = false;
  /** Set by a retryable request failure: Expo is struggling, stop for this batch. */
  let haltCode: string | null = null;

  for (let start = 0; start < outgoing.length; start += MAX_MESSAGES_PER_REQUEST) {
    const chunk = outgoing.slice(start, start + MAX_MESSAGES_PER_REQUEST);
    const records: DeviceSendRecord[] = [];

    if (haltCode !== null) {
      for (const item of chunk) retryOrCloseDevice(item, haltCode, retries, records, summary);
      await recordChunk(deps, summary, records, userOf);
      continue;
    }

    let tickets: ExpoTicket[] | null = null;
    summary.messages += chunk.length;
    try {
      tickets = await deps.expo.send(chunk.map((item) => item.message));
    } catch (error) {
      if (!(error instanceof ExpoRequestError)) throw error;
      const fields = {
        kind: error.kind,
        status: error.status,
        code: error.code,
        messageCount: chunk.length,
      };
      if (error.kind === 'rejected') {
        for (const item of chunk) {
          records.push({
            deliveryId: item.row.delivery_id,
            tokenSha256: item.tokenSha256,
            status: 'failed',
            ticketId: null,
            error: error.code ?? `Http${error.status ?? 'Error'}`,
          });
          summary.failed += 1;
        }
        logger.error(fields, 'Expo rejected the push request; those devices closed as failed');
      } else {
        const code =
          error.kind === 'ambiguous'
            ? DELIVERY_ERRORS.SEND_OUTCOME_UNKNOWN
            : DELIVERY_ERRORS.EXPO_UNAVAILABLE;
        for (const item of chunk) retryOrCloseDevice(item, code, retries, records, summary);
        // The rest of this batch is not attempted: Expo was unavailable for it.
        haltCode = DELIVERY_ERRORS.EXPO_UNAVAILABLE;
        if (error.kind === 'unauthorized') {
          unauthorized = true;
          logger.error(fields, 'Expo refused the push request: check EXPO_ACCESS_TOKEN');
        } else {
          logger.warn(fields, 'Expo push request failed; deliveries will be retried');
        }
      }
    }

    if (tickets !== null) {
      for (const [index, item] of chunk.entries()) {
        const ticket = tickets[index] as ExpoTicket;
        const base = { deliveryId: item.row.delivery_id, tokenSha256: item.tokenSha256 };

        if (ticket.status === 'ok') {
          records.push({ ...base, status: 'sent', ticketId: ticket.id, error: null });
          summary.sent += 1;
          continue;
        }
        if (ticket.status === 'unreadable') {
          records.push({
            ...base,
            status: 'unconfirmed',
            ticketId: null,
            error: DELIVERY_ERRORS.UNREADABLE_TICKET,
          });
          summary.unconfirmed += 1;
          continue;
        }

        const code = ticket.errorCode;
        errorCodes.push(code);
        if (code === EXPO_ERROR_CODES.MESSAGE_RATE_EXCEEDED) {
          retryOrCloseDevice(item, code, retries, records, summary);
          continue;
        }
        records.push({ ...base, status: 'failed', ticketId: null, error: code });
        summary.failed += 1;
        if (code === EXPO_ERROR_CODES.INVALID_CREDENTIALS) invalidCredentials += 1;
      }
    }

    // Durable per request: a crash after this line re-sends none of these devices.
    await recordChunk(deps, summary, records, userOf);
  }

  if (errorCodes.length > 0) {
    logger.warn({ codes: countCodes(errorCodes) }, 'Expo returned error tickets');
  }
  if (unauthorized) await deps.operatorAlerts?.raise({ kind: 'push_unauthorized' });
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

  const outcomes: ParentOutcome[] = facts.rows.map((row) => {
    const notBefore = new Date(now.getTime() + retryDelayMs(row.attempts));
    const fallback = closed.get(row.delivery_id);
    if (fallback !== undefined) {
      return { id: row.delivery_id, attempts: row.attempts, retry: false, ...fallback, notBefore };
    }
    const codes = retries.get(row.delivery_id);
    return {
      id: row.delivery_id,
      attempts: row.attempts,
      retry: codes !== undefined,
      // Every device has a row now (sent, failed, unconfirmed); they decide.
      status: 'failed',
      error: null,
      notBefore,
    };
  });

  // Claimed rows whose facts vanished (e.g. a flight deleted by cascade between
  // the claim and the read) are simply left: the cascade deletes them too.
  await finalize(deps.pool, outcomes);
  return ids.length;
}

/**
 * One run: close exhausted interrupted sends, then send in batches of ≤ 100
 * deliveries (≤ 100 messages per Expo request) until nothing is left or
 * `MAX_BATCHES_PER_RUN` is reached (the next run, a minute later at most,
 * continues).
 *
 * @throws on a database failure; pg-boss records the job failed and the next
 *   minute's sweep runs again. Expo failures never throw: they become row states.
 */
export async function runPushSend(deps: PushSendDeps): Promise<PushSendSummary> {
  const summary = emptySummary();
  const batchSize = Math.min(deps.batchSize ?? MAX_MESSAGES_PER_REQUEST, MAX_MESSAGES_PER_REQUEST);
  const maxBatches = deps.maxBatches ?? MAX_BATCHES_PER_RUN;

  const closed = await deps.pool.query<{ id: string; status: string }>({
    text: CLOSE_EXHAUSTED_SENDS_SQL,
    values: [MAX_SEND_ATTEMPTS, DELIVERY_ERRORS.SEND_OUTCOME_UNKNOWN],
    types: ENGINE_TYPES,
  });
  summary.closedInterrupted = closed.rows.length;
  if (closed.rows.length > 0) {
    deps.logger.warn(
      {
        deliveryIds: closed.rows.map((row) => row.id),
        statuses: countCodes(closed.rows.map((row) => row.status)),
      },
      'interrupted push sends ran out of attempts; closed',
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
