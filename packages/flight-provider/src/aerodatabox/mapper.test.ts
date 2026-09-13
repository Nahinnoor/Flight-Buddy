import { flightCandidateSchema, type FlightStatus } from '@flightbuddy/shared';
import { describe, expect, it } from 'vitest';

import { ProviderDataError } from '../errors';
import { fixtureJson } from '../fixtures';
import { mapStatus, toFlightCandidate, toUtcIso } from './mapper';
import { flightListSchema, type AeroDataBoxFlight } from './schemas';

function legs(fixture: string): AeroDataBoxFlight[] {
  return flightListSchema.parse(fixtureJson(fixture));
}

function firstLeg(fixture: string): AeroDataBoxFlight {
  const [leg] = legs(fixture);
  if (leg === undefined) throw new Error(`fixture ${fixture} has no legs`);
  return leg;
}

describe('toUtcIso', () => {
  it("normalises the provider's space-separated form to ISO-8601 Z", () => {
    expect(toUtcIso('2026-09-12 01:59Z')).toBe('2026-09-12T01:59:00.000Z');
  });

  it('converts a local-with-offset string to the same instant in UTC', () => {
    expect(toUtcIso('2026-09-11 21:59-04:00')).toBe('2026-09-12T01:59:00.000Z');
  });

  it('returns null for missing or unusable values', () => {
    expect(toUtcIso(null)).toBeNull();
    expect(toUtcIso(undefined)).toBeNull();
    expect(toUtcIso('   ')).toBeNull();
    expect(toUtcIso('not a time')).toBeNull();
  });
});

describe('mapStatus', () => {
  const expected: Array<[string, FlightStatus]> = [
    ['Unknown', 'unknown'],
    ['Expected', 'scheduled'],
    ['CheckIn', 'scheduled'],
    ['Boarding', 'boarding'],
    ['GateClosed', 'boarding'],
    ['Departed', 'departed'],
    ['EnRoute', 'en_route'],
    ['Approaching', 'en_route'],
    ['Delayed', 'delayed'],
    ['Arrived', 'landed'],
    ['Canceled', 'cancelled'],
    ['CanceledUncertain', 'unknown'],
    ['Diverted', 'diverted'],
  ];

  it.each(expected)('maps %s to %s', (provider, domain) => {
    expect(mapStatus(provider)).toBe(domain);
  });

  it('degrades anything unrecognised to unknown rather than throwing', () => {
    expect(mapStatus('SomeNewStatusTheyAdded')).toBe('unknown');
    expect(mapStatus(null)).toBe('unknown');
    expect(mapStatus(undefined)).toBe('unknown');
  });
});

describe('toFlightCandidate', () => {
  it('maps a simple domestic flight', () => {
    const candidate = toFlightCandidate(firstLeg('flights-number-domestic-single'), 'AA1');

    expect(candidate).toMatchObject({
      marketingCarrierIata: 'AA',
      marketingFlightNumber: '1',
      operatingCarrierIata: 'AA',
      operatingFlightNumber: '1',
      departureDateLocal: '2026-09-15',
      originIata: 'JFK',
      originIcao: 'KJFK',
      originTz: 'America/New_York',
      destinationIata: 'LAX',
      destinationIcao: 'KLAX',
      destinationTz: 'America/Los_Angeles',
      status: 'scheduled',
      terminal: '8',
      gate: null,
      aircraftModel: 'Airbus A321',
      aircraftReg: null,
      scheduledDepartureUtc: '2026-09-15T12:29:00.000Z',
      scheduledArrivalUtc: '2026-09-15T18:24:00.000Z',
    });
    // No live updates yet, so nothing is estimated or actual.
    expect(candidate.estimatedDepartureUtc).toBeNull();
    expect(candidate.actualDepartureUtc).toBeNull();
    expect(candidate.actualArrivalUtc).toBeNull();
  });

  it('produces candidates the shared schema accepts', () => {
    for (const fixture of [
      'flights-number-domestic-single',
      'flights-number-codeshare-marketing',
      'flights-number-live-today',
      'flights-number-past-date',
    ]) {
      for (const leg of legs(fixture)) {
        expect(() => flightCandidateSchema.parse(toFlightCandidate(leg, 'DL1234'))).not.toThrow();
      }
    }
  });

  it('resolves a codeshare: marketing is what was typed, operating is what flies', () => {
    // The user typed DL9659; the provider answered with KL 1405 (§7.2).
    const candidate = toFlightCandidate(firstLeg('flights-number-codeshare-marketing'), 'DL9659');

    expect(candidate.marketingCarrierIata).toBe('DL');
    expect(candidate.marketingFlightNumber).toBe('9659');
    expect(candidate.operatingCarrierIata).toBe('KL');
    expect(candidate.operatingFlightNumber).toBe('1405');
    // Gate and terminal belong to the operating carrier (§7.2 rule 3).
    expect(candidate.gate).toBe('C16');
    expect(candidate.terminal).toBe('1');
    expect(candidate.originIata).toBe('AMS');
    expect(candidate.destinationIata).toBe('CDG');
  });

  it('leaves both pairs equal when the typed number is already the operator', () => {
    const candidate = toFlightCandidate(firstLeg('flights-number-live-today'), 'b6 1411');

    expect(candidate.marketingCarrierIata).toBe('B6');
    expect(candidate.marketingFlightNumber).toBe('1411');
    expect(candidate.operatingCarrierIata).toBe('B6');
    expect(candidate.operatingFlightNumber).toBe('1411');
  });

  it('takes departureDateLocal from the origin, not from UTC', () => {
    // JFK 21:59 on the 11th is already 01:59 on the 12th in UTC. Deriving the
    // date from the UTC instant would look the flight up on the wrong day.
    const candidate = toFlightCandidate(firstLeg('flights-number-live-today'), 'B61411');

    expect(candidate.scheduledDepartureUtc).toBe('2026-09-12T01:59:00.000Z');
    expect(candidate.departureDateLocal).toBe('2026-09-11');
  });

  it('reads actual times off a completed flight', () => {
    const candidate = toFlightCandidate(firstLeg('flights-number-past-date'), 'AA1');

    expect(candidate.status).toBe('landed');
    expect(candidate.scheduledDepartureUtc).toBe('2026-08-15T13:15:00.000Z');
    // revisedTime and runwayTime agree off the gate; runwayTime wins.
    expect(candidate.estimatedDepartureUtc).toBe('2026-08-15T14:14:00.000Z');
    expect(candidate.actualDepartureUtc).toBe('2026-08-15T14:14:00.000Z');
    // On arrival they differ: 19:20Z at the gate, 19:17Z on the runway.
    expect(candidate.estimatedArrivalUtc).toBe('2026-08-15T19:20:00.000Z');
    expect(candidate.actualArrivalUtc).toBe('2026-08-15T19:17:00.000Z');
    expect(candidate.aircraftReg).toBe('N109NN');
  });

  it('maps every leg of a multi-leg number independently', () => {
    const mapped = legs('flights-number-multileg').map((leg) => toFlightCandidate(leg, 'AS65'));

    expect(mapped).toHaveLength(5);
    expect(mapped.map((leg) => `${leg.originIata}-${leg.destinationIata}`)).toEqual([
      'SEA-KTN',
      'KTN-WRG',
      'WRG-PSG',
      'PSG-JNU',
      'JNU-ANC',
    ]);
    // Same number, same date, different origins: five distinct canonical keys.
    expect(new Set(mapped.map((leg) => leg.originIata)).size).toBe(5);
    for (const leg of mapped) {
      expect(leg.operatingCarrierIata).toBe('AS');
      expect(leg.operatingFlightNumber).toBe('65');
      expect(leg.departureDateLocal).toBe('2026-09-15');
    }
    // Alaska's milk run crosses two zones on one flight number.
    expect(mapped[0]?.originTz).toBe('America/Los_Angeles');
    expect(mapped[4]?.destinationTz).toBe('America/Anchorage');
  });

  it('rejects a leg it cannot key or display', () => {
    const base = firstLeg('flights-number-domestic-single');

    expect(() => toFlightCandidate(base, 'not a flight')).toThrow(ProviderDataError);
    expect(() =>
      toFlightCandidate({ ...base, departure: { airport: { name: 'Nowhere' } } }, 'AA1'),
    ).toThrow(ProviderDataError);
    expect(() =>
      toFlightCandidate(
        { ...base, arrival: { airport: { iata: 'LAX', name: 'Los Angeles' } } },
        'AA1',
      ),
    ).toThrow(/time zone/);
  });
});
