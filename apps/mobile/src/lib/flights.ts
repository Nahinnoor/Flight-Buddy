/**
 * Reading the signed-in user's own flights.
 *
 * Mobile reads `trips → trip_segments → flights` straight from Postgres under
 * RLS (ADR 0001). It is one query, not one per segment: the same shape that
 * §8.11 warns about for the group page applies here the moment a user has a
 * couple of multi-leg trips.
 *
 * RLS lets a user see co-members' trips too (`can_read_trip`), so the query
 * filters on `travelers.user_id` explicitly — the dashboard is the *personal*
 * view, and "what the policy allows" is not the same question as "what this
 * screen wants".
 */
import type { Database } from '@flightbuddy/shared';

import { MOCK_API } from './env';
import { listMockSegments } from './mock/store';
import { supabase } from './supabase';

export type FlightRow = Database['public']['Tables']['flights']['Row'];

/** One leg the user is on: the flight, plus what they actually typed for it. */
export interface SegmentView {
  segmentId: string;
  sequenceNumber: number;
  tripId: string;
  tripLabel: string | null;
  /** The marketing number, from `trip_segments`. Display this first (§7.2). */
  marketingCarrierIata: string | null;
  marketingFlightNumber: string | null;
  overrideNotes: string | null;
  flight: FlightRow;
}

/**
 * `flights!inner` matters twice: it drops segments whose flight is filtered
 * out, and it is what makes `.order(..., { referencedTable: 'flights' })` order
 * the *parent* rows rather than a nested array.
 */
const SEGMENT_SELECT = `
  id,
  sequence_number,
  marketing_carrier_iata,
  marketing_flight_number,
  override_notes,
  trips!inner (
    id,
    label,
    travelers!inner ( id, user_id )
  ),
  flights!inner ( * )
` as const;

/**
 * Every non-archived leg belonging to `userId`, earliest scheduled departure
 * first. A flight with no scheduled departure (a `manual`-tier row the user has
 * not filled in) sorts last rather than disappearing.
 */
export async function fetchMySegments(userId: string): Promise<SegmentView[]> {
  // Mock mode never wrote any rows, so reading Postgres would always be empty
  // and the dashboard would be untestable before `apps/api` exists.
  if (MOCK_API) return listMockSegments();

  const { data, error } = await supabase
    .from('trip_segments')
    .select(SEGMENT_SELECT)
    .eq('trips.travelers.user_id', userId)
    .is('flights.archived_at', null)
    .order('scheduled_departure_utc', {
      referencedTable: 'flights',
      ascending: true,
      nullsFirst: false,
    });

  if (error !== null) throw new Error(error.message);

  const views = (data ?? []).map((row) => ({
    segmentId: row.id,
    sequenceNumber: row.sequence_number,
    tripId: row.trips.id,
    tripLabel: row.trips.label,
    marketingCarrierIata: row.marketing_carrier_iata,
    marketingFlightNumber: row.marketing_flight_number,
    overrideNotes: row.override_notes,
    flight: row.flights,
  }));

  // Ordering an embedded to-one resource is a PostgREST subtlety that depends
  // on the `!inner` above. `pickNextSegment` assumes the order, so it is made
  // true here rather than assumed of the server.
  return sortByScheduledDeparture(views);
}

/** Earliest scheduled departure first; unknown departures last. */
export function sortByScheduledDeparture(segments: readonly SegmentView[]): SegmentView[] {
  return [...segments].sort((a, b) => {
    const left = a.flight.scheduled_departure_utc;
    const right = b.flight.scheduled_departure_utc;
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return left.localeCompare(right);
  });
}

/** When this leg is expected to push back: estimate if there is one. */
export function effectiveDeparture(flight: FlightRow): string | null {
  return flight.estimated_departure_utc ?? flight.scheduled_departure_utc;
}

/**
 * The leg to pin at the top: the soonest departure still ahead of us. If every
 * leg has departed, the most recent one stays pinned — someone mid-trip cares
 * about the flight they are on, not an empty screen.
 *
 * `segments` is assumed to be in the order `fetchMySegments` returns.
 */
export function pickNextSegment(
  segments: readonly SegmentView[],
  now: Date = new Date(),
): SegmentView | null {
  if (segments.length === 0) return null;

  const upcoming = segments.find((segment) => {
    const departure = effectiveDeparture(segment.flight);
    if (departure === null) return false;
    const arrival =
      segment.flight.estimated_arrival_utc ?? segment.flight.scheduled_arrival_utc ?? departure;
    // Still "next" while it is in the air, not only before pushback.
    return new Date(arrival).getTime() >= now.getTime();
  });

  return upcoming ?? segments[segments.length - 1] ?? null;
}
