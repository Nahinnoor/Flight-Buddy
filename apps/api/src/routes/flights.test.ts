/**
 * The add-flight flow, end to end through `app.inject()` against the captured
 * AeroDataBox responses in `docs/api-samples/` (§12.2).
 *
 * The assertions that matter most are the invariants, not the status codes:
 * lookup returns *every* leg, the posted candidate is re-verified before it is
 * believed, `flights` is only ever reached through `ingestFlight` on the
 * service-role client, and the marketing number the user typed lands on the
 * segment and nowhere else.
 */
import {
  addFlightResponseSchema,
  apiErrorSchema,
  flightCandidateSchema,
  flightLookupResponseSchema,
  type FlightCandidate,
} from '@flightbuddy/shared';
import { describe, expect, it } from 'vitest';

import { AUTH_HEADERS, TEST_USER, buildTestApp, type TestApp } from '../testing/app';
import { FakeDatabase, touchedFlights } from '../testing/fakeSupabase';

/** Run a lookup and return the candidates the client would have been offered. */
async function lookup(
  harness: TestApp,
  payload: Record<string, unknown>,
): Promise<FlightCandidate[]> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/flights/lookup',
    headers: AUTH_HEADERS,
    payload,
  });
  expect(response.statusCode).toBe(200);
  return flightLookupResponseSchema.parse(response.json()).candidates;
}

describe('POST /v1/flights/lookup', () => {
  it('returns every leg of a multi-leg number, never just the first', async () => {
    const harness = buildTestApp({ fixture: 'flights-number-multileg' });

    const candidates = await lookup(harness, { flightNumber: 'AS65', dateLocal: '2026-09-15' });

    expect(candidates).toHaveLength(5);
    expect(candidates.map((leg) => leg.originIata)).toEqual(['SEA', 'KTN', 'WRG', 'PSG', 'JNU']);
  });

  it('accepts free text and resolves the date against the client time zone', async () => {
    const harness = buildTestApp({
      fixture: 'flights-number-codeshare-marketing',
      now: new Date('2026-09-11T23:00:00.000Z'),
    });

    await lookup(harness, { query: 'dl 9659 tomorrow', timeZone: 'Europe/Amsterdam' });

    // 23:00Z on the 11th is already the 12th in Amsterdam, so "tomorrow" is the
    // 13th there — the server's own date is never what decides this (§8.4).
    expect(harness.asked[0]).toContain('/flights/number/DL9659/2026-09-13');
  });

  it('400s when the free text is not a flight and a date', async () => {
    const harness = buildTestApp();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights/lookup',
      headers: AUTH_HEADERS,
      payload: { query: 'the red eye to Paris' },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('INVALID_QUERY');
    // The provider was never asked: a typo costs no quota (§12.1).
    expect(harness.asked).toEqual([]);
  });

  it('400s when the body matches neither accepted shape', async () => {
    const harness = buildTestApp();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights/lookup',
      headers: AUTH_HEADERS,
      payload: { flightNumber: 'DL9659', dateLocal: 'the twelfth' },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('VALIDATION_ERROR');
    expect(harness.asked).toEqual([]);
  });

  it('404s when the provider has no such flight', async () => {
    const harness = buildTestApp({
      fixture: 'flights-number-nonexistent-empty',
      provider: { status: 204 },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights/lookup',
      headers: AUTH_HEADERS,
      payload: { flightNumber: 'DL8517', dateLocal: '2026-09-15' },
    });

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('surfaces a provider rate limit as 429 with Retry-After', async () => {
    const harness = buildTestApp({
      fixture: 'flights-number-domestic-single',
      provider: { status: 429, retryAfterSeconds: 7 },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights/lookup',
      headers: AUTH_HEADERS,
      payload: { flightNumber: 'AA1', dateLocal: '2026-09-15' },
    });

    expect(response.statusCode).toBe(429);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('PROVIDER_RATE_LIMITED');
    expect(response.headers['retry-after']).toBe('7');
  });

  it('surfaces a provider failure as 502, not 500', async () => {
    const harness = buildTestApp({
      fixture: 'flights-number-domestic-single',
      provider: { status: 503 },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights/lookup',
      headers: AUTH_HEADERS,
      payload: { flightNumber: 'AA1', dateLocal: '2026-09-15' },
    });

    expect(response.statusCode).toBe(502);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('PROVIDER_ERROR');
  });
});

describe('POST /v1/flights', () => {
  /** The Delta-marketed KLM flight: the case the marketing/operating split exists for. */
  async function codeshareHarness(): Promise<{ harness: TestApp; candidate: FlightCandidate }> {
    const harness = buildTestApp({ fixture: 'flights-number-codeshare-marketing' });
    const candidates = await lookup(harness, {
      flightNumber: 'DL9659',
      dateLocal: '2026-09-12',
    });
    const candidate = candidates[0] as FlightCandidate;
    expect(candidate.marketingCarrierIata).toBe('DL');
    expect(candidate.operatingCarrierIata).toBe('KL');
    return { harness, candidate };
  }

  it('ingests the flight, creates the trip, and writes the segment', async () => {
    const { harness, candidate } = await codeshareHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      payload: { candidate },
    });

    expect(response.statusCode).toBe(200);
    const body = addFlightResponseSchema.parse(response.json());
    expect(body.sequenceNumber).toBe(1);

    // The trip hangs off the caller's own traveller, created on the way.
    const traveler = harness.db.rows('travelers')[0] as Record<string, unknown>;
    expect(traveler).toMatchObject({ user_id: TEST_USER.id, created_by: TEST_USER.id });
    expect(harness.db.rows('trips')).toEqual([
      expect.objectContaining({ id: body.tripId, traveler_id: traveler.id }),
    ]);

    // The segment carries what the USER typed — the Delta number — because
    // that is display data belonging to this traveller (§6.1, §7.2).
    expect(harness.db.rows('trip_segments')).toEqual([
      expect.objectContaining({
        id: body.segmentId,
        trip_id: body.tripId,
        flight_id: body.flightId,
        sequence_number: 1,
        marketing_carrier_iata: 'DL',
        marketing_flight_number: '9659',
      }),
    ]);
  });

  it('writes flights only through ingestFlight on the service-role client', async () => {
    const { harness, candidate } = await codeshareHarness();

    await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      payload: { candidate },
    });

    // §12.7: no request handler touches `flights`. The user client never sees
    // the table at all, and the service client sees nothing but that one upsert.
    expect(touchedFlights(harness.userCalls)).toBe(false);
    expect(harness.serviceCalls).toEqual([{ table: 'flights', op: 'upsert' }]);

    const flight = harness.db.rows('flights')[0] as Record<string, unknown>;
    // The canonical identity is the OPERATING flight (§7.2)...
    expect(flight).toMatchObject({
      operating_carrier_iata: 'KL',
      operating_flight_number: '1405',
      departure_date_local: '2026-09-12',
      origin_iata: 'AMS',
    });
    // ...and the user's marketing number is nowhere on the shared row.
    expect(flight.marketing_carrier_iata).toBeUndefined();
    expect(flight.marketing_flight_number).toBeUndefined();
    // Phase 2's scheduling column is not written by an add (§7.4).
    expect(flight.next_poll_at).toBeUndefined();
  });

  it('re-looks the candidate up by its operating number before believing it', async () => {
    const { harness, candidate } = await codeshareHarness();
    const askedBefore = harness.asked.length;

    // A client that edited the times on the way back gets the provider's.
    const forged: FlightCandidate = {
      ...candidate,
      scheduledDepartureUtc: '2026-09-12T23:59:00.000Z',
      gate: 'FORGED',
      status: 'cancelled',
    };

    await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      payload: { candidate: forged },
    });

    expect(harness.asked.slice(askedBefore).some((url) => url.includes('/flights/number/KL1405/2026-09-12'))).toBe(true);
    const flight = harness.db.rows('flights')[0] as Record<string, unknown>;
    expect(flight.scheduled_departure_utc).toBe(candidate.scheduledDepartureUtc);
    expect(flight.gate).toBe(candidate.gate);
    expect(flight.status).toBe(candidate.status);
  });

  it('400s CANDIDATE_MISMATCH when the provider no longer has that leg', async () => {
    const { harness, candidate } = await codeshareHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      // Same number and date, a leg the provider does not return.
      payload: { candidate: { ...candidate, originIata: 'JFK' } },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('CANDIDATE_MISMATCH');
    // Nothing was written: the mismatch is caught before the ingest.
    expect(harness.db.rows('flights')).toEqual([]);
    expect(harness.db.rows('trips')).toEqual([]);
    expect(harness.serviceCalls).toEqual([]);
  });

  it('400s when the posted candidate is not a candidate at all', async () => {
    const harness = buildTestApp({ fixture: 'flights-number-codeshare-marketing' });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      payload: { candidate: { operatingCarrierIata: 'KL' } },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('VALIDATION_ERROR');
    expect(harness.asked).toEqual([]);
  });

  it('appends a layover to an existing trip with the next sequence number', async () => {
    const harness = buildTestApp({ fixture: 'flights-number-multileg' });
    const legs = await lookup(harness, { flightNumber: 'AS65', dateLocal: '2026-09-15' });

    const first = addFlightResponseSchema.parse(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/v1/flights',
          headers: AUTH_HEADERS,
          payload: { candidate: legs[0] },
        })
      ).json(),
    );

    const second = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      payload: { candidate: legs[1], tripId: first.tripId },
    });

    expect(second.statusCode).toBe(200);
    const body = addFlightResponseSchema.parse(second.json());
    expect(body.tripId).toBe(first.tripId);
    expect(body.sequenceNumber).toBe(2);
    expect(harness.db.rows('trips')).toHaveLength(1);
    expect(harness.db.rows('trip_segments')).toHaveLength(2);
    // Two legs of one number on one date are two distinct flights (§6.2).
    expect(harness.db.rows('flights')).toHaveLength(2);
  });

  it('404s a tripId that is not this traveller’s', async () => {
    const db = new FakeDatabase();
    db.seed('trips', {
      id: '00000000-0000-4000-8000-00000000dead',
      traveler_id: '00000000-0000-4000-8000-00000000beef',
      label: null,
      created_at: '2026-09-01T00:00:00.000Z',
    });
    const harness = buildTestApp({ fixture: 'flights-number-codeshare-marketing', db });
    const candidates = await lookup(harness, { flightNumber: 'DL9659', dateLocal: '2026-09-12' });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      payload: { candidate: candidates[0], tripId: '00000000-0000-4000-8000-00000000dead' },
    });

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('TRIP_NOT_FOUND');
    expect(harness.db.rows('trip_segments')).toEqual([]);
  });

  it('discards a trip it created when the segment insert fails', async () => {
    const { harness, candidate } = await codeshareHarness();
    harness.db.failNextWrite('trip_segments', {
      code: '42501',
      message: 'new row violates row-level security policy',
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      payload: { candidate },
    });

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('DATABASE_ERROR');
    // No empty trip left on the dashboard.
    expect(harness.db.rows('trips')).toEqual([]);
    expect(harness.db.rows('trip_segments')).toEqual([]);
    // The ingest is an upsert on a shared fact, so it is fine for it to stand.
    expect(harness.db.rows('flights')).toHaveLength(1);
  });

  it('keeps an existing trip when the segment insert fails', async () => {
    const harness = buildTestApp({ fixture: 'flights-number-multileg' });
    const legs = await lookup(harness, { flightNumber: 'AS65', dateLocal: '2026-09-15' });
    const first = addFlightResponseSchema.parse(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/v1/flights',
          headers: AUTH_HEADERS,
          payload: { candidate: legs[0] },
        })
      ).json(),
    );

    harness.db.failNextWrite('trip_segments', { code: '42501', message: 'denied' });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      payload: { candidate: legs[1], tripId: first.tripId },
    });

    expect(response.statusCode).toBe(500);
    // The trip was not ours to delete: we did not create it in this request.
    expect(harness.db.rows('trips')).toHaveLength(1);
    expect(harness.db.rows('trip_segments')).toHaveLength(1);
  });

  it('recomputes sequence_number when a concurrent add takes it', async () => {
    const harness = buildTestApp({ fixture: 'flights-number-multileg' });
    const legs = await lookup(harness, { flightNumber: 'AS65', dateLocal: '2026-09-15' });
    const first = addFlightResponseSchema.parse(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/v1/flights',
          headers: AUTH_HEADERS,
          payload: { candidate: legs[0] },
        })
      ).json(),
    );

    // Somebody else's request grabbed sequence 2 between our read and our write.
    harness.db.failNextWrite(
      'trip_segments',
      { code: '23505', message: 'duplicate key value violates trip_segments_trip_id_sequence_number_key' },
      () => {
        harness.db.seed('trip_segments', {
          id: '00000000-0000-4000-8000-0000000000aa',
          trip_id: first.tripId,
          flight_id: first.flightId,
          sequence_number: 2,
          created_at: '2026-09-12T00:00:00.000Z',
        });
      },
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: AUTH_HEADERS,
      payload: { candidate: legs[1], tripId: first.tripId },
    });

    expect(response.statusCode).toBe(200);
    expect(addFlightResponseSchema.parse(response.json()).sequenceNumber).toBe(3);
  });
});

describe('the lookup response is the shared contract', () => {
  it('every candidate validates against flightCandidateSchema', async () => {
    const harness = buildTestApp({ fixture: 'flights-number-multileg' });

    const candidates = await lookup(harness, { flightNumber: 'as 65', dateLocal: '2026-09-15' });

    for (const candidate of candidates) {
      expect(() => flightCandidateSchema.parse(candidate)).not.toThrow();
    }
  });
});
