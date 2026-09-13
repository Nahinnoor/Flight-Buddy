/**
 * In-memory stand-in for the `trips → trip_segments → flights` rows, for
 * `EXPO_PUBLIC_MOCK_API=1`.
 *
 * Without this, mock mode can exercise the lookup and the disambiguation list
 * but never the dashboard — `addFlight` would return ids for rows that do not
 * exist, and the flight card, which is where most of §7.2, §7.3 and §8.8 live,
 * would be unreachable until `apps/api` ships.
 *
 * It lives for the life of the JS context: a reload empties it. That is the
 * right trade — it is a fixture, not a cache, and persisting it would invite
 * someone to mistake it for real data.
 */
import type { Database, FlightCandidate } from '@flightbuddy/shared';

import { sortByScheduledDeparture, type SegmentView } from '../flights';

type FlightRow = Database['public']['Tables']['flights']['Row'];

const segments: SegmentView[] = [];
let sequence = 0;

/** Deterministic, schema-valid v4-shaped UUID so responses parse like real ones. */
export function mockUuid(kind: number, index: number): string {
  return `00000000-0000-4000-8000-${(kind * 0x1000000 + index).toString(16).padStart(12, '0')}`;
}

/** The single trip everything is appended to. Layovers get their own PR. */
const MOCK_TRIP_ID = mockUuid(1, 1);

function flightRowFromCandidate(candidate: FlightCandidate, index: number): FlightRow {
  const now = new Date().toISOString();

  return {
    id: mockUuid(3, index),
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

  segments.push({
    segmentId: mockUuid(2, sequence),
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
    segmentId: mockUuid(2, sequence),
    flightId: flight.id,
    sequenceNumber: sequence,
  };
}

/** Everything added this session, ordered the way `fetchMySegments` orders. */
export function listMockSegments(): SegmentView[] {
  return sortByScheduledDeparture(segments);
}
