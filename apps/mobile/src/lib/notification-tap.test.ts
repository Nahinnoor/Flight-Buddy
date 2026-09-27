import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_HREF,
  FLIGHT_EVENT_TYPES,
  highlightTargetFor,
  OPERATOR_ALERT_KINDS,
  parseNotificationData,
  refreshesDashboard,
  tapActionFor,
  type NotificationPayload,
  type TapState,
} from './notification-tap';
import { routeFor } from './route-guard';

const FLIGHT_ID = '3f2b8c1e-9d4a-4e7b-8a6c-1b2d3e4f5a6b';

describe('parseNotificationData', () => {
  it.each(FLIGHT_EVENT_TYPES)('accepts a flight alert with eventType %s', (eventType) => {
    expect(parseNotificationData({ flightId: FLIGHT_ID, eventType })).toEqual({
      kind: 'flight',
      flightId: FLIGHT_ID,
      eventType,
    });
  });

  it('normalises an upper-case uuid to lower case', () => {
    expect(parseNotificationData({ flightId: FLIGHT_ID.toUpperCase(), eventType: 'delay' })).toEqual({
      kind: 'flight',
      flightId: FLIGHT_ID,
      eventType: 'delay',
    });
  });

  it('ignores extra keys rather than using them', () => {
    const parsed = parseNotificationData({
      flightId: FLIGHT_ID,
      eventType: 'gate_change',
      url: 'flightbuddy://set-password',
      route: '/(auth)/set-password',
    });
    expect(parsed).toEqual({ kind: 'flight', flightId: FLIGHT_ID, eventType: 'gate_change' });
  });

  it.each([
    ['a non-uuid id', { flightId: 'not-a-uuid', eventType: 'delay' }],
    ['a path in the id', { flightId: `../${FLIGHT_ID}`, eventType: 'delay' }],
    ['a uuid with a suffix', { flightId: `${FLIGHT_ID}/settings`, eventType: 'delay' }],
    ['a uuid with a query', { flightId: `${FLIGHT_ID}?x=1`, eventType: 'delay' }],
    ['a uuid with whitespace', { flightId: ` ${FLIGHT_ID}`, eventType: 'delay' }],
    ['a numeric id', { flightId: 42, eventType: 'delay' }],
    ['an unknown event type', { flightId: FLIGHT_ID, eventType: 'boarding' }],
    ['an event type in the wrong case', { flightId: FLIGHT_ID, eventType: 'GATE_CHANGE' }],
    ['a missing event type', { flightId: FLIGHT_ID }],
    ['a missing flight id', { eventType: 'delay' }],
    ['an array', [FLIGHT_ID, 'delay']],
    ['a string', `${FLIGHT_ID}:delay`],
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
  ])('treats %s as unknown', (_label, data) => {
    expect(parseNotificationData(data)).toEqual({ kind: 'unknown' });
  });

  it('does not read inherited properties', () => {
    const data = Object.create({ flightId: FLIGHT_ID, eventType: 'delay' }) as object;
    expect(parseNotificationData(data)).toEqual({ kind: 'unknown' });
  });

  it.each(OPERATOR_ALERT_KINDS)('recognises the operator alert %s', (kind) => {
    expect(parseNotificationData({ kind })).toEqual({ kind: 'operator' });
  });

  it('treats an unknown operator kind as unknown', () => {
    expect(parseNotificationData({ kind: 'credit_refilled' })).toEqual({ kind: 'unknown' });
  });
});

describe('tapActionFor', () => {
  const flight: NotificationPayload = { kind: 'flight', flightId: FLIGHT_ID, eventType: 'gate_change' };
  const signedIn: TapState = {
    isLoading: false,
    signedIn: true,
    isRecovering: false,
    isDefaultAction: true,
    payload: flight,
  };

  it('opens the dashboard on the flight when signed in', () => {
    expect(tapActionFor(signedIn)).toEqual({ action: 'open-dashboard', flightId: FLIGHT_ID });
  });

  it('waits for the stored session on a cold start', () => {
    expect(tapActionFor({ ...signedIn, isLoading: true })).toEqual({ action: 'wait' });
    expect(tapActionFor({ ...signedIn, isLoading: true, signedIn: false })).toEqual({ action: 'wait' });
  });

  it('does nothing for a signed-out user, leaving the guard to show welcome', () => {
    expect(tapActionFor({ ...signedIn, signedIn: false })).toEqual({ action: 'none' });
  });

  it('does nothing mid password reset, so the tap cannot skip set-password', () => {
    expect(tapActionFor({ ...signedIn, isRecovering: true })).toEqual({ action: 'none' });
  });

  it('does nothing for a dismiss or a custom action', () => {
    expect(tapActionFor({ ...signedIn, isDefaultAction: false })).toEqual({ action: 'none' });
  });

  it('just opens the app for an operator alert or unknown data', () => {
    expect(tapActionFor({ ...signedIn, payload: { kind: 'operator' } })).toEqual({ action: 'none' });
    expect(tapActionFor({ ...signedIn, payload: { kind: 'unknown' } })).toEqual({ action: 'none' });
    // No reason to hold these for the session.
    expect(tapActionFor({ ...signedIn, isLoading: true, payload: { kind: 'unknown' } })).toEqual({
      action: 'none',
    });
  });

  it('only ever routes to the fixed dashboard href, which the guard allows signed in and refuses signed out', () => {
    expect(DASHBOARD_HREF).toBe('/');
    // Where '/' resolves: the dashboard is (app)/(tabs)/index.
    const dashboard = ['(app)', '(tabs)'];
    expect(routeFor({ isLoading: false, signedIn: true, isRecovering: false, segments: dashboard })).toBeNull();
    expect(routeFor({ isLoading: false, signedIn: false, isRecovering: false, segments: dashboard })).toBe(
      '/welcome',
    );
  });
});

describe('refreshesDashboard', () => {
  it('refreshes for a flight alert only', () => {
    expect(refreshesDashboard({ kind: 'flight', flightId: FLIGHT_ID, eventType: 'delay' })).toBe(true);
    expect(refreshesDashboard({ kind: 'operator' })).toBe(false);
    expect(refreshesDashboard({ kind: 'unknown' })).toBe(false);
  });
});

describe('highlightTargetFor', () => {
  const seg = (segmentId: string, flightId: string) => ({ segmentId, flight: { id: flightId } });
  const OTHER = '11111111-2222-4333-8444-555555555555';
  const THIRD = '99999999-8888-4777-8666-555555555555';

  it('points at the pinned card when it is that flight', () => {
    expect(highlightTargetFor(FLIGHT_ID, seg('s1', FLIGHT_ID), [seg('s2', OTHER)])).toEqual({
      where: 'main',
      segmentId: 's1',
    });
  });

  it('points at a later row when it is that flight', () => {
    expect(highlightTargetFor(OTHER, seg('s1', FLIGHT_ID), [seg('s2', THIRD), seg('s3', OTHER)])).toEqual({
      where: 'later',
      segmentId: 's3',
    });
  });

  it('compares ids case-insensitively', () => {
    expect(highlightTargetFor(FLIGHT_ID.toUpperCase(), seg('s1', FLIGHT_ID), [])).toEqual({
      where: 'main',
      segmentId: 's1',
    });
  });

  it('is null when the flight is not shown (archived, or not the user’s)', () => {
    expect(highlightTargetFor(THIRD, seg('s1', FLIGHT_ID), [seg('s2', OTHER)])).toBeNull();
    expect(highlightTargetFor(THIRD, null, [])).toBeNull();
  });

  it('is null with nothing to highlight', () => {
    expect(highlightTargetFor(null, seg('s1', FLIGHT_ID), [])).toBeNull();
  });
});
