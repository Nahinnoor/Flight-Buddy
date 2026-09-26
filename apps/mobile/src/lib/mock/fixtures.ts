/**
 * Seed data for mock mode (`EXPO_PUBLIC_MOCK_API=1`): enough flights, groups
 * and a profile to render every section of the signed-in screens without a
 * database, relative to the moment the scenario is built.
 *
 * Three scenarios, switchable from Settings in a dev build running mock mode:
 *
 * - `full`: a flight in the air (pinned), later legs, and every kind of group
 *   card — named with a trip, a final-24-hours countdown, a blank name that
 *   falls back to its destination with no trip, a pending request, and an
 *   archived group that must not appear.
 * - `no-groups`: one upcoming flight, a pending-only membership, and more
 *   archived flights than the dashboard's preview shows, so the past-flights
 *   section and its "See all" link both render.
 * - `empty`: nothing at all — the empty dashboard.
 *
 * Flight numbers are synthetic-looking on purpose and carry no real itinerary.
 */
import type { MembershipView, SegmentView, FlightRow, LegTimes } from '../dashboard-model';

export type MockScenario = 'full' | 'no-groups' | 'empty';

export const MOCK_SCENARIOS: readonly MockScenario[] = ['full', 'no-groups', 'empty'];

export const MOCK_SCENARIO_LABELS: Record<MockScenario, string> = {
  full: 'Full',
  'no-groups': 'No groups',
  empty: 'Empty',
};

export interface MockProfile {
  displayName: string;
  email: string;
  quietHoursEnabled: boolean;
}

export interface MockData {
  segments: SegmentView[];
  past: SegmentView[];
  memberships: MembershipView[];
}

/** Deterministic, schema-valid v4-shaped UUID so responses parse like real ones. */
export function mockUuid(kind: number, index: number): string {
  return `00000000-0000-4000-8000-${(kind * 0x1000000 + index).toString(16).padStart(12, '0')}`;
}

const HOUR_MS = 3_600_000;

interface FlightSpec {
  index: number;
  carrier: string;
  number: string;
  origin: string;
  destination: string;
  originTz: string;
  destinationTz: string;
  /** Hours from now to scheduled departure; negative is in the past. */
  departsInHours: number;
  durationHours: number;
  status?: FlightRow['status'];
  tier?: FlightRow['tracking_tier'];
  gate?: string | null;
  terminal?: string | null;
  departed?: boolean;
  landed?: boolean;
  archived?: boolean;
}

function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant);
}

function flightRow(spec: FlightSpec, now: Date): FlightRow {
  const departure = new Date(now.getTime() + spec.departsInHours * HOUR_MS);
  const arrival = new Date(departure.getTime() + spec.durationHours * HOUR_MS);
  const iso = (date: Date) => date.toISOString();

  return {
    id: mockUuid(3, spec.index),
    operating_carrier_iata: spec.carrier,
    operating_flight_number: spec.number,
    departure_date_local: localDate(departure, spec.originTz),
    origin_iata: spec.origin,
    destination_iata: spec.destination,
    origin_tz: spec.originTz,
    destination_tz: spec.destinationTz,
    status: spec.status ?? 'scheduled',
    tracking_tier: spec.tier ?? 'live',
    gate: spec.gate ?? null,
    terminal: spec.terminal ?? null,
    scheduled_departure_utc: iso(departure),
    estimated_departure_utc: null,
    actual_departure_utc: spec.departed === true ? iso(departure) : null,
    scheduled_arrival_utc: iso(arrival),
    estimated_arrival_utc: null,
    actual_arrival_utc: spec.landed === true ? iso(arrival) : null,
    aircraft_reg: null,
    aircraft_model: null,
    next_poll_at: null,
    poll_lease_until: null,
    last_polled_at: null,
    poll_failure_count: 0,
    alert_subscription_id: null,
    alert_subscribed_at: null,
    raw_payload: null,
    archived_at: spec.archived === true ? iso(new Date(arrival.getTime() + HOUR_MS / 2)) : null,
    created_at: iso(now),
    updated_at: iso(now),
  };
}

function segment(
  spec: FlightSpec,
  trip: { id: string; label: string | null },
  sequenceNumber: number,
  now: Date,
): SegmentView {
  return {
    segmentId: mockUuid(2, spec.index),
    sequenceNumber,
    tripId: trip.id,
    tripLabel: trip.label,
    marketingCarrierIata: spec.carrier,
    marketingFlightNumber: spec.number,
    overrideNotes: null,
    flight: flightRow(spec, now),
  };
}

function legsOf(segments: readonly SegmentView[], tripId: string): LegTimes[] {
  return segments
    .filter((s) => s.tripId === tripId)
    .map((s) => ({
      sequenceNumber: s.sequenceNumber,
      scheduled_departure_utc: s.flight.scheduled_departure_utc,
      estimated_departure_utc: s.flight.estimated_departure_utc,
      actual_departure_utc: s.flight.actual_departure_utc,
      scheduled_arrival_utc: s.flight.scheduled_arrival_utc,
      estimated_arrival_utc: s.flight.estimated_arrival_utc,
      actual_arrival_utc: s.flight.actual_arrival_utc,
      status: s.flight.status,
      archived_at: s.flight.archived_at,
    }));
}

const NYC = 'America/New_York';
const PARIS = 'Europe/Paris';
const LISBON = 'Europe/Lisbon';
const TOKYO = 'Asia/Tokyo';
const LONDON = 'Europe/London';
const CHICAGO = 'America/Chicago';

function pastFlights(count: number, now: Date): SegmentView[] {
  const routes: [string, string, string, string, string, string][] = [
    ['ZB', '410', 'JFK', 'ORD', NYC, CHICAGO],
    ['ZB', '411', 'ORD', 'JFK', CHICAGO, NYC],
    ['ZC', '72', 'JFK', 'LHR', NYC, LONDON],
    ['ZC', '73', 'LHR', 'JFK', LONDON, NYC],
    ['ZD', '908', 'JFK', 'CDG', NYC, PARIS],
    ['ZD', '909', 'CDG', 'JFK', PARIS, NYC],
    ['ZB', '520', 'JFK', 'ORD', NYC, CHICAGO],
  ];
  return routes.slice(0, count).map(([carrier, number, origin, destination, originTz, destinationTz], i) =>
    segment(
      {
        index: 100 + i,
        carrier,
        number,
        origin,
        destination,
        originTz,
        destinationTz,
        departsInHours: -24 * (6 + i * 11),
        durationHours: 3,
        status: 'landed',
        departed: true,
        landed: true,
        archived: true,
      },
      { id: mockUuid(1, 100 + i), label: null },
      1,
      now,
    ),
  );
}

export function buildMockData(scenario: MockScenario, now: Date): MockData {
  if (scenario === 'empty') return { segments: [], past: [], memberships: [] };

  const pendingRequest: MembershipView = {
    membershipId: mockUuid(5, 4),
    status: 'pending',
    role: 'member',
    // A pending requester cannot read the group under RLS.
    group: null,
    tripId: null,
    legs: [],
  };

  if (scenario === 'no-groups') {
    const soloTrip = { id: mockUuid(1, 10), label: null };
    const segments = [
      segment(
        {
          index: 10,
          carrier: 'ZA',
          number: '233',
          origin: 'JFK',
          destination: 'CDG',
          originTz: NYC,
          destinationTz: PARIS,
          departsInHours: 30,
          durationHours: 7.25,
          terminal: '4',
        },
        soloTrip,
        1,
        now,
      ),
    ];
    return { segments, past: pastFlights(7, now), memberships: [pendingRequest] };
  }

  // ---- full ----
  const homeTrip = { id: mockUuid(1, 1), label: null };
  const lisbonTrip = { id: mockUuid(1, 2), label: 'Lisbon' };
  const tokyoTrip = { id: mockUuid(1, 3), label: null };
  const mexicoTrip = { id: mockUuid(1, 4), label: null };

  const inTheAir = segment(
    {
      index: 1,
      carrier: 'ZA',
      number: '11',
      origin: 'CDG',
      destination: 'JFK',
      originTz: PARIS,
      destinationTz: NYC,
      departsInHours: -2,
      durationHours: 8.5,
      status: 'en_route',
      departed: true,
      gate: 'K42',
      terminal: '2E',
    },
    homeTrip,
    1,
    now,
  );
  const tokyoLeg = segment(
    {
      index: 2,
      carrier: 'ZE',
      number: '9',
      origin: 'JFK',
      destination: 'HND',
      originTz: NYC,
      destinationTz: TOKYO,
      departsInHours: 20,
      durationHours: 14,
      terminal: '7',
    },
    tokyoTrip,
    1,
    now,
  );
  const lisbonOut = segment(
    {
      index: 3,
      carrier: 'ZF',
      number: '202',
      origin: 'JFK',
      destination: 'LIS',
      originTz: NYC,
      destinationTz: LISBON,
      departsInHours: 24 * 9 + 5,
      durationHours: 6.75,
      tier: 'scheduled',
    },
    lisbonTrip,
    1,
    now,
  );
  const lisbonOn = segment(
    {
      index: 4,
      carrier: 'ZF',
      number: '1944',
      origin: 'LIS',
      destination: 'OPO',
      originTz: LISBON,
      destinationTz: LISBON,
      departsInHours: 24 * 9 + 15,
      durationHours: 1,
      tier: 'scheduled',
    },
    lisbonTrip,
    2,
    now,
  );
  const segments = [inTheAir, tokyoLeg, lisbonOut, lisbonOn];

  const memberships: MembershipView[] = [
    {
      membershipId: mockUuid(5, 1),
      status: 'active',
      role: 'owner',
      group: { id: mockUuid(6, 1), name: 'Lisbon crew', destinationIata: 'LIS', archivedAt: null },
      tripId: lisbonTrip.id,
      legs: legsOf(segments, lisbonTrip.id),
    },
    {
      membershipId: mockUuid(5, 2),
      status: 'active',
      role: 'member',
      group: { id: mockUuid(6, 2), name: '  ', destinationIata: 'CDG', archivedAt: null },
      tripId: null,
      legs: [],
    },
    {
      membershipId: mockUuid(5, 3),
      status: 'active',
      role: 'member',
      group: { id: mockUuid(6, 3), name: 'Tokyo spring', destinationIata: 'HND', archivedAt: null },
      tripId: tokyoTrip.id,
      legs: legsOf(segments, tokyoTrip.id),
    },
    pendingRequest,
    {
      membershipId: mockUuid(5, 5),
      status: 'active',
      role: 'member',
      group: {
        id: mockUuid(6, 5),
        name: 'Mexico City 2025',
        destinationIata: 'MEX',
        archivedAt: new Date(now.getTime() - 60 * 24 * HOUR_MS).toISOString(),
      },
      tripId: mexicoTrip.id,
      legs: [],
    },
  ];

  return { segments, past: pastFlights(3, now), memberships };
}

export const MOCK_PROFILE: MockProfile = {
  displayName: 'Sam Rivera',
  email: 'sam@example.com',
  quietHoursEnabled: true,
};
