import type { Database, FlightCandidate } from '@flightbuddy/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { FLIGHTS_CONFLICT_TARGET, FlightIngestError, ingestFlight } from './ingest';

type FlightRow = Database['public']['Tables']['flights']['Insert'];

interface RecordedUpsert {
  table: string;
  row: FlightRow;
  options: { onConflict?: string } | undefined;
  selected: string;
}

interface FakeResult {
  data?: { id: string } | null;
  error?: { message: string; code?: string; details?: string } | null;
}

/**
 * The narrowest fake that matches the call chain `ingestFlight` makes:
 * `.from(...).upsert(...).select(...).single()`.
 */
function fakeSupabase(result: FakeResult = { data: { id: 'flight-uuid-1' } }) {
  const upserts: RecordedUpsert[] = [];
  const client = {
    from(table: string) {
      return {
        upsert(row: FlightRow, options?: { onConflict?: string }) {
          return {
            select(selected: string) {
              upserts.push({ table, row, options, selected });
              return {
                async single() {
                  return { data: result.data ?? null, error: result.error ?? null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient<Database>;

  return { client, upserts };
}

const CANDIDATE: FlightCandidate = {
  marketingCarrierIata: 'DL',
  marketingFlightNumber: '9659',
  operatingCarrierIata: 'KL',
  operatingFlightNumber: '1405',
  departureDateLocal: '2026-09-12',
  originIata: 'AMS',
  destinationIata: 'CDG',
  originIcao: 'EHAM',
  destinationIcao: 'LFPG',
  originTz: 'Europe/Amsterdam',
  destinationTz: 'Europe/Paris',
  scheduledDepartureUtc: '2026-09-12T06:10:00.000Z',
  estimatedDepartureUtc: '2026-09-12T06:10:00.000Z',
  actualDepartureUtc: null,
  scheduledArrivalUtc: '2026-09-12T07:30:00.000Z',
  estimatedArrivalUtc: '2026-09-12T07:30:00.000Z',
  actualArrivalUtc: null,
  status: 'scheduled',
  trackingTier: 'live',
  gate: 'C16',
  terminal: '1',
  aircraftReg: 'PH-BCA',
  aircraftModel: 'Boeing 737',
};

const NOW = () => new Date('2026-09-12T01:00:00.000Z');

describe('ingestFlight', () => {
  it('upserts on the canonical key and returns the flight id', async () => {
    const { client, upserts } = fakeSupabase();

    const result = await ingestFlight(CANDIDATE, client, { now: NOW });

    expect(result).toEqual({ flightId: 'flight-uuid-1' });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.table).toBe('flights');
    expect(upserts[0]?.selected).toBe('id');
    expect(upserts[0]?.options?.onConflict).toBe(FLIGHTS_CONFLICT_TARGET);
    expect(FLIGHTS_CONFLICT_TARGET.split(',')).toEqual([
      'operating_carrier_iata',
      'operating_flight_number',
      'departure_date_local',
      'origin_iata',
    ]);
  });

  it('writes the operating identity, never the marketing number', async () => {
    const { client, upserts } = fakeSupabase();

    await ingestFlight(CANDIDATE, client, { now: NOW });

    const row = upserts[0]?.row;
    expect(row).toMatchObject({
      operating_carrier_iata: 'KL',
      operating_flight_number: '1405',
      departure_date_local: '2026-09-12',
      origin_iata: 'AMS',
      destination_iata: 'CDG',
      origin_tz: 'Europe/Amsterdam',
      destination_tz: 'Europe/Paris',
      status: 'scheduled',
      tracking_tier: 'live',
      gate: 'C16',
      terminal: '1',
      aircraft_reg: 'PH-BCA',
      aircraft_model: 'Boeing 737',
      scheduled_departure_utc: '2026-09-12T06:10:00.000Z',
      actual_departure_utc: null,
      updated_at: '2026-09-12T01:00:00.000Z',
    });
    // The marketing number belongs on trip_segments, never on the flight row.
    expect(JSON.stringify(row)).not.toContain('9659');
  });

  it('never touches scheduling, lease or webhook columns (Phase 2 owns them)', async () => {
    const { client, upserts } = fakeSupabase();

    await ingestFlight(CANDIDATE, client, { now: NOW });

    const columns = Object.keys(upserts[0]?.row ?? {});
    for (const forbidden of [
      'next_poll_at',
      'poll_lease_until',
      'last_polled_at',
      'poll_failure_count',
      'alert_subscription_id',
      'alert_subscribed_at',
      'archived_at',
      'created_at',
      'id',
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('stores the provider fields as raw_payload by default, or whatever is passed', async () => {
    const byDefault = fakeSupabase();
    await ingestFlight(CANDIDATE, byDefault.client, { now: NOW });
    const { marketingCarrierIata, marketingFlightNumber, ...providerFields } = CANDIDATE;
    expect(byDefault.upserts[0]?.row.raw_payload).toEqual(providerFields);
    expect(marketingCarrierIata).toBe('DL');
    expect(marketingFlightNumber).toBe('9659');

    const explicit = fakeSupabase();
    await ingestFlight(CANDIDATE, explicit.client, {
      now: NOW,
      rawPayload: { number: 'KL 1405', status: 'Expected' },
    });
    expect(explicit.upserts[0]?.row.raw_payload).toEqual({
      number: 'KL 1405',
      status: 'Expected',
    });
  });

  it('raises a typed error when Postgres refuses the write', async () => {
    const { client } = fakeSupabase({
      data: null,
      error: { message: 'permission denied for table flights', code: '42501' },
    });

    const error = await ingestFlight(CANDIDATE, client, { now: NOW }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlightIngestError);
    expect((error as FlightIngestError).code).toBe('42501');
    expect((error as FlightIngestError).message).toContain('KL1405');
  });

  it('raises when the upsert returns no row', async () => {
    const { client } = fakeSupabase({ data: null, error: null });
    await expect(ingestFlight(CANDIDATE, client, { now: NOW })).rejects.toBeInstanceOf(
      FlightIngestError,
    );
  });
});
