import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('flight-alert-store', () => {
  // Module state: a fresh copy per test.
  let store: typeof import('./flight-alert-store');
  beforeEach(async () => {
    vi.resetModules();
    store = await import('./flight-alert-store');
  });

  it('bumps refreshSeq for a foreground flight alert', () => {
    const listener = vi.fn();
    store.subscribeFlightAlerts(listener);
    store.requestDashboardRefresh();
    expect(store.getFlightAlertState().refreshSeq).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps a highlight until the dashboard clears that same request', () => {
    store.requestFlightHighlight('a');
    const first = store.getFlightAlertState().highlight;
    expect(first?.flightId).toBe('a');

    store.requestFlightHighlight('b');
    const second = store.getFlightAlertState().highlight;
    expect(second?.flightId).toBe('b');

    // Clearing the older request must not drop the newer one.
    store.clearFlightHighlight(first?.seq ?? -1);
    expect(store.getFlightAlertState().highlight?.flightId).toBe('b');

    store.clearFlightHighlight(second?.seq ?? -1);
    expect(store.getFlightAlertState().highlight).toBeNull();
  });

  it('survives until a dashboard mounts (a cold-start tap)', () => {
    store.requestFlightHighlight('a');
    // No subscriber yet; the state is still there to be read.
    expect(store.getFlightAlertState().highlight?.flightId).toBe('a');
  });

  it('forgets the highlight on sign-out', () => {
    store.requestFlightHighlight('a');
    store.resetFlightAlerts();
    expect(store.getFlightAlertState().highlight).toBeNull();
  });

  it('returns a stable snapshot between changes (useSyncExternalStore requirement)', () => {
    expect(store.getFlightAlertState()).toBe(store.getFlightAlertState());
    store.resetFlightAlerts(); // no-op with nothing to clear
    const before = store.getFlightAlertState();
    store.resetFlightAlerts();
    expect(store.getFlightAlertState()).toBe(before);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribeFlightAlerts(listener);
    unsubscribe();
    store.requestDashboardRefresh();
    expect(listener).not.toHaveBeenCalled();
  });
});
