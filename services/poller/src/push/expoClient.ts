/**
 * Expo Push over plain `fetch` (overview §4: "Push: Expo Push").
 *
 * ## Why not `expo-server-sdk`
 *
 * PHASE2_PLAN §5 anticipated the SDK. It is MIT, maintained by Expo, and current
 * (7.2.0, September 2026), but the worker needs two POSTs and nothing else, and
 * the SDK would bring three runtime dependencies (`undici`, `promise-retry`,
 * `promise-limit`) for them — Node 22 already ships `fetch`. Doing it here also
 * keeps three properties the SDK does not give us:
 *
 * - **No push token in an error.** Expo's own error `message` quotes the token
 *   (`"ExponentPushToken[…]" is not a registered push notification recipient`),
 *   and `details.expoPushToken` repeats it. This client keeps only the error
 *   *code*, sanitised to an identifier; the message and details never leave it.
 * - **Retries belong to the queue.** The SDK retries 429s internally with its
 *   own back-off; here a retryable failure goes back to the database as
 *   `pending` with our back-off (`deliveryStatus.ts`), so it survives a restart.
 * - **The response is validated** at this trust boundary with zod, and tested
 *   through an injected `fetch` like every other external call in the worker.
 *
 * ## Enhanced push security
 *
 * With "enhanced push security" on in the Expo project, Expo refuses a send
 * without the project's access token, so a leaked device token alone cannot push
 * to anyone. `EXPO_ACCESS_TOKEN` is sent as `Authorization: Bearer …` when set,
 * and never logged (the logger redacts `authorization`, `accessToken`,
 * `EXPO_ACCESS_TOKEN`).
 */
import { z } from 'zod';

export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/** Expo: at most 100 messages per send request. */
export const MAX_MESSAGES_PER_REQUEST = 100;
/** Expo: at most 1000 ids per receipts request. */
export const MAX_RECEIPT_IDS_PER_REQUEST = 1000;

export const EXPO_REQUEST_TIMEOUT_MS = 15_000;

/** The error codes Expo documents on tickets and receipts. */
export const EXPO_ERROR_CODES = {
  DEVICE_NOT_REGISTERED: 'DeviceNotRegistered',
  MESSAGE_TOO_BIG: 'MessageTooBig',
  MESSAGE_RATE_EXCEEDED: 'MessageRateExceeded',
  MISMATCH_SENDER_ID: 'MismatchSenderId',
  INVALID_CREDENTIALS: 'InvalidCredentials',
} as const;

/** What we send. One recipient per message, so ticket `i` is delivery `i`. */
export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  /** Ids only (§5): what the app needs to open the right screen. */
  data: Record<string, string>;
  sound: 'default';
  priority: 'high';
  /** Android channel registered by the app (`apps/mobile/src/lib/push.ts`). */
  channelId?: string;
  /** APNs `apns-collapse-id`: a re-sent duplicate replaces the first (see `deliveryStatus.ts`). */
  collapseId?: string;
}

export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; errorCode: string }
  /** The ticket did not parse. Expo took the request, so the message may have gone. */
  | { status: 'unreadable' };

export type ExpoReceipt = { status: 'ok' } | { status: 'error'; errorCode: string };

/**
 * How a whole request failed.
 *
 * - `unavailable`: 429 or 5xx. Expo did not take it; retry later.
 * - `unauthorized`: 401/403 — `EXPO_ACCESS_TOKEN` missing or wrong under
 *   enhanced security. Every send fails until the operator fixes it; retried.
 * - `rejected`: any other 4xx. The request itself is wrong; retrying the same
 *   request gets the same answer.
 * - `ambiguous`: network error, timeout, or a 200 we cannot read. Expo may have
 *   accepted it. The caller decides; the push pipeline re-sends (at-least-once).
 */
export type ExpoFailureKind = 'unavailable' | 'unauthorized' | 'rejected' | 'ambiguous';

export class ExpoRequestError extends Error {
  readonly kind: ExpoFailureKind;
  /** HTTP status, when there was a response. */
  readonly status: number | null;
  /** Expo's request-level error code (`TOO_MANY_REQUESTS`, …), sanitised. */
  readonly code: string | null;

  constructor(kind: ExpoFailureKind, status: number | null, code: string | null) {
    // Static text only: nothing from the response body, nothing from the request.
    super(`Expo push request failed (${kind}${status === null ? '' : `, HTTP ${status}`})`);
    this.name = 'ExpoRequestError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * An Expo error code, made safe to store in `notification_deliveries.error` and
 * to log: an identifier of at most 64 characters, or a fixed placeholder. Expo is
 * a trusted service, but its response is still external text (§10).
 */
export function sanitizeExpoCode(value: unknown): string {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : 'UnrecognizedExpoError';
}

/** Ticket and receipt ids are UUIDs today; accept any short URL-safe id. */
const EXPO_ID = /^[A-Za-z0-9-]{1,128}$/;

const okTicket = z.object({ status: z.literal('ok'), id: z.string().regex(EXPO_ID) });
const errorShape = z.looseObject({
  status: z.literal('error'),
  // `message` and `details.expoPushToken` are ignored on purpose: both carry the token.
  details: z.looseObject({ error: z.unknown().optional() }).optional(),
});
const sendResponse = z.looseObject({ data: z.array(z.unknown()) });
const receiptsResponse = z.looseObject({ data: z.record(z.string(), z.unknown()) });
const okReceipt = z.looseObject({ status: z.literal('ok') });
const requestErrors = z.looseObject({
  errors: z.array(z.looseObject({ code: z.unknown().optional() })).min(1),
});

function readTicket(raw: unknown): ExpoTicket {
  const ok = okTicket.safeParse(raw);
  if (ok.success) return { status: 'ok', id: ok.data.id };
  const error = errorShape.safeParse(raw);
  if (error.success) {
    const code = error.data.details?.error;
    return {
      status: 'error',
      errorCode: code === undefined ? 'UnknownExpoError' : sanitizeExpoCode(code),
    };
  }
  return { status: 'unreadable' };
}

function readReceipt(raw: unknown): ExpoReceipt | null {
  if (okReceipt.safeParse(raw).success) return { status: 'ok' };
  const error = errorShape.safeParse(raw);
  if (error.success) {
    const code = error.data.details?.error;
    return {
      status: 'error',
      errorCode: code === undefined ? 'UnknownExpoError' : sanitizeExpoCode(code),
    };
  }
  return null;
}

export interface ExpoPushClient {
  /**
   * Send up to 100 messages. Resolves with one ticket per message, in order.
   * @throws ExpoRequestError when the request as a whole failed.
   */
  send(messages: readonly ExpoPushMessage[]): Promise<ExpoTicket[]>;
  /**
   * Receipts for up to 1000 ticket ids. An id absent from the map has no
   * receipt yet (or any more).
   * @throws ExpoRequestError when the request as a whole failed.
   */
  getReceipts(ticketIds: readonly string[]): Promise<Map<string, ExpoReceipt>>;
}

export interface ExpoClientOptions {
  /** `EXPO_ACCESS_TOKEN`. Never logged. */
  accessToken?: string | undefined;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function createExpoPushClient(options: ExpoClientOptions = {}): ExpoPushClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? EXPO_REQUEST_TIMEOUT_MS;

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (options.accessToken !== undefined) headers.authorization = `Bearer ${options.accessToken}`;

  async function post(url: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Network error or timeout: the request may have reached Expo.
      throw new ExpoRequestError('ambiguous', null, null);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ExpoRequestError(response.ok ? 'ambiguous' : 'unavailable', response.status, null);
    }

    let parsed: unknown;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const errors = requestErrors.safeParse(parsed);
      const code = errors.success ? sanitizeExpoCode(errors.data.errors[0]?.code) : null;
      const status = response.status;
      const kind: ExpoFailureKind =
        status === 429 || status >= 500
          ? 'unavailable'
          : status === 401 || status === 403
            ? 'unauthorized'
            : 'rejected';
      throw new ExpoRequestError(kind, status, code);
    }

    return parsed;
  }

  return {
    async send(messages) {
      if (messages.length === 0) return [];
      if (messages.length > MAX_MESSAGES_PER_REQUEST) {
        throw new RangeError(`at most ${MAX_MESSAGES_PER_REQUEST} messages per request`);
      }

      const parsed = sendResponse.safeParse(await post(EXPO_PUSH_SEND_URL, messages));
      // A 200 we cannot read, or one that does not answer every message: Expo
      // has taken the request, and we cannot tell which ticket is whose.
      if (!parsed.success || parsed.data.data.length !== messages.length) {
        throw new ExpoRequestError('ambiguous', 200, null);
      }
      return parsed.data.data.map(readTicket);
    },

    async getReceipts(ticketIds) {
      const receipts = new Map<string, ExpoReceipt>();
      if (ticketIds.length === 0) return receipts;
      if (ticketIds.length > MAX_RECEIPT_IDS_PER_REQUEST) {
        throw new RangeError(`at most ${MAX_RECEIPT_IDS_PER_REQUEST} receipt ids per request`);
      }

      const parsed = receiptsResponse.safeParse(
        await post(EXPO_PUSH_RECEIPTS_URL, { ids: ticketIds }),
      );
      if (!parsed.success) throw new ExpoRequestError('ambiguous', 200, null);

      // Only ids we asked about; anything else in the map is ignored.
      const asked = new Set(ticketIds);
      for (const [id, raw] of Object.entries(parsed.data.data)) {
        if (!asked.has(id)) continue;
        const receipt = readReceipt(raw);
        if (receipt !== null) receipts.set(id, receipt);
      }
      return receipts;
    },
  };
}
