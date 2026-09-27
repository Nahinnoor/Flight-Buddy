import { describe, expect, it } from 'vitest';

import {
  addFlightRequestSchema,
  addFlightResponseSchema,
  flightCandidateSchema,
  flightLookupRequestSchema,
  flightLookupSchema,
  flightQueryInputSchema,
  flightStatusSchema,
  trackingTierSchema,
} from './schemas';
import { MAX_GREAT_CIRCLE_KM, type FlightCandidate } from './types';

/** The §7.2 codeshare example: DL 8517 sold, AF 3612 operated. */
const candidate: FlightCandidate = {
  marketingCarrierIata: 'DL',
  marketingFlightNumber: '8517',
  operatingCarrierIata: 'AF',
  operatingFlightNumber: '3612',
  departureDateLocal: '2026-07-15',
  originIata: 'ATL',
  destinationIata: 'CDG',
  originIcao: 'KATL',
  destinationIcao: 'LFPG',
  originTz: 'America/New_York',
  destinationTz: 'Europe/Paris',
  originName: 'Hartsfield-Jackson Atlanta International',
  destinationName: 'Paris Charles de Gaulle',
  scheduledDepartureUtc: '2026-07-15T19:45:00Z',
  estimatedDepartureUtc: '2026-07-15T20:05:00Z',
  actualDepartureUtc: null,
  scheduledArrivalUtc: '2026-07-16T07:55:00Z',
  estimatedArrivalUtc: null,
  actualArrivalUtc: null,
  status: 'scheduled',
  trackingTier: 'live',
  gate: 'E12',
  terminal: 'I',
  aircraftReg: 'F-GSQJ',
  aircraftModel: 'Boeing 777-300ER',
};

describe('flightCandidateSchema', () => {
  it('accepts a fully populated candidate', () => {
    expect(flightCandidateSchema.parse(candidate)).toEqual(candidate);
  });

  it('accepts a sparse candidate with unknown times', () => {
    const sparse: FlightCandidate = {
      ...candidate,
      scheduledDepartureUtc: null,
      estimatedDepartureUtc: null,
      scheduledArrivalUtc: null,
      gate: null,
      terminal: null,
      aircraftReg: null,
      aircraftModel: null,
      trackingTier: 'manual',
      status: 'unknown',
    };
    delete (sparse as Partial<FlightCandidate>).originIcao;
    delete (sparse as Partial<FlightCandidate>).destinationIcao;
    expect(flightCandidateSchema.parse(sparse)).toMatchObject({ trackingTier: 'manual' });
  });

  it('rejects a local departure date that is really a timestamp', () => {
    expect(
      flightCandidateSchema.safeParse({ ...candidate, departureDateLocal: '2026-07-15T19:45:00Z' })
        .success,
    ).toBe(false);
  });

  it('rejects a non-UTC timestamp', () => {
    expect(
      flightCandidateSchema.safeParse({
        ...candidate,
        scheduledDepartureUtc: '2026-07-15T15:45:00-04:00',
      }).success,
    ).toBe(false);
  });

  it('rejects a time zone ICU does not know', () => {
    expect(flightCandidateSchema.safeParse({ ...candidate, originTz: 'EDT' }).success).toBe(false);
  });

  it('rejects lowercase and malformed codes', () => {
    expect(flightCandidateSchema.safeParse({ ...candidate, originIata: 'atl' }).success).toBe(
      false,
    );
    expect(
      flightCandidateSchema.safeParse({ ...candidate, marketingCarrierIata: 'DAL' }).success,
    ).toBe(false);
  });
});

describe('flightCandidateSchema: distance and countries', () => {
  it('accepts them present, null, or absent', () => {
    const route = { distanceKm: 3618, originCountryCode: 'US', destinationCountryCode: 'GB' };
    expect(flightCandidateSchema.parse({ ...candidate, ...route })).toMatchObject(route);
    expect(() =>
      flightCandidateSchema.parse({
        ...candidate,
        distanceKm: null,
        originCountryCode: null,
        destinationCountryCode: null,
      }),
    ).not.toThrow();
    expect(() => flightCandidateSchema.parse(candidate)).not.toThrow();
    expect(() => flightCandidateSchema.parse({ ...candidate, distanceKm: 0 })).not.toThrow();
    expect(() =>
      flightCandidateSchema.parse({ ...candidate, distanceKm: MAX_GREAT_CIRCLE_KM }),
    ).not.toThrow();
  });

  it('rejects an impossible distance or a malformed country code', () => {
    for (const bad of [
      { distanceKm: -1 },
      { distanceKm: MAX_GREAT_CIRCLE_KM + 1 },
      { distanceKm: 12.5 },
      { distanceKm: Number.NaN },
      { distanceKm: '3618' },
      { originCountryCode: 'gb' },
      { originCountryCode: 'GBR' },
      { destinationCountryCode: 'G' },
      { destinationCountryCode: '12' },
    ]) {
      expect(flightCandidateSchema.safeParse({ ...candidate, ...bad }).success).toBe(false);
    }
  });
});

describe('enums', () => {
  it('mirrors the Postgres enums', () => {
    expect(trackingTierSchema.parse('scheduled')).toBe('scheduled');
    expect(flightStatusSchema.parse('en_route')).toBe('en_route');
    expect(flightStatusSchema.safeParse('enroute').success).toBe(false);
  });
});

describe('flight query and lookup', () => {
  it('accepts free text with the device date and zone', () => {
    expect(
      flightQueryInputSchema.parse({
        query: '  DL1234 tomorrow ',
        today: '2026-07-15',
        timeZone: 'America/New_York',
      }),
    ).toEqual({ query: 'DL1234 tomorrow', today: '2026-07-15', timeZone: 'America/New_York' });
  });

  it('accepts either lookup body shape', () => {
    expect(flightLookupRequestSchema.safeParse({ query: 'DL1234 Mar 12' }).success).toBe(true);
    expect(
      flightLookupRequestSchema.safeParse({ flightNumber: 'DL1234', dateLocal: '2026-03-12' })
        .success,
    ).toBe(true);
    expect(
      flightLookupRequestSchema.safeParse({ flightNumber: 'DL1234', dateLocal: 'Mar 12' }).success,
    ).toBe(false);
  });

  it('accepts a parsed lookup', () => {
    expect(
      flightLookupSchema.parse({
        carrierIata: 'DL',
        flightNumber: '1234',
        departureDateLocal: '2026-03-12',
      }),
    ).toMatchObject({ carrierIata: 'DL' });
  });
});

describe('addFlightRequestSchema', () => {
  const tripId = '0f1b6b2e-6b2a-4c1f-9f3a-2f7c9a1b4d55';

  it('accepts the candidate the user picked', () => {
    expect(addFlightRequestSchema.parse({ candidate })).toEqual({ candidate });
  });

  it('accepts an append to an existing trip', () => {
    expect(addFlightRequestSchema.parse({ candidate, tripId }).tripId).toBe(tripId);
  });

  it('accepts a manual-tier candidate with user-supplied times', () => {
    const manual = { ...candidate, trackingTier: 'manual' as const, gate: null, terminal: null };
    expect(addFlightRequestSchema.parse({ candidate: manual }).candidate.trackingTier).toBe(
      'manual',
    );
  });

  it('rejects a forged candidate and a bad trip id', () => {
    expect(
      addFlightRequestSchema.safeParse({ candidate: { ...candidate, originIata: 'ATLANTA' } })
        .success,
    ).toBe(false);
    expect(addFlightRequestSchema.safeParse({ candidate, tripId: 'nope' }).success).toBe(false);
  });

  it('describes the add response', () => {
    expect(
      addFlightResponseSchema.safeParse({
        tripId,
        segmentId: tripId,
        flightId: tripId,
        sequenceNumber: 1,
      }).success,
    ).toBe(true);
  });
});
