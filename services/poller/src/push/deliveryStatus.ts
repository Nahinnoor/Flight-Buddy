/**
 * The `notification_deliveries.status` vocabulary and the numbers that drive it.
 *
 * The migration `20260926120000_push_delivery_lifecycle` pins the same list in a
 * check constraint and draws the state diagram. In short:
 *
 * ```
 * pending → sending → sent → delivered
 *              │        └──→ failed | unconfirmed | pending (MessageRateExceeded)
 *              ├──→ failed           (a definitive ticket or request error)
 *              └──→ pending          (retryable: 429, 5xx, network, timeout)
 * pending → skipped | expired
 * ```
 *
 * ## The crash window, and which way it fails
 *
 * Expo accepting a message and our write of the ticket are two systems, so they
 * cannot be atomic. The window is: the claim has committed the row as `sending`,
 * the request has left, and the process dies (or the request times out) before
 * the ticket is written. Expo may or may not have accepted it.
 *
 * We **re-send** — at-least-once — rather than drop. A `sending` row whose lease
 * has passed is claimed again until `MAX_SEND_ATTEMPTS`. For flight alerts the
 * two failures are not symmetric: a dropped gate change or cancellation can cost
 * someone the flight, while a duplicate costs one extra buzz. The duplicate is
 * also softened: every message carries `collapseId` = the flight event id, which
 * Expo passes to APNs as `apns-collapse-id`, so iOS replaces the first
 * notification with the second instead of stacking two.
 *
 * The window is small in practice: Render sends SIGTERM on deploy and pg-boss
 * stops gracefully (in-flight handlers finish, `queue.ts`), so a clean deploy
 * never lands in it. A crash or a timeout does.
 *
 * The unique key `(flight_event_id, user_id)` still makes a second *row* — and so
 * a second, independent send — structurally impossible (§9). What at-least-once
 * allows is the same row sent twice, never two rows.
 *
 * ## One person, several devices (ADR 0006, sub-step ii)
 *
 * A delivery is still one row per person. Its message goes to each of that
 * person's active devices (`push_tokens`, at most 10), and each device's outcome
 * is a `notification_device_sends` row (`deviceSends.ts`). A device with a row
 * other than `pending` is never sent to again for that delivery, so a re-claim
 * (crash, lease overrun, or a retry of one device) re-sends only to devices with
 * no recorded outcome — the crash window above shrinks to "Expo accepted, the
 * device row was not yet written", per request of at most 100 messages.
 *
 * **Parent status**, derived in SQL from the device rows each time it is written:
 *
 * 1. `pending` (with back-off) while some device's send failed retryably
 *    (429/5xx/401, network, timeout, MessageRateExceeded) and attempts remain —
 *    even if another device already got a ticket;
 * 2. otherwise the best device outcome: `delivered` > `sent` > `unconfirmed` >
 *    `failed`. So `sent` means "at least one device got a ticket", `delivered`
 *    "at least one device confirmed";
 * 3. with no device row at all: `skipped` / `NoPushToken` when the person had no
 *    active device, `expired`, or `failed` with our code (`UnbuildableMessage`,
 *    retries exhausted).
 *
 * `error` is NULL for `sent`/`delivered`; a `failed` parent carries our own code
 * when retries ran out, else the first failed device's code. The parent keeps one
 * representative ticket and token hash (its earliest `sent`/`delivered` device's).
 */

export const DELIVERY_STATUSES = [
  'pending',
  'sending',
  'sent',
  'delivered',
  'failed',
  'skipped',
  'expired',
  'unconfirmed',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Our own reason codes for `notification_deliveries.error`. Expo's error codes
 * (`DeviceNotRegistered`, …) are written as Expo sends them, after sanitising.
 */
export const DELIVERY_ERRORS = {
  /** The person had no active device (`push_tokens`) at send time. */
  NO_PUSH_TOKEN: 'NoPushToken',
  INVALID_PUSH_TOKEN: 'InvalidPushToken',
  EXPIRED: 'Expired',
  /** Retries ran out on 429 / 5xx / 401. */
  EXPO_UNAVAILABLE: 'ExpoUnavailable',
  /** Retries ran out on a request whose outcome we never learned. */
  SEND_OUTCOME_UNKNOWN: 'SendOutcomeUnknown',
  UNREADABLE_TICKET: 'UnreadableTicket',
  RECEIPT_UNAVAILABLE: 'ReceiptUnavailable',
  /** The message facts could not be read (flight or event row malformed). */
  UNBUILDABLE_MESSAGE: 'UnbuildableMessage',
} as const;

/** Claims per row before it is closed. Counted at claim time. */
export const MAX_SEND_ATTEMPTS = 6;

/** How long a claimed row is ours. Longer than one Expo request's timeout. */
export const SEND_LEASE_MS = 2 * 60_000;

/**
 * An event older than this is history, not news: a "gate B12" push three hours
 * late may point at a gate that has changed again since. Measured from the
 * event's `detected_at`. Covers the whole retry back-off (about 30 minutes).
 */
export const MAX_DELIVERY_AGE_MS = 3 * 60 * 60_000;

/**
 * Cancellations and diversions never become less true with time, and a
 * traveller never told their flight was cancelled is the worst failure this
 * system can have. So after an outage they are sent late rather than never —
 * up to two days, past which the trip is over either way.
 */
export const MAX_CRITICAL_DELIVERY_AGE_MS = 48 * 60 * 60_000;

/** Event types that get `MAX_CRITICAL_DELIVERY_AGE_MS` instead of the short window. */
export const CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set(['cancelled', 'diverted']);

/** How old an event may be and still be sent. */
export function maxDeliveryAgeMs(eventType: string): number {
  return CRITICAL_EVENT_TYPES.has(eventType) ? MAX_CRITICAL_DELIVERY_AGE_MS : MAX_DELIVERY_AGE_MS;
}

/** Expo: check receipts about 15 minutes after sending. */
export const RECEIPT_DELAY_MS = 15 * 60_000;

/** Expo clears receipts after 24 hours; past that there is nothing to fetch. */
export const RECEIPT_RETENTION_MS = 24 * 60 * 60_000;

/**
 * Back-off before the next claim of a row that failed retryably.
 * `attempts` is the count after this attempt: 1 → 1 min, 2 → 2, 3 → 4, 4 → 8,
 * then 15 min. Six attempts span roughly half an hour.
 */
export function retryDelayMs(attempts: number): number {
  const minutes = Math.min(2 ** Math.max(attempts - 1, 0), 15);
  return minutes * 60_000;
}
