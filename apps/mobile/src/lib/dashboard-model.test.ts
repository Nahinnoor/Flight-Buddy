/**
 * The rules the signed-in screens follow, pinned down case by case: which
 * flight is pinned, which groups get a card and in what order, what a group
 * countdown says (and that it agrees with the flight card), and when the
 * archived flights take the groups' place.
 */
import { describe, expect, it } from 'vitest';

import {
  buildDashboard,
  dashboardGroups,
  formatGroupCountdown,
  groupCountdown,
  groupCountdownText,
  groupLabel,
  groupsTabEntries,
  laterSegments,
  PAST_PREVIEW_LIMIT,
  pickMainSegment,
  sortPastFlights,
  type FlightRow,
  type LegTimes,
  type MembershipView,
  type SegmentView,
} from './dashboard-model';
import { countdownTo, departureAnchor } from './flight-display';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * HOUR).toISOString();

let counter = 0;

function flight(overrides: Partial<FlightRow> = {}): FlightRow {
  counter += 1;
  return {
    id: `f${counter}`,
    operating_carrier_iata: 'ZA',
    operating_flight_number: String(counter),
    departure_date_local: '2026-09-25',
    origin_iata: 'JFK',
    destination_iata: 'LAX',
    origin_tz: 'America/New_York',
    destination_tz: 'America/Los_Angeles',
    status: 'scheduled',
    tracking_tier: 'live',
    gate: null,
    terminal: null,
    scheduled_departure_utc: at(5),
    estimated_departure_utc: null,
    actual_departure_utc: null,
    scheduled_arrival_utc: at(11),
    estimated_arrival_utc: null,
    actual_arrival_utc: null,
    aircraft_reg: null,
    aircraft_model: null,
    next_poll_at: null,
    poll_lease_until: null,
    last_polled_at: null,
    poll_failure_count: 0,
    alert_subscription_id: null,
    alert_subscribed_at: null,
    raw_payload: null,
    distance_km: null,
    origin_country_code: null,
    destination_country_code: null,
    archived_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function seg(
  id: string,
  overrides: Partial<FlightRow> = {},
  extra: Partial<SegmentView> = {},
): SegmentView {
  return {
    segmentId: id,
    sequenceNumber: 1,
    tripId: 'trip-1',
    tripLabel: null,
    marketingCarrierIata: null,
    marketingFlightNumber: null,
    overrideNotes: null,
    flight: flight(overrides),
    ...extra,
  };
}

/** A departed-and-in-the-air leg: left 2 h ago, lands in 4 h. */
const airborne = (id: string) =>
  seg(id, {
    status: 'en_route',
    scheduled_departure_utc: at(-2),
    actual_departure_utc: at(-2),
    scheduled_arrival_utc: at(4),
  });

function leg(hoursFromNow: number, overrides: Partial<LegTimes> = {}): LegTimes {
  return {
    sequenceNumber: 1,
    scheduled_departure_utc: at(hoursFromNow),
    estimated_departure_utc: null,
    actual_departure_utc: null,
    scheduled_arrival_utc: at(hoursFromNow + 6),
    estimated_arrival_utc: null,
    actual_arrival_utc: null,
    status: 'scheduled',
    archived_at: null,
    ...overrides,
  };
}

function membership(overrides: Partial<MembershipView> = {}): MembershipView {
  counter += 1;
  return {
    membershipId: `m${counter}`,
    status: 'active',
    role: 'member',
    group: { id: `g${counter}`, name: `Group ${counter}`, destinationIata: 'LIS', archivedAt: null },
    tripId: null,
    legs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------- main ---

describe('pickMainSegment', () => {
  it('is null with no flights at all', () => {
    expect(pickMainSegment([], NOW)).toBeNull();
  });

  it('pins the soonest flight that has not landed', () => {
    const later = seg('later', { scheduled_departure_utc: at(48), scheduled_arrival_utc: at(52) });
    const soon = seg('soon', { scheduled_departure_utc: at(3), scheduled_arrival_utc: at(7) });
    expect(pickMainSegment([later, soon], NOW)?.segmentId).toBe('soon');
  });

  it('keeps a flight in the air pinned, ahead of the next departure', () => {
    const next = seg('next', { scheduled_departure_utc: at(1), scheduled_arrival_utc: at(3) });
    expect(pickMainSegment([next, airborne('air')], NOW)?.segmentId).toBe('air');
  });

  it('keeps a flight in the air pinned after its expected arrival has passed', () => {
    // Holding over the destination: the estimate is behind us, no touchdown yet.
    const holding = seg('holding', {
      status: 'en_route',
      scheduled_departure_utc: at(-6),
      actual_departure_utc: at(-6),
      scheduled_arrival_utc: at(-1),
    });
    const next = seg('next', { scheduled_departure_utc: at(2), scheduled_arrival_utc: at(4) });
    expect(pickMainSegment([holding, next], NOW)?.segmentId).toBe('holding');
  });

  it('moves to the next leg of a multi-leg trip once the current one lands', () => {
    const first = seg(
      'leg1',
      {
        status: 'landed',
        scheduled_departure_utc: at(-4),
        actual_departure_utc: at(-4),
        scheduled_arrival_utc: at(-1),
        actual_arrival_utc: at(-1),
      },
      { sequenceNumber: 1 },
    );
    const second = seg(
      'leg2',
      { scheduled_departure_utc: at(1), scheduled_arrival_utc: at(3) },
      { sequenceNumber: 2 },
    );
    expect(pickMainSegment([first, second], NOW)?.segmentId).toBe('leg2');
  });

  it('treats a recorded arrival as landed even when the status lags', () => {
    const down = seg('down', {
      status: 'en_route',
      scheduled_departure_utc: at(-4),
      actual_departure_utc: at(-4),
      scheduled_arrival_utc: at(-1),
      actual_arrival_utc: at(-1),
    });
    const next = seg('next', { scheduled_departure_utc: at(20), scheduled_arrival_utc: at(22) });
    expect(pickMainSegment([down, next], NOW)?.segmentId).toBe('next');
  });

  it('falls back to the most recent leg when every one has landed', () => {
    const landed = (id: string, dep: number) =>
      seg(id, {
        status: 'landed',
        scheduled_departure_utc: at(dep),
        scheduled_arrival_utc: at(dep + 1),
        actual_arrival_utc: at(dep + 1),
      });
    expect(pickMainSegment([landed('a', -8), landed('b', -3)], NOW)?.segmentId).toBe('b');
  });
});

describe('laterSegments', () => {
  it('lists the other legs still ahead, earliest first, without the pinned one', () => {
    const a = seg('a', { scheduled_departure_utc: at(2), scheduled_arrival_utc: at(4) });
    const b = seg('b', { scheduled_departure_utc: at(30), scheduled_arrival_utc: at(34) });
    const c = seg('c', { scheduled_departure_utc: at(10), scheduled_arrival_utc: at(12) });
    const main = pickMainSegment([a, b, c], NOW);
    expect(laterSegments([a, b, c], main, NOW).map((s) => s.segmentId)).toEqual(['c', 'b']);
  });

  it('drops legs that have landed', () => {
    const landed = seg('landed', {
      status: 'landed',
      scheduled_departure_utc: at(-5),
      actual_arrival_utc: at(-2),
    });
    const next = seg('next');
    expect(laterSegments([landed, next], next, NOW)).toEqual([]);
  });
});

// ----------------------------------------------------------- countdown ---

describe('groupLabel', () => {
  it('uses the name', () => {
    expect(groupLabel({ name: 'Lisbon crew', destinationIata: 'LIS' })).toBe('Lisbon crew');
  });

  it('falls back to the destination when the name is blank or whitespace', () => {
    expect(groupLabel({ name: '', destinationIata: 'CDG' })).toBe('CDG');
    expect(groupLabel({ name: '   ', destinationIata: 'cdg' })).toBe('CDG');
  });

  it('has a last resort when both are missing', () => {
    expect(groupLabel({ name: ' ', destinationIata: null })).toBe('Untitled group');
  });
});

describe('groupCountdown', () => {
  it('asks for a flight when the membership has no trip', () => {
    expect(groupCountdown([], NOW)).toEqual({ kind: 'no-flight' });
  });

  it('asks for a flight when every leg of the trip is archived', () => {
    const done = leg(-72, { archived_at: at(-60), status: 'landed', actual_arrival_utc: at(-66) });
    expect(groupCountdown([done], NOW)).toEqual({ kind: 'no-flight' });
  });

  it('counts down to the first leg, not a later one', () => {
    const second = leg(30, { sequenceNumber: 2 });
    const first = leg(20, { sequenceNumber: 1 });
    expect(groupCountdown([second, first], NOW)).toEqual({ kind: 'upcoming', targetUtc: at(20) });
  });

  it('uses the same departure anchor as the flight card', () => {
    const delayed = leg(20, { estimated_departure_utc: at(22) });
    const target = groupCountdown([delayed], NOW);
    const anchor = departureAnchor({
      actualDepartureUtc: delayed.actual_departure_utc,
      estimatedDepartureUtc: delayed.estimated_departure_utc,
      scheduledDepartureUtc: delayed.scheduled_departure_utc,
    });
    expect(target).toEqual({ kind: 'upcoming', targetUtc: anchor });
    expect(anchor).toBe(at(22));
  });

  it('is under way once the first leg has left, even if its row is archived', () => {
    const first = leg(-8, {
      sequenceNumber: 1,
      status: 'landed',
      actual_departure_utc: at(-8),
      actual_arrival_utc: at(-3),
      archived_at: at(-2),
    });
    const second = leg(4, { sequenceNumber: 2 });
    expect(groupCountdown([first, second], NOW)).toEqual({ kind: 'underway' });
  });

  it('is under way while the first leg is in the air', () => {
    const inAir = leg(-1, { status: 'en_route', actual_departure_utc: at(-1) });
    expect(groupCountdown([inAir], NOW)).toEqual({ kind: 'underway' });
  });

  it('says landed when every remaining leg is down but not yet archived', () => {
    const down = leg(-6, { status: 'landed', actual_arrival_utc: at(-1) });
    expect(groupCountdown([down], NOW)).toEqual({ kind: 'arrived' });
  });

  it('knows when a leg has no time at all', () => {
    const unknown = leg(0, { scheduled_departure_utc: null, scheduled_arrival_utc: null });
    expect(groupCountdown([unknown], NOW)).toEqual({ kind: 'time-unknown' });
  });
});

describe('formatGroupCountdown', () => {
  it('shows whole days a day or more out', () => {
    expect(formatGroupCountdown(at(24 * 9 + 5), NOW)).toBe('in 9 days');
    expect(formatGroupCountdown(at(47.9), NOW)).toBe('in 1 day');
  });

  it('switches to hours and minutes at the 24-hour boundary', () => {
    expect(formatGroupCountdown(at(24), NOW)).toBe('in 1 day');
    const justInside = new Date(NOW.getTime() + 24 * HOUR - 60_000).toISOString();
    expect(formatGroupCountdown(justInside, NOW)).toBe('in 23h 59m');
  });

  it('shows minutes alone in the last hour, then "under a minute"', () => {
    expect(formatGroupCountdown(at(0.75), NOW)).toBe('in 45m');
    expect(formatGroupCountdown(new Date(NOW.getTime() + 30_000).toISOString(), NOW)).toBe(
      'in under a minute',
    );
  });

  it('never counts backwards', () => {
    expect(formatGroupCountdown(at(-1), NOW)).toBe('Departing now');
  });

  it('agrees with the flight card to the day and to the minute', () => {
    // The card reads "in 2d 23h"; the group must read 2 days, not 3.
    const target = at(2 * 24 + 23.5);
    expect(countdownTo(target, NOW)?.label).toBe('in 2d 23h');
    expect(formatGroupCountdown(target, NOW)).toBe('in 2 days');
    // Inside 24 h both show the same hours and minutes.
    const close = at(5 + 12 / 60);
    expect(countdownTo(close, NOW)?.label).toBe('in 5h 12m');
    expect(formatGroupCountdown(close, NOW)).toBe('in 5h 12m');
  });
});

describe('groupCountdownText', () => {
  it('reads as a sentence for every state', () => {
    expect(groupCountdownText({ kind: 'no-flight' }, NOW)).toBe('Add your flight');
    expect(groupCountdownText({ kind: 'upcoming', targetUtc: at(72) }, NOW)).toBe('Departs in 3 days');
    expect(groupCountdownText({ kind: 'upcoming', targetUtc: at(3) }, NOW)).toBe('Departs in 3h 0m');
    expect(groupCountdownText({ kind: 'underway' }, NOW)).toBe('On your way');
    expect(groupCountdownText({ kind: 'arrived' }, NOW)).toBe('Landed');
    expect(groupCountdownText({ kind: 'time-unknown' }, NOW)).toBe('Departure time unknown');
  });
});

// -------------------------------------------------------------- groups ---

describe('dashboardGroups', () => {
  it('gives a card to active groups with and without a trip', () => {
    const withTrip = membership({ tripId: 't', legs: [leg(50)] });
    const withoutTrip = membership();
    const cards = dashboardGroups([withoutTrip, withTrip], NOW);
    expect(cards.map((c) => c.membershipId)).toEqual([withTrip.membershipId, withoutTrip.membershipId]);
    expect(cards[1]?.countdown).toEqual({ kind: 'no-flight' });
  });

  it('leaves out pending requests, removed memberships and archived groups', () => {
    const pending = membership({ status: 'pending', group: null });
    const removed = membership({ status: 'removed' });
    const archived = membership({
      group: { id: 'g', name: 'Old trip', destinationIata: 'MEX', archivedAt: at(-1000) },
    });
    expect(dashboardGroups([pending, removed, archived], NOW)).toEqual([]);
  });

  it('orders soonest departure first, trips under way ahead of everything, no flight last', () => {
    const far = membership({ group: { id: 'a', name: 'Far', destinationIata: null, archivedAt: null }, legs: [leg(24 * 20)] });
    const near = membership({ group: { id: 'b', name: 'Near', destinationIata: null, archivedAt: null }, legs: [leg(10)] });
    const none = membership({ group: { id: 'c', name: 'Aardvark', destinationIata: null, archivedAt: null } });
    const going = membership({
      group: { id: 'd', name: 'Going', destinationIata: null, archivedAt: null },
      legs: [leg(-1, { status: 'en_route', actual_departure_utc: at(-1) })],
    });
    expect(dashboardGroups([none, far, near, going], NOW).map((c) => c.label)).toEqual([
      'Going',
      'Near',
      'Far',
      'Aardvark',
    ]);
  });

  it('breaks ties by label', () => {
    const b = membership({ group: { id: 'b', name: 'Beta', destinationIata: null, archivedAt: null } });
    const a = membership({ group: { id: 'a', name: 'alpha', destinationIata: null, archivedAt: null } });
    expect(dashboardGroups([b, a], NOW).map((c) => c.label)).toEqual(['alpha', 'Beta']);
  });
});

describe('groupsTabEntries', () => {
  it('lists active groups, then pending requests as waiting for approval', () => {
    const active = membership({ role: 'owner', legs: [leg(30)] });
    const pending = membership({ status: 'pending', group: null });
    const entries = groupsTabEntries([pending, active], NOW);
    expect(entries.map((e) => [e.status, e.detail])).toEqual([
      ['active', 'Departs in 1 day'],
      ['pending', 'Waiting for approval'],
    ]);
    expect(entries[0]?.isOwner).toBe(true);
    expect(entries[1]?.label).toBe('Join request');
  });

  it('names a pending group when RLS does let it through', () => {
    const pending = membership({
      status: 'pending',
      group: { id: 'g', name: '', destinationIata: 'OPO', archivedAt: null },
    });
    expect(groupsTabEntries([pending], NOW)[0]?.label).toBe('OPO');
  });

  it('leaves archived groups and removed memberships out', () => {
    const archived = membership({
      group: { id: 'g', name: 'Old', destinationIata: null, archivedAt: at(-10) },
    });
    const removed = membership({ status: 'removed' });
    expect(groupsTabEntries([archived, removed], NOW)).toEqual([]);
  });
});

// ----------------------------------------------------------- dashboard ---

describe('buildDashboard', () => {
  const past = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      seg(`p${i}`, {
        status: 'landed',
        scheduled_departure_utc: at(-24 * (i + 1)),
        actual_arrival_utc: at(-24 * (i + 1) + 3),
        archived_at: at(-24 * (i + 1) + 4),
      }),
    );

  it('is empty — and says so — with no flights, no groups and no history', () => {
    const model = buildDashboard({ segments: [], memberships: [], past: [] }, NOW);
    expect(model.isEmpty).toBe(true);
    expect(model.main).toBeNull();
    expect(model.space).toBe('past');
    expect(model.pastPreview).toEqual([]);
  });

  it('is not "empty" while anything is still loading', () => {
    expect(buildDashboard({ segments: [], memberships: null, past: [] }, NOW).isEmpty).toBe(false);
    expect(buildDashboard({ segments: null, memberships: [], past: [] }, NOW).isEmpty).toBe(false);
  });

  it('pins the one flight in the air', () => {
    const model = buildDashboard({ segments: [airborne('air')], memberships: [], past: [] }, NOW);
    expect(model.main?.segmentId).toBe('air');
    expect(model.later).toEqual([]);
    expect(model.isEmpty).toBe(false);
  });

  it('fills the space with groups when there is an active one', () => {
    const model = buildDashboard(
      { segments: [], memberships: [membership({ legs: [leg(5)] })], past: past(3) },
      NOW,
    );
    expect(model.space).toBe('groups');
    expect(model.groups).toHaveLength(1);
    expect(model.isEmpty).toBe(false);
  });

  it('shows past flights instead when the only membership is pending', () => {
    const model = buildDashboard(
      { segments: [], memberships: [membership({ status: 'pending', group: null })], past: past(2) },
      NOW,
    );
    expect(model.space).toBe('past');
    expect(model.groups).toEqual([]);
    expect(model.pastPreview.map((s) => s.segmentId)).toEqual(['p0', 'p1']);
  });

  it('shows past flights when the only group is archived', () => {
    const archived = membership({
      group: { id: 'g', name: 'Old', destinationIata: null, archivedAt: at(-100) },
    });
    expect(buildDashboard({ segments: [], memberships: [archived], past: past(1) }, NOW).space).toBe(
      'past',
    );
  });

  it('caps the past preview, most recent first, and says there is more', () => {
    const model = buildDashboard(
      { segments: [], memberships: [], past: [...past(PAST_PREVIEW_LIMIT + 2)].reverse() },
      NOW,
    );
    expect(model.pastPreview).toHaveLength(PAST_PREVIEW_LIMIT);
    expect(model.pastPreview[0]?.segmentId).toBe('p0');
    expect(model.pastHasMore).toBe(true);
  });

  it('does not decide groups-or-past until memberships have loaded', () => {
    expect(buildDashboard({ segments: [], memberships: null, past: past(1) }, NOW).space).toBe(
      'unknown',
    );
  });
});

describe('sortPastFlights', () => {
  it('orders most recent first with unknown times last', () => {
    const old = seg('old', { scheduled_departure_utc: at(-500) });
    const recent = seg('recent', { scheduled_departure_utc: at(-10) });
    const unknown = seg('unknown', { scheduled_departure_utc: null });
    expect(sortPastFlights([unknown, old, recent]).map((s) => s.segmentId)).toEqual([
      'recent',
      'old',
      'unknown',
    ]);
  });
});
