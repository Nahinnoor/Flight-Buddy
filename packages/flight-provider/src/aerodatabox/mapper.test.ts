import { flightCandidateSchema, type FlightStatus } from '@flightbuddy/shared';
import { describe, expect, it } from 'vitest';

import { ProviderDataError } from '../errors';
import { fixtureJson } from '../fixtures';
import { countryCodeOrNull, greatCircleKm, mapStatus, toFlightCandidate, toUtcIso } from './mapper';
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

describe('greatCircleKm', () => {
  it("reads the lookup API's lowercase key and rounds to whole km", () => {
    expect(greatCircleKm({ meter: 3617691.31, km: 3617.69, mile: 2247.93 })).toBe(3618);
    expect(greatCircleKm({ km: 398.4 })).toBe(398);
  });

  it("reads the webhook serializer's PascalCase key", () => {
    expect(greatCircleKm({ Km: 3982.94, Mile: 2474.88 })).toBe(3983);
  });

  it('prefers the lowercase key when both casings are present', () => {
    expect(greatCircleKm({ km: 100.2, Km: 999 })).toBe(100);
  });

  it('accepts the boundaries 0 and 20100', () => {
    expect(greatCircleKm({ km: 0 })).toBe(0);
    expect(greatCircleKm({ km: 20100 })).toBe(20100);
  });

  it('turns every invalid value into null rather than throwing', () => {
    for (const bad of [
      undefined,
      null,
      42,
      'km',
      [],
      [3617.69],
      {},
      { mile: 2247.93 },
      { km: null },
      { km: '3617.69' },
      { km: Number.NaN },
      { Km: Number.NaN },
      { km: Number.POSITIVE_INFINITY },
      { km: Number.NEGATIVE_INFINITY },
      { km: -1 },
      { km: -0.4 },
      { Km: -5 },
      { km: 20100.01 },
      { km: 40075 },
      { km: 1e308 },
      { km: true },
      { km: { value: 1 } },
    ]) {
      expect(greatCircleKm(bad)).toBeNull();
    }
  });

  it('ignores an inherited key: only own properties count', () => {
    const inherited = Object.create({ km: 500 }) as object;
    expect(greatCircleKm(inherited)).toBeNull();
  });
});

describe('countryCodeOrNull', () => {
  it('uppercases a two-letter code', () => {
    expect(countryCodeOrNull('gb')).toBe('GB');
    expect(countryCodeOrNull('Us')).toBe('US');
    expect(countryCodeOrNull('NL')).toBe('NL');
  });

  it('rejects anything that is not exactly two ASCII letters', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'g',
      'gbr',
      'USA',
      ' gb',
      'gb ',
      'g1',
      '12',
      'é1',
      'ÄÖ',
      'g\n',
      "'; drop table flights; --",
    ]) {
      expect(countryCodeOrNull(bad)).toBeNull();
    }
  });
});

describe('toFlightCandidate: distance and countries', () => {
  it("carries the real lookup fixture's distance and countries", () => {
    const candidate = toFlightCandidate(firstLeg('flights-number-codeshare-marketing'), 'DL9659');
    expect(candidate.distanceKm).toBe(399);
    expect(candidate.originCountryCode).toBe('NL');
    expect(candidate.destinationCountryCode).toBe('FR');
  });

  it('maps every leg of a multi-leg number with its own distance', () => {
    const distances = legs('flights-number-multileg').map(
      (leg) => toFlightCandidate(leg, 'AS65').distanceKm,
    );
    expect(distances).toEqual([1094, 132, 50, 199, 919]);
  });

  it('uppercases a lowercase provider country code', () => {
    const leg = firstLeg('flights-number-live-today');
    const lowered: AeroDataBoxFlight = {
      ...leg,
      departure: { ...leg.departure, airport: { ...leg.departure?.airport, countryCode: 'gb' } },
      arrival: { ...leg.arrival, airport: { ...leg.arrival?.airport, countryCode: 'fr' } },
    };
    const candidate = toFlightCandidate(lowered, 'B61411');
    expect(candidate.originCountryCode).toBe('GB');
    expect(candidate.destinationCountryCode).toBe('FR');
  });

  it('reads the PascalCase distance a webhook item carries', () => {
    const leg = { ...firstLeg('flights-number-live-today'), greatCircleDistance: { Km: 3982.94 } };
    expect(toFlightCandidate(leg, 'B61411').distanceKm).toBe(3983);
  });

  it('degrades junk to null without losing the leg', () => {
    const leg = firstLeg('flights-number-live-today');
    const junk: AeroDataBoxFlight = {
      ...leg,
      greatCircleDistance: { km: -12 },
      departure: { ...leg.departure, airport: { ...leg.departure?.airport, countryCode: 'USA' } },
      arrival: { ...leg.arrival, airport: { ...leg.arrival?.airport, countryCode: null } },
    };
    const candidate = toFlightCandidate(junk, 'B61411');
    expect(candidate.distanceKm).toBeNull();
    expect(candidate.originCountryCode).toBeNull();
    expect(candidate.destinationCountryCode).toBeNull();
    expect(candidate.originIata).toBe('JFK');
    expect(() => flightCandidateSchema.parse(candidate)).not.toThrow();
  });

  it('sets the three fields to null, not absent, when the provider omits them', () => {
    const { greatCircleDistance: _gcd, ...leg } = firstLeg('flights-number-live-today');
    const bare: AeroDataBoxFlight = {
      ...leg,
      departure: {
        ...leg.departure,
        airport: { ...leg.departure?.airport, countryCode: undefined },
      },
    };
    const candidate = toFlightCandidate(bare, 'B61411');
    expect(candidate).toHaveProperty('distanceKm', null);
    expect(candidate).toHaveProperty('originCountryCode', null);
    expect(candidate.destinationCountryCode).toBe('US');
  });
});
