/**
 * Reading "who you flew with" for the Profile tab, under RLS.
 *
 * Two queries, never one per group or per member (§8.11):
 *
 * 1. Your own **active** `group_members` rows → the group ids. The
 *    `travelers.user_id` filter is what makes them *yours*:
 *    `group_members_select_visible` also returns every row of a group you are
 *    active in.
 * 2. For those groups, every **active** member row with its traveller
 *    (`display_name`, and `user_id` only to recognise yourself), the group's
 *    `destination_iata`, and the trip linked to the membership
 *    (`group_members.trip_id → trips → trip_segments → flights`), reading only
 *    the three flight columns the arrival-leg rule needs. Co-members' trips and
 *    flights are readable through `can_read_trip` / `can_read_flight`.
 *
 * Archived groups are included on purpose: a trip that finished in March is
 * still one of this year's group trips. Unclaimed travellers (`user_id` NULL)
 * come back like anyone else and count as buddies.
 *
 * Display names are other people's typing: they are passed through as data,
 * rendered as plain text, and never logged.
 */
import type { GroupTripInput, GroupTripLeg } from './profile-stats';
import { MOCK_API } from './env';
import { listMockGroupTrips } from './mock/store';
import { supabase } from './supabase';

const MEMBER_SELECT = `
  group_id,
  traveler_id,
  groups ( id, destination_iata ),
  travelers ( id, user_id, display_name ),
  trips (
    trip_segments (
      sequence_number,
      flights ( destination_iata, departure_date_local, actual_arrival_utc )
    )
  )
` as const;

/** Supabase types a to-one embed as an object; tolerate an array defensively. */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function fetchGroupTrips(userId: string): Promise<GroupTripInput[]> {
  if (MOCK_API) return listMockGroupTrips();

  const mine = await supabase
    .from('group_members')
    .select('group_id, travelers!inner ( user_id )')
    .eq('travelers.user_id', userId)
    .eq('status', 'active');
  if (mine.error !== null) throw new Error(mine.error.message);

  const groupIds = [...new Set((mine.data ?? []).map((row) => row.group_id))];
  if (groupIds.length === 0) return [];

  const { data, error } = await supabase
    .from('group_members')
    .select(MEMBER_SELECT)
    .in('group_id', groupIds)
    .eq('status', 'active');
  if (error !== null) throw new Error(error.message);

  const groups = new Map<string, GroupTripInput>();
  for (const row of data ?? []) {
    const traveler = one(row.travelers);
    if (traveler === null) continue;
    const group = groups.get(row.group_id) ?? {
      groupId: row.group_id,
      destinationIata: one(row.groups)?.destination_iata ?? null,
      members: [],
    };

    const legs: GroupTripLeg[] = [];
    for (const segment of one(row.trips)?.trip_segments ?? []) {
      const flight = one(segment.flights);
      if (flight === null) continue;
      legs.push({
        sequenceNumber: segment.sequence_number,
        destinationIata: flight.destination_iata,
        departureDateLocal: flight.departure_date_local,
        actualArrivalUtc: flight.actual_arrival_utc,
      });
    }

    group.members.push({
      travelerId: row.traveler_id,
      isSelf: traveler.user_id === userId,
      displayName: traveler.display_name,
      legs,
    });
    groups.set(row.group_id, group);
  }

  return [...groups.values()];
}
