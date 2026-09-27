/**
 * In-memory stand-in for the signed-in user's rows, for
 * `EXPO_PUBLIC_MOCK_API=1`: their flights (upcoming and archived), their group
 * memberships and their profile.
 *
 * Without this, mock mode can exercise the lookup and the disambiguation list
 * but never the dashboard, the Groups tab or Profile — and those are where
 * most of the display rules live.
 *
 * It lives for the life of the JS context: a reload goes back to the seeded
 * scenario. That is the right trade — it is a fixture, not a cache, and
 * persisting it would invite someone to mistake it for real data.
 *
 * Imports only the pure model, never `../flights`: the old
 * `store.ts` ↔ `flights.ts` require cycle is gone.
 */
import type { FlightCandidate } from '@flightbuddy/shared';

import type { GroupTripInput } from '../profile-stats';
import {
  sortByScheduledDeparture,
  type FlightRow,
  type MembershipView,
  type SegmentView,
} from '../dashboard-model';
import {
  buildMockData,
  MOCK_PROFILE,
  mockUuid,
  type MockData,
  type MockProfile,
  type MockScenario,
} from './fixtures';

export { mockUuid };

let scenario: MockScenario = 'full';
let seeded: MockData | null = null;
const added: SegmentView[] = [];
let sequence = 0;
let profile: MockProfile = { ...MOCK_PROFILE };

function data(): MockData {
  seeded ??= buildMockData(scenario, new Date());
  return seeded;
}

export function getMockScenario(): MockScenario {
  return scenario;
}

/** Replaces every mock row, including flights added through the mock lookup. */
export function setMockScenario(next: MockScenario): void {
  scenario = next;
  seeded = null;
  added.length = 0;
}

/** The single trip every added flight is appended to. */
const MOCK_TRIP_ID = mockUuid(1, 1000);

function flightRowFromCandidate(candidate: FlightCandidate, index: number): FlightRow {
  const now = new Date().toISOString();

  return {
    id: mockUuid(3, 1000 + index),
    operating_carrier_iata: candidate.operatingCarrierIata,
    operating_flight_number: candidate.operatingFlightNumber,
    departure_date_local: candidate.departureDateLocal,
    origin_iata: candidate.originIata,
    destination_iata: candidate.destinationIata,
    origin_tz: candidate.originTz,
    destination_tz: candidate.destinationTz,

    status: candidate.status,
    tracking_tier: candidate.trackingTier,
    gate: candidate.gate,
    terminal: candidate.terminal,

    scheduled_departure_utc: candidate.scheduledDepartureUtc,
    estimated_departure_utc: candidate.estimatedDepartureUtc,
    actual_departure_utc: candidate.actualDepartureUtc,
    scheduled_arrival_utc: candidate.scheduledArrivalUtc,
    estimated_arrival_utc: candidate.estimatedArrivalUtc,
    actual_arrival_utc: candidate.actualArrivalUtc,

    aircraft_reg: candidate.aircraftReg,
    aircraft_model: candidate.aircraftModel,

    // Poller-owned columns. A fresh row would look exactly like this.
    next_poll_at: null,
    poll_lease_until: null,
    last_polled_at: null,
    poll_failure_count: 0,
    alert_subscription_id: null,
    alert_subscribed_at: null,
    raw_payload: null,
    distance_km: candidate.distanceKm ?? null,
    origin_country_code: candidate.originCountryCode ?? null,
    destination_country_code: candidate.destinationCountryCode ?? null,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

/** Appends a segment and returns what `POST /v1/flights` would have answered. */
export function addMockSegment(candidate: FlightCandidate): {
  tripId: string;
  segmentId: string;
  flightId: string;
  sequenceNumber: number;
} {
  sequence += 1;
  const flight = flightRowFromCandidate(candidate, sequence);

  added.push({
    segmentId: mockUuid(2, 1000 + sequence),
    sequenceNumber: sequence,
    tripId: MOCK_TRIP_ID,
    tripLabel: null,
    marketingCarrierIata: candidate.marketingCarrierIata,
    marketingFlightNumber: candidate.marketingFlightNumber,
    overrideNotes: null,
    flight,
  });

  return {
    tripId: MOCK_TRIP_ID,
    segmentId: mockUuid(2, 1000 + sequence),
    flightId: flight.id,
    sequenceNumber: sequence,
  };
}

/** Non-archived legs, ordered the way `fetchMySegments` orders them. */
export function listMockSegments(): SegmentView[] {
  return sortByScheduledDeparture([...data().segments, ...added]);
}

/** Archived legs. */
export function listMockPastSegments(): SegmentView[] {
  return [...data().past];
}

/** Every own leg, upcoming, added and archived: the Profile's input. */
export function listMockAllSegments(): SegmentView[] {
  return [...data().segments, ...added, ...data().past];
}

export function listMockGroupTrips(): GroupTripInput[] {
  return data().groupTrips;
}

export function listMockMemberships(): MembershipView[] {
  return data().memberships.filter((m) => m.status !== 'removed');
}

export function getMockProfile(): MockProfile {
  return { ...profile };
}

export function updateMockProfile(patch: Partial<MockProfile>): MockProfile {
  profile = { ...profile, ...patch };
  return { ...profile };
}
