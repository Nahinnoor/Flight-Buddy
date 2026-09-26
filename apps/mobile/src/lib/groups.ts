/**
 * Reading the signed-in user's own group memberships, under RLS.
 *
 * One query: the user's `group_members` rows, each with its group and the
 * legs of the trip attached to it (`group_members.trip_id → trips →
 * trip_segments → flights`), so the dashboard can count down to every group
 * without a query per group (§8.11).
 *
 * Read only. Creating, joining and approving are Phase 3 and have no API yet.
 *
 * What RLS lets through, and why the filters are still explicit:
 *
 * - `group_members_select_visible` shows your own rows *and* every row of a
 *   group you are active in. The `travelers.user_id` filter keeps it to yours.
 * - `groups_select_member` admits active members and the owner only. For a
 *   **pending** request the embedded `groups` comes back `null`; the row itself
 *   is still visible to its requester, so it can say "Waiting for approval".
 * - Legs are your own trip's, so `can_read_trip` / `can_read_flight` pass.
 */
import type { LegTimes, MembershipView } from './dashboard-model';
import { MOCK_API } from './env';
import { listMockMemberships } from './mock/store';
import { supabase } from './supabase';

const MEMBERSHIP_SELECT = `
  id,
  status,
  role,
  trip_id,
  travelers!inner ( user_id ),
  groups ( id, name, destination_iata, archived_at ),
  trips (
    id,
    trip_segments (
      sequence_number,
      flights (
        scheduled_departure_utc,
        estimated_departure_utc,
        actual_departure_utc,
        scheduled_arrival_utc,
        estimated_arrival_utc,
        actual_arrival_utc,
        status,
        archived_at
      )
    )
  )
` as const;

type FlightTimes = Omit<LegTimes, 'sequenceNumber'>;

/** Supabase types a to-one embed as an object; tolerate an array defensively. */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function fetchMyMemberships(userId: string): Promise<MembershipView[]> {
  if (MOCK_API) return listMockMemberships();

  const { data, error } = await supabase
    .from('group_members')
    .select(MEMBERSHIP_SELECT)
    .eq('travelers.user_id', userId)
    .in('status', ['active', 'pending']);

  if (error !== null) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const group = one(row.groups);
    const trip = one(row.trips);
    const legs: LegTimes[] = [];
    for (const segment of trip?.trip_segments ?? []) {
      const flight = one<FlightTimes>(segment.flights);
      if (flight !== null) legs.push({ ...flight, sequenceNumber: segment.sequence_number });
    }

    return {
      membershipId: row.id,
      status: row.status,
      role: row.role,
      group:
        group === null
          ? null
          : {
              id: group.id,
              name: group.name,
              destinationIata: group.destination_iata,
              archivedAt: group.archived_at,
            },
      tripId: row.trip_id,
      legs,
    };
  });
}
