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
 *
 * Which leg is pinned, which are "later", and how the archived list is ordered
 * are decided in `dashboard-model.ts`, where they are tested.
 */
import { sortByScheduledDeparture, sortPastFlights, type SegmentView } from './dashboard-model';
import { MOCK_API } from './env';
import { listMockPastSegments, listMockSegments } from './mock/store';
import { supabase } from './supabase';

export type { FlightRow, SegmentView } from './dashboard-model';

/**
 * Archived flights are kept for 90 days (§1), so this is a backstop against a
 * pathological account, not a page size anyone should reach.
 */
const PAST_FLIGHTS_LIMIT = 200;

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

type SegmentRow = {
  id: string;
  sequence_number: number;
  marketing_carrier_iata: string | null;
  marketing_flight_number: string | null;
  override_notes: string | null;
  trips: { id: string; label: string | null };
  flights: SegmentView['flight'];
};

function toView(row: SegmentRow): SegmentView {
  return {
    segmentId: row.id,
    sequenceNumber: row.sequence_number,
    tripId: row.trips.id,
    tripLabel: row.trips.label,
    marketingCarrierIata: row.marketing_carrier_iata,
    marketingFlightNumber: row.marketing_flight_number,
    overrideNotes: row.override_notes,
    flight: row.flights,
  };
}

/**
 * Every non-archived leg belonging to `userId`, earliest scheduled departure
 * first. A flight with no scheduled departure (a `manual`-tier row the user has
 * not filled in) sorts last rather than disappearing.
 */
export async function fetchMySegments(userId: string): Promise<SegmentView[]> {
  // Mock mode never wrote any rows, so reading Postgres would always be empty.
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

  // Ordering an embedded to-one resource is a PostgREST subtlety that depends
  // on the `!inner` above. The model assumes the order, so it is made true
  // here rather than assumed of the server.
  return sortByScheduledDeparture((data ?? []).map(toView));
}

/**
 * The user's archived legs (§3.7: a flight nobody is still travelling on is
 * archived, not deleted), most recent first. These are the user's *own*
 * `trip_segments` — the same `travelers.user_id` filter as above.
 */
export async function fetchPastSegments(userId: string): Promise<SegmentView[]> {
  if (MOCK_API) return sortPastFlights(listMockPastSegments());

  const { data, error } = await supabase
    .from('trip_segments')
    .select(SEGMENT_SELECT)
    .eq('trips.travelers.user_id', userId)
    .not('flights.archived_at', 'is', null)
    .order('scheduled_departure_utc', {
      referencedTable: 'flights',
      ascending: false,
      nullsFirst: false,
    })
    .limit(PAST_FLIGHTS_LIMIT);

  if (error !== null) throw new Error(error.message);

  return sortPastFlights((data ?? []).map(toView));
}
