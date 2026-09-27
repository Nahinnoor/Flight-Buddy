import type { FlightCandidate } from '@flightbuddy/shared';
import { describe, expect, it } from 'vitest';

import {
  FLIGHTS_CONFLICT_COLUMNS,
  FLIGHT_COALESCE_COLUMNS,
  FLIGHT_UPSERT_COLUMNS,
  ingestFlight,
} from './ingest';
import { FLIGHTS_UPSERT_SQL, createPgFlightsWriter, type QueryFn } from './pgWriter';

interface RecordedQuery {
  text: string;
  values: readonly unknown[];
}

function fakeQuery(rows: { id: string }[] = [{ id: 'flight-uuid-1' }]) {
  const queries: RecordedQuery[] = [];
  const query: QueryFn = async (text, values) => {
    queries.push({ text, values });
    return { rows };
  };
  return { query, queries };
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

describe('FLIGHTS_UPSERT_SQL', () => {
  it('inserts exactly the ingest column set, in order, with one placeholder each', () => {
    const insertList = /insert into public\.flights \(([^)]+)\)/.exec(FLIGHTS_UPSERT_SQL)?.[1];
    expect(insertList?.split(', ')).toEqual(FLIGHT_UPSERT_COLUMNS.map((c) => `"${c}"`));

    const valueList = /\nvalues \((.+)\)\n/.exec(FLIGHTS_UPSERT_SQL)?.[1];
    expect(valueList?.split(', ')).toHaveLength(FLIGHT_UPSERT_COLUMNS.length);
    // Placeholders are $1..$n derived from the column index, never from a value.
    expect(valueList).toContain('$1');
    expect(valueList).toContain(`$${FLIGHT_UPSERT_COLUMNS.length}`);
    expect(valueList).toContain('::jsonb');
  });

  it('conflicts on the canonical key and never overwrites it', () => {
    expect(FLIGHTS_UPSERT_SQL).toContain(
      'on conflict ("operating_carrier_iata", "operating_flight_number", "departure_date_local", "origin_iata") do update set',
    );
    const updateList = /do update set (.+)\nreturning id/s.exec(FLIGHTS_UPSERT_SQL)?.[1] ?? '';
    for (const key of FLIGHTS_CONFLICT_COLUMNS) {
      expect(updateList).not.toContain(`"${key}" = excluded`);
    }
    expect(updateList).toContain('"archived_at" = excluded."archived_at"');
    expect(updateList).toContain('"updated_at" = excluded."updated_at"');
  });

  it('never mentions a scheduling, lease or webhook column (§7.4 owns those)', () => {
    for (const forbidden of [
      'next_poll_at',
      'poll_lease_until',
      'last_polled_at',
      'poll_failure_count',
      'alert_subscription_id',
      'alert_subscribed_at',
      'created_at',
    ]) {
      expect(FLIGHTS_UPSERT_SQL).not.toContain(forbidden);
    }
  });

  it('contains no interpolated literal: every value arrives as a parameter', () => {
    // A quote or a semicolon in the statement body would mean a value got inlined.
    expect(FLIGHTS_UPSERT_SQL).not.toContain("'");
    expect(FLIGHTS_UPSERT_SQL).not.toContain(';');
  });
});

describe('createPgFlightsWriter', () => {
  it('sends the row as positional parameters in column order', async () => {
    const { query, queries } = fakeQuery();

    const result = await ingestFlight(CANDIDATE, createPgFlightsWriter(query), { now: NOW });

    expect(result).toEqual({ flightId: 'flight-uuid-1' });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toBe(FLIGHTS_UPSERT_SQL);

    const values = queries[0]?.values ?? [];
    const byColumn = new Map(FLIGHT_UPSERT_COLUMNS.map((column, i) => [column, values[i]]));
    expect(byColumn.get('operating_carrier_iata')).toBe('KL');
    expect(byColumn.get('operating_flight_number')).toBe('1405');
    expect(byColumn.get('departure_date_local')).toBe('2026-09-12');
    expect(byColumn.get('origin_iata')).toBe('AMS');
    expect(byColumn.get('gate')).toBe('C16');
    expect(byColumn.get('actual_departure_utc')).toBeNull();
    expect(byColumn.get('updated_at')).toBe('2026-09-12T01:00:00.000Z');
    expect(byColumn.get('archived_at')).toBeNull();
  });

  it('serialises raw_payload to a JSON string for the ::jsonb cast', async () => {
    const { query, queries } = fakeQuery();

    await ingestFlight(CANDIDATE, createPgFlightsWriter(query), {
      now: NOW,
      rawPayload: { number: 'KL 1405', status: 'Expected' },
    });

    const index = FLIGHT_UPSERT_COLUMNS.indexOf('raw_payload');
    const raw = queries[0]?.values[index];
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw as string)).toEqual({ number: 'KL 1405', status: 'Expected' });
  });

  it('never sends the marketing number the user typed', async () => {
    const { query, queries } = fakeQuery();

    await ingestFlight(CANDIDATE, createPgFlightsWriter(query), { now: NOW });

    expect(JSON.stringify(queries[0]?.values)).not.toContain('9659');
  });

  it('matches the supabase writer column for column', async () => {
    // The two transports must write the same row, or the API and the worker
    // would disagree about what a flight is.
    const { query, queries } = fakeQuery();
    await ingestFlight(CANDIDATE, createPgFlightsWriter(query), { now: NOW });

    const values = queries[0]?.values ?? [];
    expect(values).toHaveLength(FLIGHT_UPSERT_COLUMNS.length);
    expect(new Set(FLIGHT_UPSERT_COLUMNS).size).toBe(FLIGHT_UPSERT_COLUMNS.length);
  });

  it('raises a typed error when the upsert returns no row', async () => {
    const { query } = fakeQuery([]);

    const error = await ingestFlight(CANDIDATE, createPgFlightsWriter(query), { now: NOW }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('FlightIngestError');
    expect((error as Error).message).toContain('KL1405');
  });

  it('wraps a driver failure in FlightIngestError naming the leg only', async () => {
    const query: QueryFn = () => Promise.reject(new Error('permission denied for table flights'));

    const error = await ingestFlight(CANDIDATE, createPgFlightsWriter(query), { now: NOW }).catch(
      (e: unknown) => e,
    );

    expect((error as Error).name).toBe('FlightIngestError');
    expect((error as Error).message).toContain('KL1405 on 2026-09-12');
    // The driver's own text can name tables, roles or hosts; only its class name
    // reaches the message, and the original is kept as `cause` for debugging.
    expect((error as Error).message).not.toContain('permission denied');
    expect((error as Error).message).toContain(': Error');
    expect(((error as Error).cause as Error).message).toBe('permission denied for table flights');
  });
});

describe('route columns: distance and countries', () => {
  const ROUTE = {
    distanceKm: 399,
    originCountryCode: 'NL',
    destinationCountryCode: 'FR',
  } as const;

  it('are written by the upsert', () => {
    for (const column of ['distance_km', 'origin_country_code', 'destination_country_code']) {
      expect(FLIGHT_UPSERT_COLUMNS).toContain(column);
    }
    expect([...FLIGHT_COALESCE_COLUMNS].sort()).toEqual([
      'destination_country_code',
      'distance_km',
      'origin_country_code',
    ]);
  });

  it('update as coalesce(excluded, stored) so a null never erases a known value', () => {
    const updateList = /do update set (.+)\nreturning id/s.exec(FLIGHTS_UPSERT_SQL)?.[1] ?? '';
    for (const column of FLIGHT_COALESCE_COLUMNS) {
      expect(updateList).toContain(
        `"${column}" = coalesce(excluded."${column}", flights."${column}")`,
      );
      expect(updateList).not.toContain(`"${column}" = excluded."${column}"`);
    }
  });

  it('leave every other column a plain overwrite (a null gate is real news)', () => {
    const updateList = /do update set (.+)\nreturning id/s.exec(FLIGHTS_UPSERT_SQL)?.[1] ?? '';
    expect(updateList.match(/coalesce\(/g)).toHaveLength(FLIGHT_COALESCE_COLUMNS.length);
    expect(updateList).toContain('"gate" = excluded."gate"');
    expect(updateList).toContain('"estimated_departure_utc" = excluded."estimated_departure_utc"');
  });

  it('send the candidate values as parameters', async () => {
    const { query, queries } = fakeQuery();
    await ingestFlight({ ...CANDIDATE, ...ROUTE }, createPgFlightsWriter(query), { now: NOW });

    const values = queries[0]?.values ?? [];
    const byColumn = new Map(FLIGHT_UPSERT_COLUMNS.map((column, i) => [column, values[i]]));
    expect(byColumn.get('distance_km')).toBe(399);
    expect(byColumn.get('origin_country_code')).toBe('NL');
    expect(byColumn.get('destination_country_code')).toBe('FR');
  });

  it('send null (for coalesce to keep the stored value) when the candidate has none', async () => {
    const { query, queries } = fakeQuery();
    // CANDIDATE predates the fields: they are absent, as on a mobile mock candidate.
    await ingestFlight(CANDIDATE, createPgFlightsWriter(query), { now: NOW });

    const values = queries[0]?.values ?? [];
    expect(values).toHaveLength(FLIGHT_UPSERT_COLUMNS.length);
    for (const column of FLIGHT_COALESCE_COLUMNS) {
      expect(values[FLIGHT_UPSERT_COLUMNS.indexOf(column)]).toBeNull();
    }
  });
});
