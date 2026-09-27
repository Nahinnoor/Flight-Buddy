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
 * - `empty`: nothing at all — the empty dashboard, and every empty state on
 *   Profile (no flights taken, level 1, no group trips).
 *
 * `full` also carries a Profile's worth of history: twenty landed flights
 * across six countries (one old row with no distance or country, as rows from
 * before those columns existed are), a mix of early, on-time, delayed and
 * diverted arrivals, and three group trips this year with made-up members
 * chosen so every "flying with friends" row renders — including an
 * unclaimed traveller, a member whose flight was cancelled, one who landed
 * at another airport, and one who landed more than 12 hours later. The group
 * trips sit 10–75 days before now, so from January to mid-March some of them
 * fall in last year and the section shows fewer (or its empty state).
 *
 * Flight numbers are synthetic-looking on purpose and carry no real itinerary.
 */
import type { MembershipView, SegmentView, FlightRow, LegTimes } from '../dashboard-model';
import type { GroupMemberTrip, GroupTripInput } from '../profile-stats';

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
  createdAt: string;
}

export interface MockData {
  segments: SegmentView[];
  past: SegmentView[];
  memberships: MembershipView[];
  groupTrips: GroupTripInput[];
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
  /** Minutes the actual times ran behind schedule; negative is early. */
  lateMin?: number;
  distanceKm?: number | null;
  originCountry?: string | null;
  destinationCountry?: string | null;
}

function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant);
}

function flightRow(spec: FlightSpec, now: Date): FlightRow {
  const departure = new Date(now.getTime() + spec.departsInHours * HOUR_MS);
  const arrival = new Date(departure.getTime() + spec.durationHours * HOUR_MS);
  const iso = (date: Date) => date.toISOString();
  const late = (date: Date) => new Date(date.getTime() + (spec.lateMin ?? 0) * 60_000);

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
    actual_departure_utc: spec.departed === true ? iso(late(departure)) : null,
    scheduled_arrival_utc: iso(arrival),
    estimated_arrival_utc: null,
    actual_arrival_utc: spec.landed === true ? iso(late(arrival)) : null,
    aircraft_reg: null,
    aircraft_model: null,
    next_poll_at: null,
    poll_lease_until: null,
    last_polled_at: null,
    poll_failure_count: 0,
    alert_subscription_id: null,
    alert_subscribed_at: null,
    raw_payload: null,
    distance_km: spec.distanceKm ?? null,
    origin_country_code: spec.originCountry ?? null,
    destination_country_code: spec.destinationCountry ?? null,
    archived_at: spec.archived === true ? iso(new Date(late(arrival).getTime() + HOUR_MS / 2)) : null,
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
const LOS_ANGELES = 'America/Los_Angeles';
const MEXICO_CITY = 'America/Mexico_City';

const COUNTRY: Record<string, string> = {
  JFK: 'US', ORD: 'US', LAX: 'US', SFO: 'US', BOS: 'US', MIA: 'US',
  LHR: 'GB', CDG: 'FR', LIS: 'PT', OPO: 'PT', HND: 'JP', NRT: 'JP', MEX: 'MX',
};

function pastFlights(count: number, now: Date): SegmentView[] {
  const routes: [string, string, string, string, string, string, number][] = [
    ['ZB', '410', 'JFK', 'ORD', NYC, CHICAGO, 1188],
    ['ZB', '411', 'ORD', 'JFK', CHICAGO, NYC, 1188],
    ['ZC', '72', 'JFK', 'LHR', NYC, LONDON, 5540],
    ['ZC', '73', 'LHR', 'JFK', LONDON, NYC, 5540],
    ['ZD', '908', 'JFK', 'CDG', NYC, PARIS, 5837],
    ['ZD', '909', 'CDG', 'JFK', PARIS, NYC, 5837],
    ['ZB', '520', 'JFK', 'ORD', NYC, CHICAGO, 1188],
  ];
  return routes.slice(0, count).map(([carrier, number, origin, destination, originTz, destinationTz, km], i) =>
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
        distanceKm: km,
        originCountry: COUNTRY[origin] ?? null,
        destinationCountry: COUNTRY[destination] ?? null,
      },
      { id: mockUuid(1, 100 + i), label: null },
      1,
      now,
    ),
  );
}

export function buildMockData(scenario: MockScenario, now: Date): MockData {
  if (scenario === 'empty') return { segments: [], past: [], memberships: [], groupTrips: [] };

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
    return { segments, past: pastFlights(7, now), memberships: [pendingRequest], groupTrips: [] };
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

  const profileHistory = history(now);
  return { segments, past: profileHistory.flights, memberships, groupTrips: profileHistory.groupTrips };
}

// ------------------------------------------------------ profile history ---

interface HistorySpec {
  carrier: string;
  number: string;
  origin: string;
  destination: string;
  originTz: string;
  destinationTz: string;
  durationHours: number;
  km: number | null;
  /** Hours before now that it landed. */
  landedHoursAgo: number;
  lateMin?: number;
  status?: FlightRow['status'];
}

/** The three group trips: when you landed, relative to now. */
const LA_LANDED = 10 * 24;
const LISBON_LANDED = 40 * 24;
const TOKYO_LANDED = 75 * 24;

const HISTORY: readonly HistorySpec[] = [
  { carrier: 'ZG', number: '1915', origin: 'JFK', destination: 'LAX', originTz: NYC, destinationTz: LOS_ANGELES, durationHours: 6, km: 3983, landedHoursAgo: LA_LANDED, lateMin: -12 },
  { carrier: 'ZG', number: '1916', origin: 'LAX', destination: 'JFK', originTz: LOS_ANGELES, destinationTz: NYC, durationHours: 5.3, km: 3983, landedHoursAgo: LA_LANDED - 70 },
  { carrier: 'ZF', number: '201', origin: 'JFK', destination: 'LIS', originTz: NYC, destinationTz: LISBON, durationHours: 6.75, km: 5418, landedHoursAgo: LISBON_LANDED, lateMin: 3 },
  { carrier: 'ZF', number: '1944', origin: 'LIS', destination: 'OPO', originTz: LISBON, destinationTz: LISBON, durationHours: 1, km: 274, landedHoursAgo: LISBON_LANDED - 50, lateMin: 25 },
  { carrier: 'ZF', number: '208', origin: 'OPO', destination: 'JFK', originTz: LISBON, destinationTz: NYC, durationHours: 8, km: 5300, landedHoursAgo: LISBON_LANDED - 120 },
  { carrier: 'ZE', number: '9', origin: 'JFK', destination: 'HND', originTz: NYC, destinationTz: TOKYO, durationHours: 14, km: 10870, landedHoursAgo: TOKYO_LANDED, lateMin: -20 },
  { carrier: 'ZE', number: '10', origin: 'HND', destination: 'JFK', originTz: TOKYO, destinationTz: NYC, durationHours: 13, km: 10870, landedHoursAgo: TOKYO_LANDED - 160, lateMin: 110 },
  { carrier: 'ZC', number: '72', origin: 'JFK', destination: 'LHR', originTz: NYC, destinationTz: LONDON, durationHours: 7, km: 5540, landedHoursAgo: 100 * 24 },
  { carrier: 'ZC', number: '331', origin: 'LHR', destination: 'CDG', originTz: LONDON, destinationTz: PARIS, durationHours: 1.25, km: 344, landedHoursAgo: 97 * 24, status: 'diverted' },
  { carrier: 'ZD', number: '909', origin: 'CDG', destination: 'JFK', originTz: PARIS, destinationTz: NYC, durationHours: 8.5, km: 5837, landedHoursAgo: 93 * 24 },
  { carrier: 'ZH', number: '415', origin: 'JFK', destination: 'SFO', originTz: NYC, destinationTz: LOS_ANGELES, durationHours: 6.3, km: 4152, landedHoursAgo: 120 * 24, lateMin: -7 },
  { carrier: 'ZH', number: '88', origin: 'SFO', destination: 'LAX', originTz: LOS_ANGELES, destinationTz: LOS_ANGELES, durationHours: 1.5, km: 543, landedHoursAgo: 118 * 24 },
  { carrier: 'ZG', number: '1916', origin: 'LAX', destination: 'JFK', originTz: LOS_ANGELES, destinationTz: NYC, durationHours: 5.3, km: 3983, landedHoursAgo: 115 * 24, lateMin: 40 },
  { carrier: 'ZJ', number: '404', origin: 'JFK', destination: 'MEX', originTz: NYC, destinationTz: MEXICO_CITY, durationHours: 5.2, km: 3360, landedHoursAgo: 150 * 24 },
  { carrier: 'ZJ', number: '405', origin: 'MEX', destination: 'JFK', originTz: MEXICO_CITY, destinationTz: NYC, durationHours: 4.8, km: 3360, landedHoursAgo: 144 * 24 },
  { carrier: 'ZB', number: '410', origin: 'JFK', destination: 'ORD', originTz: NYC, destinationTz: CHICAGO, durationHours: 2.6, km: 1188, landedHoursAgo: 180 * 24 },
  { carrier: 'ZB', number: '411', origin: 'ORD', destination: 'JFK', originTz: CHICAGO, destinationTz: NYC, durationHours: 2.2, km: 1188, landedHoursAgo: 178 * 24 },
  // An old row from before distance and country were stored.
  { carrier: 'ZK', number: '2100', origin: 'BOS', destination: 'JFK', originTz: NYC, destinationTz: NYC, durationHours: 1.2, km: null, landedHoursAgo: 240 * 24 },
  { carrier: 'ZK', number: '2101', origin: 'JFK', destination: 'BOS', originTz: NYC, destinationTz: NYC, durationHours: 1.2, km: 301, landedHoursAgo: 236 * 24 },
  { carrier: 'ZL', number: '1203', origin: 'JFK', destination: 'MIA', originTz: NYC, destinationTz: NYC, durationHours: 3, km: 1753, landedHoursAgo: 270 * 24 },
];

/** A made-up co-member's leg into a group trip's destination. */
function memberLeg(
  now: Date,
  landedHoursAgo: number,
  offsetMin: number | null,
  destination: string,
  sequenceNumber = 1,
) {
  const landing = new Date(now.getTime() - landedHoursAgo * HOUR_MS + (offsetMin ?? 0) * 60_000);
  return {
    sequenceNumber,
    destinationIata: destination,
    // A date at an origin somewhere west of the destination, hours earlier.
    departureDateLocal: localDate(new Date(landing.getTime() - 8 * HOUR_MS), NYC),
    actualArrivalUtc: offsetMin === null ? null : landing.toISOString(),
  };
}

function history(now: Date): { flights: SegmentView[]; groupTrips: GroupTripInput[] } {
  const flights = HISTORY.map((spec, i) => {
    const late = spec.lateMin ?? 0;
    return segment(
      {
        index: 200 + i,
        carrier: spec.carrier,
        number: spec.number,
        origin: spec.origin,
        destination: spec.destination,
        originTz: spec.originTz,
        destinationTz: spec.destinationTz,
        // Scheduled so that the *actual* landing is `landedHoursAgo`.
        departsInHours: -spec.landedHoursAgo - spec.durationHours - late / 60,
        durationHours: spec.durationHours,
        status: spec.status ?? 'landed',
        departed: true,
        landed: true,
        archived: true,
        lateMin: late,
        distanceKm: spec.km,
        originCountry: spec.km === null ? null : (COUNTRY[spec.origin] ?? null),
        destinationCountry: spec.km === null ? null : (COUNTRY[spec.destination] ?? null),
      },
      { id: mockUuid(1, 200 + i), label: null },
      1,
      now,
    );
  });

  const ownLeg = (index: number): GroupMemberTrip['legs'][number] => {
    const flight = flights[index]?.flight;
    return {
      sequenceNumber: 1,
      destinationIata: flight?.destination_iata ?? '',
      departureDateLocal: flight?.departure_date_local ?? '',
      actualArrivalUtc: flight?.actual_arrival_utc ?? null,
    };
  };
  const self = (index: number): GroupMemberTrip => ({
    travelerId: mockUuid(7, 0),
    isSelf: true,
    displayName: MOCK_PROFILE.displayName,
    legs: [ownLeg(index)],
  });
  const person = (
    n: number,
    displayName: string,
    legs: GroupMemberTrip['legs'],
  ): GroupMemberTrip => ({ travelerId: mockUuid(7, n), isSelf: false, displayName, legs });

  const groupTrips: GroupTripInput[] = [
    {
      groupId: mockUuid(6, 20),
      destinationIata: 'LAX',
      members: [
        self(0),
        person(1, 'Priya Shah', [memberLeg(now, LA_LANDED, 12, 'LAX')]),
        person(2, 'Marcus Reed', [memberLeg(now, LA_LANDED, 100, 'LAX')]),
        // Cancelled: never landed, so not a buddy on this trip.
        person(3, 'Dev Kapoor', [memberLeg(now, LA_LANDED, null, 'LAX')]),
      ],
    },
    {
      groupId: mockUuid(6, 21),
      destinationIata: 'LIS',
      members: [
        self(2),
        person(1, 'Priya Shah', [memberLeg(now, LISBON_LANDED, -8, 'LIS')]),
        // Two legs: the arrival leg is the first into LIS, not the last.
        person(4, 'Sofia Alves', [
          memberLeg(now, LISBON_LANDED, 35, 'LIS', 1),
          memberLeg(now, LISBON_LANDED - 30, 0, 'OPO', 2),
        ]),
        // An unclaimed traveller the owner added: still a buddy.
        person(5, 'Hana Mori', [memberLeg(now, LISBON_LANDED, 70, 'LIS')]),
      ],
    },
    {
      groupId: mockUuid(6, 22),
      destinationIata: 'HND',
      members: [
        self(5),
        person(1, 'Priya Shah', [memberLeg(now, TOKYO_LANDED, 15, 'HND')]),
        person(6, 'Kenji Ito', [memberLeg(now, TOKYO_LANDED, 25, 'HND')]),
        // Another airport: a buddy, but never "in sync" or "waited for".
        person(7, 'Lena Fischer', [memberLeg(now, TOKYO_LANDED, 10, 'NRT')]),
        // More than 12 hours later: a buddy, not a wait.
        person(8, 'Omar Haddad', [memberLeg(now, TOKYO_LANDED, 14 * 60, 'HND')]),
      ],
    },
  ];

  return { flights, groupTrips };
}

export const MOCK_PROFILE: MockProfile = {
  displayName: 'Sam Rivera',
  email: 'sam@example.com',
  quietHoursEnabled: true,
  createdAt: '2025-03-14T15:00:00.000Z',
};
