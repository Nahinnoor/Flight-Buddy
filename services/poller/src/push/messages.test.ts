/**
 * The copy a user sees on the lock screen, for every §9 event type.
 */
import { describe, expect, it } from 'vitest';

import { buildPushCopy, formatDuration, type MessageFacts } from './messages';

/** DL 1915 JFK → LAX, departing 3:45 PM EDT on 2026-07-15. */
function facts(overrides: Partial<MessageFacts>): MessageFacts {
  return {
    eventType: 'gate_change',
    flightId: 'flight-1',
    previousValue: null,
    newValue: {},
    marketingCarrierIata: 'DL',
    marketingFlightNumber: '1915',
    operatingCarrierIata: 'DL',
    operatingFlightNumber: '1915',
    originIata: 'JFK',
    destinationIata: 'LAX',
    originTz: 'America/New_York',
    destinationTz: 'America/Los_Angeles',
    departureDateLocal: '2026-07-15',
    status: 'scheduled',
    scheduledDepartureUtc: '2026-07-15T19:45:00.000Z',
    estimatedDepartureUtc: null,
    scheduledArrivalUtc: '2026-07-16T02:05:00.000Z',
    estimatedArrivalUtc: null,
    ...overrides,
  };
}

describe('buildPushCopy', () => {
  it('cancelled', () => {
    expect(buildPushCopy(facts({ eventType: 'cancelled', status: 'cancelled' }))).toMatchObject({
      title: 'DL 1915 cancelled',
      body: 'JFK → LAX · was due to depart 3:45 PM EDT',
    });
  });

  it('delay, measured against the schedule', () => {
    const copy = buildPushCopy(
      facts({
        eventType: 'delay',
        newValue: {
          departureUtc: '2026-07-15T20:30:00.000Z',
          movedByMinutes: 45,
          delayMinutes: 45,
        },
      }),
    );
    expect(copy).toMatchObject({
      title: 'DL 1915 delayed 45 min',
      body: 'JFK → LAX · now departs 4:30 PM EDT',
    });
  });

  it('a delay past local midnight carries the date', () => {
    const copy = buildPushCopy(
      facts({
        eventType: 'delay',
        newValue: {
          departureUtc: '2026-07-16T04:15:00.000Z',
          movedByMinutes: 510,
          delayMinutes: 510,
        },
      }),
    );
    expect(copy).toMatchObject({
      title: 'DL 1915 delayed 8 h 30 min',
      body: 'JFK → LAX · now departs Jul 16, 12:15 AM EDT',
    });
  });

  it('gate change, with the old gate and the terminal', () => {
    const copy = buildPushCopy(
      facts({
        previousValue: { gate: 'B7', terminal: '4' },
        newValue: { gate: 'B12', terminal: '4' },
      }),
    );
    expect(copy).toMatchObject({
      title: 'DL 1915 gate change: B12',
      body: 'JFK → LAX · Terminal 4 · was B7 · departs 3:45 PM EDT',
    });
  });

  it('first gate assignment', () => {
    const copy = buildPushCopy(
      facts({ previousValue: { gate: null }, newValue: { gate: 'B12', terminal: null } }),
    );
    expect(copy.title).toBe('DL 1915 departs from gate B12');
  });

  it('departed', () => {
    const copy = buildPushCopy(
      facts({
        eventType: 'departed',
        status: 'departed',
        newValue: { status: 'departed', actualDepartureUtc: '2026-07-15T19:52:00.000Z' },
      }),
    );
    expect(copy).toMatchObject({
      title: 'DL 1915 departed JFK',
      body: 'JFK → LAX · took off 3:52 PM EDT · due 7:05 PM PDT',
    });
  });

  it('landed, in the destination’s zone', () => {
    const copy = buildPushCopy(
      facts({
        eventType: 'landed',
        status: 'landed',
        newValue: { status: 'landed', actualArrivalUtc: '2026-07-16T02:01:00.000Z' },
      }),
    );
    expect(copy).toMatchObject({
      title: 'DL 1915 landed at LAX',
      body: 'JFK → LAX · landed 7:01 PM PDT',
    });
  });

  it('diverted', () => {
    const copy = buildPushCopy(
      facts({
        eventType: 'diverted',
        status: 'diverted',
        newValue: { status: 'diverted', destinationIata: 'ONT' },
      }),
    );
    expect(copy).toMatchObject({ title: 'DL 1915 diverted', body: 'Now heading to ONT' });
  });

  it('uses the number the user added, and falls back to the operating one', () => {
    const codeshare = facts({
      operatingCarrierIata: 'KL',
      operatingFlightNumber: '1405',
      marketingFlightNumber: '9659',
    });
    expect(buildPushCopy(codeshare).title).toMatch(/^DL 9659 /);
    const none = facts({
      marketingCarrierIata: null,
      marketingFlightNumber: null,
      operatingCarrierIata: 'KL',
      operatingFlightNumber: '1405',
    });
    expect(buildPushCopy(none).title).toMatch(/^KL 1405 /);
  });

  it('prints nothing that fails its shape: a hostile gate never reaches the lock screen', () => {
    const copy = buildPushCopy(
      facts({
        newValue: { gate: 'Tap here: evil.example/login', terminal: '<b>' },
        previousValue: { gate: 'B7' },
      }),
    );
    expect(copy.title).toBe('DL 1915 gate change');
    expect(JSON.stringify(copy)).not.toContain('evil');
    expect(JSON.stringify(copy)).not.toContain('<b>');
  });

  it('the payload is ids only', () => {
    expect(buildPushCopy(facts({})).data).toEqual({
      flightId: 'flight-1',
      eventType: 'gate_change',
    });
  });

  it('survives an unknown time zone by leaving the time out', () => {
    const copy = buildPushCopy(facts({ eventType: 'cancelled', originTz: 'Not/AZone' }));
    expect(copy.body).toBe('JFK → LAX');
  });
});

describe('formatDuration', () => {
  it.each([
    [31, '31 min'],
    [60, '1 h'],
    [95, '1 h 35 min'],
  ])('%i → %s', (minutes, text) => {
    expect(formatDuration(minutes)).toBe(text);
  });
});
