/**
 * What the signed-in screens show, as pure functions.
 *
 * Every decision the dashboard and the Groups tab make — which flight is
 * pinned, which groups get a card and in what order, what a group card's
 * countdown says, when the archived flights take the groups' place — lives
 * here, with no React, no Supabase and no clock of its own (`now` is always a
 * parameter). The screens only render what these return, so the rules are
 * pinned down by `dashboard-model.test.ts` rather than by eyeballing a
 * simulator.
 *
 * Relative imports only: vitest runs this file without the app's `@/` alias.
 */
import type { Database } from '@flightbuddy/shared';

import { departureAnchor } from './flight-display';

export type FlightRow = Database['public']['Tables']['flights']['Row'];
export type MembershipStatus = Database['public']['Enums']['membership_status'];

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

/** The columns of a flight the group countdown needs, and nothing else. */
export type LegTimes = Pick<
  FlightRow,
  | 'scheduled_departure_utc'
  | 'estimated_departure_utc'
  | 'actual_departure_utc'
  | 'scheduled_arrival_utc'
  | 'estimated_arrival_utc'
  | 'actual_arrival_utc'
  | 'status'
  | 'archived_at'
> & { sequenceNumber: number };

/**
 * One of the user's own `group_members` rows.
 *
 * `group` is `null` when RLS will not show the group itself — which is the
 * normal case for a **pending** request: `groups_select_member` admits active
 * members and the owner, not someone still waiting for approval, while
 * `group_members_select_visible` does let them see their own row.
 */
export interface MembershipView {
  membershipId: string;
  status: MembershipStatus;
  role: string;
  group: {
    id: string;
    name: string;
    destinationIata: string | null;
    archivedAt: string | null;
  } | null;
  tripId: string | null;
  /** Every leg of `tripId`, archived ones included. Empty with no trip. */
  legs: LegTimes[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How many archived flights the dashboard shows before linking to Profile. */
export const PAST_PREVIEW_LIMIT = 5;

// ------------------------------------------------------------- flights ---

/** Earliest scheduled departure first; unknown departures last. */
export function sortByScheduledDeparture(segments: readonly SegmentView[]): SegmentView[] {
  return [...segments].sort((a, b) => {
    const left = a.flight.scheduled_departure_utc;
    const right = b.flight.scheduled_departure_utc;
    if (left === right) return a.sequenceNumber - b.sequenceNumber;
    if (left === null) return 1;
    if (right === null) return -1;
    return left.localeCompare(right);
  });
}

/** Most recent first, for the archived list. Unknown departures last. */
export function sortPastFlights(segments: readonly SegmentView[]): SegmentView[] {
  return [...segments].sort((a, b) => {
    const left = a.flight.scheduled_departure_utc;
    const right = b.flight.scheduled_departure_utc;
    if (left === right) return b.sequenceNumber - a.sequenceNumber;
    if (left === null) return 1;
    if (right === null) return -1;
    return right.localeCompare(left);
  });
}

type FlightState = Pick<
  FlightRow,
  | 'status'
  | 'actual_departure_utc'
  | 'estimated_departure_utc'
  | 'scheduled_departure_utc'
  | 'actual_arrival_utc'
  | 'estimated_arrival_utc'
  | 'scheduled_arrival_utc'
>;

/** Wheels down: the provider said so, or recorded an arrival. */
export function hasLanded(flight: FlightState): boolean {
  return flight.status === 'landed' || flight.actual_arrival_utc !== null;
}

/**
 * Off the ground and not yet down. Trusts the status and the recorded
 * departure over any clock arithmetic: a flight holding over its destination
 * is still in the air after its estimated arrival has passed.
 */
export function isAirborne(flight: FlightState): boolean {
  if (hasLanded(flight)) return false;
  return (
    flight.actual_departure_utc !== null ||
    flight.status === 'departed' ||
    flight.status === 'en_route' ||
    flight.status === 'diverted'
  );
}

function toCamel(flight: FlightState) {
  return {
    actualDepartureUtc: flight.actual_departure_utc,
    estimatedDepartureUtc: flight.estimated_departure_utc,
    scheduledDepartureUtc: flight.scheduled_departure_utc,
  };
}

/**
 * Still ahead of the user or under way. A leg in the air always is; a landed
 * one never is; one still on the ground is until its expected arrival has
 * passed (a flight whose whole window went by with no word from the provider
 * is over, not "next").
 */
export function isCurrentOrUpcoming(flight: FlightState, now: Date): boolean {
  if (hasLanded(flight)) return false;
  if (isAirborne(flight)) return true;
  const departure = departureAnchor(toCamel(flight));
  if (departure === null) return false;
  const arrival = flight.estimated_arrival_utc ?? flight.scheduled_arrival_utc ?? departure;
  return new Date(arrival).getTime() >= now.getTime();
}

/**
 * The flight pinned at the top of the dashboard: the soonest one that has not
 * landed. A flight in the air stays pinned until it lands, and on a
 * multi-leg trip that makes the pinned leg the current one, then the next.
 *
 * When every leg has landed (they stay on the dashboard until the archive job
 * takes them, 30 minutes after landing), the most recent keeps the pin: the
 * person who just landed still wants the arrival details, not an empty space.
 */
export function pickMainSegment(
  segments: readonly SegmentView[],
  now: Date,
): SegmentView | null {
  const ordered = sortByScheduledDeparture(segments);
  const current = ordered.find((segment) => isCurrentOrUpcoming(segment.flight, now));
  return current ?? ordered[ordered.length - 1] ?? null;
}

/** Every other leg still ahead, earliest first. Landed legs drop out. */
export function laterSegments(
  segments: readonly SegmentView[],
  main: SegmentView | null,
  now: Date,
): SegmentView[] {
  return sortByScheduledDeparture(segments).filter(
    (segment) =>
      segment.segmentId !== main?.segmentId && isCurrentOrUpcoming(segment.flight, now),
  );
}

// -------------------------------------------------------------- groups ---

/**
 * What a group is called on a card: its name, or its destination when the
 * name is blank. Both come from someone else's typing, so this only trims —
 * the text is rendered as text, never interpreted.
 */
export function groupLabel(group: { name: string; destinationIata: string | null }): string {
  const name = group.name.trim();
  if (name !== '') return name;
  const destination = group.destinationIata?.trim() ?? '';
  if (destination !== '') return destination.toUpperCase();
  return 'Untitled group';
}

export type GroupCountdown =
  /** No trip attached, or nothing left on it: "Add your flight". */
  | { kind: 'no-flight' }
  /** The first leg has a time and it is still ahead. */
  | { kind: 'upcoming'; targetUtc: string }
  /** The first leg has left; the trip is not finished yet. */
  | { kind: 'underway' }
  /** Every remaining leg is down, and the archive job has not caught up. */
  | { kind: 'arrived' }
  /** A leg exists but nobody knows when it leaves (a manual row, unfilled). */
  | { kind: 'time-unknown' };

function sortLegs(legs: readonly LegTimes[]): LegTimes[] {
  return [...legs].sort((a, b) => {
    const left = a.scheduled_departure_utc;
    const right = b.scheduled_departure_utc;
    if (left === right) return a.sequenceNumber - b.sequenceNumber;
    if (left === null) return 1;
    if (right === null) return -1;
    return left.localeCompare(right);
  });
}

/**
 * The user's own departure in a group: the **first leg** of the trip on their
 * membership, anchored exactly as the flight card anchors its countdown
 * (`departureAnchor`).
 *
 * Archived legs count when finding the first one, so a multi-leg trip whose
 * first leg has landed and been archived reads as under way rather than
 * counting down to the second leg as if it were the start. A trip with no
 * live leg left is over: that is "Add your flight".
 */
export function groupCountdown(legs: readonly LegTimes[], now: Date): GroupCountdown {
  const live = legs.filter((leg) => leg.archived_at === null);
  if (live.length === 0) return { kind: 'no-flight' };
  if (live.every((leg) => hasLanded(leg))) return { kind: 'arrived' };

  const first = sortLegs(legs)[0];
  if (first === undefined) return { kind: 'no-flight' };
  if (first.archived_at !== null || isAirborne(first) || hasLanded(first)) {
    return { kind: 'underway' };
  }

  const target = departureAnchor(toCamel(first));
  if (target === null) return { kind: 'time-unknown' };
  if (new Date(target).getTime() <= now.getTime()) return { kind: 'underway' };
  return { kind: 'upcoming', targetUtc: target };
}

/**
 * `in 3 days` a day or more out; `in 5h 12m` inside the final 24 hours. Days
 * are floored, the same way the flight card floors them, so a card reading
 * "2d 23h" and a group reading "2 days" agree.
 */
export function formatGroupCountdown(targetUtc: string, now: Date): string {
  const remaining = new Date(targetUtc).getTime() - now.getTime();
  if (Number.isNaN(remaining)) return 'Departure time unknown';
  if (remaining <= 0) return 'Departing now';

  if (remaining >= DAY_MS) {
    const days = Math.floor(remaining / DAY_MS);
    return `in ${days} ${days === 1 ? 'day' : 'days'}`;
  }

  const hours = Math.floor(remaining / HOUR_MS);
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
  if (hours === 0 && minutes === 0) return 'in under a minute';
  if (hours === 0) return `in ${minutes}m`;
  return `in ${hours}h ${minutes}m`;
}

/** The one line under a group's name. */
export function groupCountdownText(countdown: GroupCountdown, now: Date): string {
  switch (countdown.kind) {
    case 'no-flight':
      return 'Add your flight';
    case 'underway':
      return 'On your way';
    case 'arrived':
      return 'Landed';
    case 'time-unknown':
      return 'Departure time unknown';
    case 'upcoming': {
      const text = formatGroupCountdown(countdown.targetUtc, now);
      return text.startsWith('in ') ? `Departs ${text}` : text;
    }
  }
}

export interface GroupCard {
  membershipId: string;
  groupId: string;
  label: string;
  countdown: GroupCountdown;
}

/**
 * Soonest first (§3.5): a trip under way, one that just landed, then by
 * departure, then unknown times, then groups with no flight yet.
 */
const COUNTDOWN_RANK: Record<GroupCountdown['kind'], number> = {
  underway: 0,
  arrived: 1,
  upcoming: 2,
  'time-unknown': 3,
  'no-flight': 4,
};

function compareCards(a: GroupCard, b: GroupCard): number {
  const rank = COUNTDOWN_RANK[a.countdown.kind] - COUNTDOWN_RANK[b.countdown.kind];
  if (rank !== 0) return rank;
  if (a.countdown.kind === 'upcoming' && b.countdown.kind === 'upcoming') {
    const byTime = a.countdown.targetUtc.localeCompare(b.countdown.targetUtc);
    if (byTime !== 0) return byTime;
  }
  return a.label.localeCompare(b.label);
}

/** A group the dashboard gives a card: an active membership, group not archived. */
export function isDashboardGroup(membership: MembershipView): boolean {
  return (
    membership.status === 'active' &&
    membership.group !== null &&
    membership.group.archivedAt === null
  );
}

/** One card per active, unarchived group, soonest departure first. */
export function dashboardGroups(memberships: readonly MembershipView[], now: Date): GroupCard[] {
  return memberships
    .filter(isDashboardGroup)
    .map((membership) => ({
      membershipId: membership.membershipId,
      // `isDashboardGroup` guarantees the group is there.
      groupId: membership.group?.id ?? membership.membershipId,
      label: membership.group === null ? 'Untitled group' : groupLabel(membership.group),
      countdown: groupCountdown(membership.legs, now),
    }))
    .sort(compareCards);
}

export interface GroupsTabEntry {
  membershipId: string;
  status: 'active' | 'pending';
  label: string;
  /** "Departs in 3 days", or "Waiting for approval" for a pending request. */
  detail: string;
  /** True when `detail` is a live countdown (drawn in the accent colour). */
  isCountdown: boolean;
  isOwner: boolean;
}

/**
 * The Groups tab: active groups (soonest first), then pending requests.
 * Archived groups and removed memberships are not listed. A pending request
 * usually cannot see its group's name under RLS, so it reads "Join request".
 */
export function groupsTabEntries(
  memberships: readonly MembershipView[],
  now: Date,
): GroupsTabEntry[] {
  const active: GroupsTabEntry[] = dashboardGroups(memberships, now).map((card) => {
    const membership = memberships.find((m) => m.membershipId === card.membershipId);
    return {
      membershipId: card.membershipId,
      status: 'active',
      label: card.label,
      detail: groupCountdownText(card.countdown, now),
      isCountdown: card.countdown.kind === 'upcoming',
      isOwner: membership?.role === 'owner',
    };
  });

  const pending: GroupsTabEntry[] = memberships
    .filter(
      (m) => m.status === 'pending' && (m.group === null || m.group.archivedAt === null),
    )
    .map((m) => ({
      membershipId: m.membershipId,
      status: 'pending' as const,
      label: m.group === null ? 'Join request' : groupLabel(m.group),
      detail: 'Waiting for approval',
      isCountdown: false,
      isOwner: false,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...active, ...pending];
}

// ----------------------------------------------------------- dashboard ---

export interface DashboardInput {
  /** Non-archived legs. `null` while loading or after an error. */
  segments: readonly SegmentView[] | null;
  memberships: readonly MembershipView[] | null;
  /** Archived legs. */
  past: readonly SegmentView[] | null;
}

export interface DashboardModel {
  main: SegmentView | null;
  later: SegmentView[];
  /**
   * What fills the space under the main flight: `groups` when the user is in
   * at least one active group, `past` when they are in none, and `unknown`
   * until the memberships have loaded (the screen shows that section's own
   * loading or error state).
   */
  space: 'groups' | 'past' | 'unknown';
  groups: GroupCard[];
  pastPreview: SegmentView[];
  pastHasMore: boolean;
  /** Everything loaded and there is nothing at all: point at the + button. */
  isEmpty: boolean;
}

export function buildDashboard(input: DashboardInput, now: Date): DashboardModel {
  const segments = input.segments ?? [];
  const main = pickMainSegment(segments, now);
  const later = laterSegments(segments, main, now);

  const groups = input.memberships === null ? [] : dashboardGroups(input.memberships, now);
  const space = input.memberships === null ? 'unknown' : groups.length > 0 ? 'groups' : 'past';

  const past = input.past === null ? [] : sortPastFlights(input.past);

  const isEmpty =
    input.segments !== null &&
    input.memberships !== null &&
    input.past !== null &&
    main === null &&
    groups.length === 0 &&
    past.length === 0;

  return {
    main,
    later,
    space,
    groups,
    pastPreview: past.slice(0, PAST_PREVIEW_LIMIT),
    pastHasMore: past.length > PAST_PREVIEW_LIMIT,
    isEmpty,
  };
}
