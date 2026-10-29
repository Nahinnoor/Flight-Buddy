/**
 * Operator alerts: a push to the owner's own phone (overview §7.7 step 4, ADR 0003
 * decision 4, PHASE2_PLAN §8.4), addressed by `OPERATOR_USER_ID`.
 *
 * ## Why not `notification_deliveries`
 *
 * A delivery row belongs to a `flight_events` row (foreign key), and an operator
 * alert is about the account, not a flight. Faking an event to hang it on would
 * put a lie in the flight history the app reads. Instead:
 *
 * - **A pg-boss job** on the `operator-alert` queue carries the alert's typed
 *   fields (kind, threshold, balance, counts — no user id, no token, no copy).
 *   pg-boss gives it what wave 4 said the push path needed: its own **retry**
 *   (5 retries, exponential back-off from one minute), durable across a restart.
 *   The credit monitor's crossing logic has already de-duplicated it; a
 *   `credit-check` retry would find the mark disarmed and never re-send.
 * - The handler reads the operator's **active devices** (`push_tokens`, ADR 0006)
 *   at send time and sends one message to each, in one request (at most 10
 *   devices, so far under Expo's 100). Tickets are **not** stored and no receipt
 *   is fetched. A `DeviceNotRegistered` ticket invalidates that device only.
 *
 * ## Degrading, never throwing
 *
 * No `OPERATOR_USER_ID`, or no active device: one log line says so, and the
 * existing `warn`/`error` line from the raising job stands as the alert (it is
 * written before the sink is called). `raise` never throws; an enqueue failure is
 * logged.
 *
 * ## No loops
 *
 * Nothing on the operator path raises an operator alert. A failed operator push is
 * logged and retried by pg-boss, then logged as given up — never fed back into
 * `raise`. Its ticket is not kept, so the receipt job cannot see it fail either.
 * The two alerts the push pipeline itself raises (`push_credentials_invalid`,
 * `push_unauthorized`) will usually fail to arrive for the very reason they were
 * raised — that is expected; their `error` log line is the one that matters, and
 * they are throttled to one per kind per `PUSH_ALERT_THROTTLE_MS` per process.
 */
import { z } from 'zod';

import type { Pool } from '../db';
import { ENGINE_TYPES } from '../engine/types';
import { errorName } from '../errors';
import type { Logger } from '../logger';
import { MAX_DEVICES_PER_RECIPIENT, invalidateDeadDevice } from './deviceSends';
import { EXPO_ERROR_CODES, ExpoRequestError, type ExpoPushClient } from './expoClient';
import { countCodes, toExpoMessage } from './pushSend';
import { isExpoPushToken, pushTokenSha256 } from './tokens';

/** pg-boss retry policy for the operator push (seconds). */
export const OPERATOR_ALERT_RETRY = {
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 15 * 60,
} as const;

/** At most one push-pipeline alert of each kind per process in this window. */
export const PUSH_ALERT_THROTTLE_MS = 6 * 60 * 60_000;

export const operatorNoticeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['credit_low', 'credit_exhausted']),
    threshold: z.number().int(),
    balance: z.number().int(),
    failedOver: z.number().int().min(0),
  }),
  z.object({ kind: z.literal('push_credentials_invalid'), count: z.number().int().min(1) }),
  z.object({ kind: z.literal('push_unauthorized') }),
]);

/** What an operator alert says, as data. The copy is built at send time. */
export type OperatorNotice = z.infer<typeof operatorNoticeSchema>;

export interface OperatorAlertSink {
  /** Never throws. */
  raise(notice: OperatorNotice): Promise<void>;
}

/**
 * The operator's active devices, newest first, and the database time of the
 * read: a device that registers again after it cannot be invalidated by this
 * send. `$2` = `MAX_DEVICES_PER_RECIPIENT`.
 */
export const READ_OPERATOR_DEVICES_SQL = `select token,
       token_sha256,
       now() as read_at
  from public.push_tokens
 where user_id = $1
   and invalidated_at is null
 order by last_registered_at desc, id desc
 limit $2`;

/** Lock-screen copy for the owner. Numbers and fixed words only. */
export function operatorCopy(notice: OperatorNotice): { title: string; body: string } {
  switch (notice.kind) {
    case 'credit_low':
      return {
        title: 'FlightBuddy: alert credits low',
        body: `Balance ${notice.balance}, at or below ${notice.threshold}. Refill by hand.`,
      };
    case 'credit_exhausted':
      return {
        title: 'FlightBuddy: alert credits exhausted',
        body: `Balance ${notice.balance}. Alerts are paused; ${notice.failedOver} subscribed flight(s) are back on polling. Refill by hand.`,
      };
    case 'push_credentials_invalid':
      return {
        title: 'FlightBuddy: push credentials rejected',
        body: `Expo reported InvalidCredentials on ${notice.count} notification(s). Check the APNs key with eas credentials.`,
      };
    case 'push_unauthorized':
      return {
        title: 'FlightBuddy: Expo refused the access token',
        body: 'Pushes are failing. Check EXPO_ACCESS_TOKEN on the worker.',
      };
  }
}

export interface OperatorAlertSinkOptions {
  /** `OPERATOR_USER_ID`; unset = log only. Never logged. */
  operatorUserId: string | undefined;
  logger: Logger;
  /** Put the notice on the `operator-alert` queue. */
  enqueue: (notice: OperatorNotice) => Promise<unknown>;
  now?: () => Date;
}

const PUSH_KINDS: ReadonlySet<OperatorNotice['kind']> = new Set([
  'push_credentials_invalid',
  'push_unauthorized',
]);

export function createOperatorAlertSink(options: OperatorAlertSinkOptions): OperatorAlertSink {
  const lastRaised = new Map<OperatorNotice['kind'], number>();
  const now = options.now ?? (() => new Date());

  return {
    async raise(notice) {
      try {
        if (options.operatorUserId === undefined) {
          options.logger.info(
            { operatorAlert: notice.kind },
            'no OPERATOR_USER_ID configured; the log line is the operator alert',
          );
          return;
        }
        if (PUSH_KINDS.has(notice.kind)) {
          const at = now().getTime();
          const last = lastRaised.get(notice.kind);
          if (last !== undefined && at - last < PUSH_ALERT_THROTTLE_MS) {
            options.logger.debug({ operatorAlert: notice.kind }, 'operator alert throttled');
            return;
          }
          lastRaised.set(notice.kind, at);
        }
        await options.enqueue(notice);
        options.logger.info({ operatorAlert: notice.kind }, 'operator alert queued for push');
      } catch (error) {
        options.logger.error(
          {
            operatorAlert: notice.kind,
            errorName: errorName(error),
          },
          'operator alert could not be queued; the log line stands in for it',
        );
      }
    },
  };
}

export interface OperatorPushDeps {
  pool: Pool;
  expo: ExpoPushClient;
  logger: Logger;
  operatorUserId: string | undefined;
}

export type OperatorPushResult = 'sent' | 'no_operator' | 'no_token' | 'failed';

/**
 * Send one operator alert to every active device of the operator.
 *
 * Resolves `'sent'` when at least one device got a ticket.
 *
 * @throws ExpoRequestError when Expo is unavailable (429/5xx/401) or the outcome
 *   is unknown, so pg-boss retries the job (every device again: none of them
 *   is known to have it). A definitive failure (a rejected request, an error
 *   ticket on every device) resolves `'failed'` and is not retried.
 */
export async function sendOperatorAlert(
  notice: OperatorNotice,
  deps: OperatorPushDeps,
): Promise<OperatorPushResult> {
  const { logger } = deps;
  if (deps.operatorUserId === undefined) {
    logger.info(
      { operatorAlert: notice.kind },
      'no OPERATOR_USER_ID configured; operator push skipped',
    );
    return 'no_operator';
  }

  const result = await deps.pool.query<{ token: string; token_sha256: string; read_at: string }>({
    text: READ_OPERATOR_DEVICES_SQL,
    values: [deps.operatorUserId, MAX_DEVICES_PER_RECIPIENT],
    types: ENGINE_TYPES,
  });
  const devices = result.rows.filter((row) => isExpoPushToken(row.token));
  if (devices.length === 0) {
    logger.warn(
      { operatorAlert: notice.kind },
      'the operator has no active push device; the log line is the operator alert',
    );
    return 'no_token';
  }

  const copy = operatorCopy(notice);
  let tickets;
  try {
    tickets = await deps.expo.send(
      devices.map((device) =>
        toExpoMessage(device.token, { ...copy, data: { kind: notice.kind } }),
      ),
    );
  } catch (error) {
    if (error instanceof ExpoRequestError && error.kind === 'rejected') {
      logger.error(
        { operatorAlert: notice.kind, status: error.status, code: error.code },
        'Expo rejected the operator push; not retried',
      );
      return 'failed';
    }
    // Logged here, retried by pg-boss. Never raised as another operator alert.
    logger.warn(
      {
        operatorAlert: notice.kind,
        kind: error instanceof ExpoRequestError ? error.kind : 'unknown',
        errorName: errorName(error),
      },
      'operator push failed; pg-boss will retry',
    );
    throw error;
  }

  let sent = 0;
  const codes: string[] = [];
  for (const [index, device] of devices.entries()) {
    const ticket = tickets[index];
    if (ticket?.status === 'ok') {
      sent += 1;
      continue;
    }
    const code = ticket?.status === 'error' ? ticket.errorCode : 'UnreadableTicket';
    codes.push(code);
    if (code === EXPO_ERROR_CODES.DEVICE_NOT_REGISTERED) {
      await invalidateDeadDevice(
        deps.pool,
        deps.operatorUserId,
        pushTokenSha256(device.token),
        device.read_at,
      );
    }
  }

  if (codes.length > 0) {
    logger.error(
      { operatorAlert: notice.kind, codes: countCodes(codes) },
      'operator push refused by Expo on some devices; not retried',
    );
  }
  if (sent > 0) {
    logger.info({ operatorAlert: notice.kind, devices: sent }, 'operator push sent');
    return 'sent';
  }
  return 'failed';
}

/** The pg-boss handler for `operator-alert`. A job whose data does not parse is dropped. */
export function createOperatorAlertHandler(deps: OperatorPushDeps) {
  return async function handleOperatorAlert(jobs: { data: unknown }[]): Promise<void> {
    for (const job of jobs) {
      const notice = operatorNoticeSchema.safeParse(job.data);
      if (!notice.success) {
        deps.logger.error('operator-alert job carried unreadable data; dropped');
        continue;
      }
      await sendOperatorAlert(notice.data, deps);
    }
  };
}
