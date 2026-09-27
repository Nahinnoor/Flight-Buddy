/**
 * What a notification means to the app, as pure functions.
 *
 * A push's `data` is **untrusted input**. The worker sends exactly
 * `{ flightId, eventType }` for a flight alert (services/poller/src/push/
 * messages.ts) and `{ kind }` for an operator alert (push/operatorAlerts.ts),
 * but anyone holding a device's push token can send that device anything. So
 * nothing here trusts the shape: a flight id is accepted only if it is a UUID,
 * an event type only if it is one of the six the worker emits, and anything
 * else is treated as "just open the app". No value from `data` is ever
 * interpolated into a route: the only destination is the fixed Dashboard href,
 * and the flight id is only ever compared with ids the dashboard already
 * loaded under RLS.
 *
 * The routing decision follows the same rules as the route guard
 * (`route-guard.ts`): a tap never lets anyone past it. Signed out, the tap is
 * dropped and the guard's own redirect to the welcome screen stands.
 *
 * Relative imports only: vitest runs this file without the app's `@/` alias.
 */

/** The events that notify (§9), as the worker names them in `data.eventType`. */
export const FLIGHT_EVENT_TYPES = [
  'cancelled',
  'delay',
  'gate_change',
  'departed',
  'landed',
  'diverted',
] as const;
export type FlightEventType = (typeof FLIGHT_EVENT_TYPES)[number];

/** Operator (credit and push-health) alerts, sent to the owner's own phone. */
export const OPERATOR_ALERT_KINDS = [
  'credit_low',
  'credit_exhausted',
  'push_credentials_invalid',
  'push_unauthorized',
] as const;

export type NotificationPayload =
  | { kind: 'flight'; flightId: string; eventType: FlightEventType }
  | { kind: 'operator' }
  | { kind: 'unknown' };

/** Canonical 8-4-4-4-12 hex. Postgres prints uuids in lower case. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownString(record: object, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function isOneOf<T extends string>(value: string | null, allowed: readonly T[]): value is T {
  return value !== null && (allowed as readonly string[]).includes(value);
}

/**
 * Reads a notification's `content.data`. Only own string properties are
 * looked at; extra keys are ignored, never used.
 */
export function parseNotificationData(data: unknown): NotificationPayload {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { kind: 'unknown' };
  }

  const flightId = ownString(data, 'flightId');
  const eventType = ownString(data, 'eventType');
  if (flightId !== null && UUID.test(flightId) && isOneOf(eventType, FLIGHT_EVENT_TYPES)) {
    return { kind: 'flight', flightId: flightId.toLowerCase(), eventType };
  }

  if (isOneOf(ownString(data, 'kind'), OPERATOR_ALERT_KINDS)) return { kind: 'operator' };

  return { kind: 'unknown' };
}

/** The only place a tap may take anyone. A literal, never built from `data`. */
export const DASHBOARD_HREF = '/' as const;

export type TapAction =
  /** The stored session is still being read; decide once it is known. */
  | { action: 'wait' }
  /** Nothing to navigate to. The app is open, which is enough. */
  | { action: 'none' }
  /** Go to the Dashboard tab and bring this flight into view if it is there. */
  | { action: 'open-dashboard'; flightId: string };

export interface TapState {
  isLoading: boolean;
  signedIn: boolean;
  isRecovering: boolean;
  /** The response was a plain tap on the notification, not a dismiss or action. */
  isDefaultAction: boolean;
  payload: NotificationPayload;
}

/**
 * What to do with a tap.
 *
 * - Anything but a flight alert opens the app and goes nowhere in particular.
 * - A flight alert waits for the stored session, then goes to the Dashboard,
 *   but only for a signed-in user who is not mid password reset. Signed out,
 *   the root guard already sends them to the welcome screen; the tap is
 *   dropped rather than kept, so it cannot follow a *different* account's
 *   sign-in later.
 */
export function tapActionFor(state: TapState): TapAction {
  if (!state.isDefaultAction) return { action: 'none' };
  if (state.payload.kind !== 'flight') return { action: 'none' };
  if (state.isLoading) return { action: 'wait' };
  if (!state.signedIn || state.isRecovering) return { action: 'none' };
  return { action: 'open-dashboard', flightId: state.payload.flightId };
}

/** Whether a notification that arrives with the app open should refresh the dashboard. */
export function refreshesDashboard(payload: NotificationPayload): boolean {
  return payload.kind === 'flight';
}

export type HighlightTarget =
  | { where: 'main'; segmentId: string }
  | { where: 'later'; segmentId: string }
  | null;

interface ShownSegment {
  segmentId: string;
  flight: { id: string };
}

/**
 * Where the notified flight is on the dashboard, if it is there at all: the
 * pinned card, or one of the "Later flights" rows. Anything else — an archived
 * flight, a flight on someone else's trip, an id the dashboard never loaded —
 * is `null`, and the tap just leaves the user on the Dashboard.
 */
export function highlightTargetFor(
  flightId: string | null,
  main: ShownSegment | null,
  later: readonly ShownSegment[],
): HighlightTarget {
  if (flightId === null) return null;
  const wanted = flightId.toLowerCase();
  if (main !== null && main.flight.id.toLowerCase() === wanted) {
    return { where: 'main', segmentId: main.segmentId };
  }
  const row = later.find((segment) => segment.flight.id.toLowerCase() === wanted);
  return row === undefined ? null : { where: 'later', segmentId: row.segmentId };
}
