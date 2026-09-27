/**
 * The one channel from notification handling (root layout) to the Dashboard.
 *
 * On a cold start the tap is read before the Dashboard has mounted, so a
 * callback would have nobody to call; this is a tiny external store the screen
 * reads with `useSyncExternalStore` whenever it does mount. It holds ids only —
 * a flight id that has already been validated as a UUID — never notification
 * text.
 *
 * Relative imports only: vitest runs this file without the app's `@/` alias.
 */

export interface FlightAlertState {
  /** Bumped whenever the Dashboard should refetch (a flight alert arrived or was tapped). */
  refreshSeq: number;
  /** The flight a tap asked to bring into view, until the Dashboard has handled it. */
  highlight: { flightId: string; seq: number } | null;
}

const INITIAL: FlightAlertState = { refreshSeq: 0, highlight: null };

let state: FlightAlertState = INITIAL;
let seq = 0;
const listeners = new Set<() => void>();

function publish(next: FlightAlertState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeFlightAlerts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFlightAlertState(): FlightAlertState {
  return state;
}

/** A flight alert arrived while the app was open: reload what the Dashboard shows. */
export function requestDashboardRefresh(): void {
  publish({ ...state, refreshSeq: state.refreshSeq + 1 });
}

/**
 * A tap on a flight alert: the Dashboard reloads, then brings `flightId` into
 * view if it is shown. (The Dashboard does that reload itself, so it can decide
 * on fresh data; this does not also bump `refreshSeq`.)
 */
export function requestFlightHighlight(flightId: string): void {
  seq += 1;
  publish({ ...state, highlight: { flightId, seq } });
}

/** The Dashboard has dealt with highlight `handledSeq` (shown it, or found it absent). */
export function clearFlightHighlight(handledSeq: number): void {
  if (state.highlight?.seq !== handledSeq) return;
  publish({ ...state, highlight: null });
}

/** Signed out: nothing from the previous account may carry over. */
export function resetFlightAlerts(): void {
  if (state.highlight === null) return;
  publish({ ...state, highlight: null });
}
