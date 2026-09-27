/**
 * The Profile tab's numbers, pinned down case by case: which flights count as
 * taken, the lifetime totals and home base, the frequent-flyer level, the
 * "flying with friends" insights (this year, actual landings only), the
 * passport's machine-readable lines and the flight-log row wording.
 */
import { describe, expect, it } from 'vitest';

import {
  arrivalLeg,
  buildFriendsStats,
  buildProfileStats,
  currentYear,
  firstName,
  flightDurationMinutes,
  flightLogEntry,
  flightOutcome,
  flightsTaken,
  formatCompact,
  formatMemberSince,
  friendsInsights,
  initialsOf,
  isFlightTaken,
  levelFor,
  LEVELS,
  MRZ_LENGTH,
  mrzLines,
  type GroupMemberTrip,
  type GroupTripInput,
  type OwnSegment,
  type StatsFlight,
} from './profile-stats';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * HOUR).toISOString();
const NY = 'America/New_York';

let counter = 0;

function flight(overrides: Partial<StatsFlight> = {}): StatsFlight {
  counter += 1;
  return {
    id: `f${counter}`,
    status: 'landed',
    operating_carrier_iata: 'ZA',
    operating_flight_number: String(counter),
    departure_date_local: '2026-09-20',
    origin_iata: 'JFK',
    destination_iata: 'LAX',
    origin_tz: NY,
    scheduled_departure_utc: at(-30),
    estimated_departure_utc: null,
    actual_departure_utc: at(-30),
    scheduled_arrival_utc: at(-24),
    estimated_arrival_utc: null,
    actual_arrival_utc: at(-24),
    distance_km: 3983,
    origin_country_code: 'US',
    destination_country_code: 'US',
    ...overrides,
  };
}

function seg(overrides: Partial<StatsFlight> = {}, extra: Partial<OwnSegment> = {}): OwnSegment {
  const f = flight(overrides);
  return {
    segmentId: `s-${f.id}`,
    sequenceNumber: 1,
    marketingCarrierIata: null,
    marketingFlightNumber: null,
    flight: f,
    ...extra,
  };
}

// ------------------------------------------------------------ taken ---

describe('isFlightTaken', () => {
  it('counts a landed flight even with no times', () => {
    expect(
      isFlightTaken(
        flight({ scheduled_arrival_utc: null, actual_arrival_utc: null, status: 'landed' }),
        NOW,
      ),
    ).toBe(true);
  });

  it('never counts a cancelled flight, even one whose arrival passed', () => {
    expect(isFlightTaken(flight({ status: 'cancelled' }), NOW)).toBe(false);
  });

  it('excludes a future flight and one in the air', () => {
    expect(
      isFlightTaken(
        flight({ status: 'scheduled', scheduled_arrival_utc: at(5), actual_arrival_utc: null }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isFlightTaken(
        flight({ status: 'en_route', scheduled_arrival_utc: at(1), actual_arrival_utc: null }),
        NOW,
      ),
    ).toBe(false);
  });

  it('uses actual, then estimated, then scheduled arrival', () => {
    // Estimated says still flying, even though the schedule has passed.
    expect(
      isFlightTaken(
        flight({
          status: 'en_route',
          actual_arrival_utc: null,
          estimated_arrival_utc: at(1),
          scheduled_arrival_utc: at(-1),
        }),
        NOW,
      ),
    ).toBe(false);
    // A scheduled-tier row that never reported: its window passed.
    expect(
      isFlightTaken(
        flight({ status: 'scheduled', actual_arrival_utc: null, scheduled_arrival_utc: at(-1) }),
        NOW,
      ),
    ).toBe(true);
  });

  it('counts a diversion', () => {
    expect(isFlightTaken(flight({ status: 'diverted' }), NOW)).toBe(true);
  });

  it('does not count a flight with no arrival time at all unless landed', () => {
    expect(
      isFlightTaken(
        flight({
          status: 'unknown',
          actual_arrival_utc: null,
          estimated_arrival_utc: null,
          scheduled_arrival_utc: null,
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe('flightsTaken', () => {
  it('dedupes a flight on two of your trips and orders most recent first', () => {
    const shared = flight({ actual_departure_utc: at(-10), actual_arrival_utc: at(-5) });
    const older = seg({ actual_departure_utc: at(-100), actual_arrival_utc: at(-95) });
    const a: OwnSegment = { segmentId: 'a', sequenceNumber: 1, marketingCarrierIata: null, marketingFlightNumber: null, flight: shared };
    const b: OwnSegment = { ...a, segmentId: 'b' };
    const taken = flightsTaken([older, a, b], NOW);
    expect(taken.map((s) => s.segmentId)).toEqual(['a', older.segmentId]);
  });
});

// ------------------------------------------------------------ totals ---

describe('buildProfileStats', () => {
  it('is all zeros and level 1 for an empty account', () => {
    const stats = buildProfileStats([], NOW);
    expect(stats).toMatchObject({
      flights: 0,
      airports: 0,
      countries: 0,
      miles: 0,
      homeBase: null,
      taken: [],
    });
    expect(stats.level).toEqual({
      index: 1,
      name: 'Boarding',
      nextName: 'Taxi',
      milesToNext: 1000,
      progress: 0,
    });
  });

  it('counts only flights taken, and counts a duplicated flight once', () => {
    const dup = flight({ distance_km: 1000 });
    const stats = buildProfileStats(
      [
        { segmentId: 'x', sequenceNumber: 1, marketingCarrierIata: null, marketingFlightNumber: null, flight: dup },
        { segmentId: 'y', sequenceNumber: 1, marketingCarrierIata: null, marketingFlightNumber: null, flight: dup },
        seg({ status: 'cancelled', distance_km: 9000 }),
        seg({ status: 'scheduled', scheduled_arrival_utc: at(20), actual_arrival_utc: null, distance_km: 9000 }),
      ],
      NOW,
    );
    expect(stats.flights).toBe(1);
    expect(stats.miles).toBe(Math.round(1000 * 0.621371));
  });

  it('counts airports and countries distinctly, and rounds miles once at the end', () => {
    const stats = buildProfileStats(
      [
        seg({ origin_iata: 'JFK', destination_iata: 'LHR', origin_country_code: 'US', destination_country_code: 'GB', distance_km: 1 }),
        seg({ origin_iata: 'LHR', destination_iata: 'CDG', origin_country_code: 'GB', destination_country_code: 'fr', distance_km: 1 }),
        seg({ origin_iata: 'CDG', destination_iata: 'JFK', origin_country_code: 'FR', destination_country_code: 'US', distance_km: 1 }),
      ],
      NOW,
    );
    expect(stats.airports).toBe(3);
    expect(stats.countries).toBe(3);
    // 3 × 0.621371 = 1.86 → 2; per-flight rounding would give 3.
    expect(stats.miles).toBe(2);
  });

  it('counts a flight with no distance or country as a flight and its airports only', () => {
    const stats = buildProfileStats(
      [
        seg({ origin_iata: 'BOS', destination_iata: 'DTW', distance_km: null, origin_country_code: null, destination_country_code: null }),
        seg({ origin_iata: 'JFK', destination_iata: 'LAX', distance_km: 3983 }),
      ],
      NOW,
    );
    expect(stats.flights).toBe(2);
    expect(stats.airports).toBe(4);
    expect(stats.countries).toBe(1);
    expect(stats.miles).toBe(Math.round(3983 * 0.621371));
  });
});

describe('home base', () => {
  it('is the most frequent origin', () => {
    const stats = buildProfileStats(
      [
        seg({ origin_iata: 'SFO', actual_departure_utc: at(-10) }),
        seg({ origin_iata: 'JFK', actual_departure_utc: at(-100) }),
        seg({ origin_iata: 'JFK', actual_departure_utc: at(-200) }),
      ],
      NOW,
    );
    expect(stats.homeBase).toBe('JFK');
  });

  it('breaks a tie by the origin used most recently', () => {
    const stats = buildProfileStats(
      [
        seg({ origin_iata: 'JFK', actual_departure_utc: at(-300) }),
        seg({ origin_iata: 'LAX', actual_departure_utc: at(-50) }),
        seg({ origin_iata: 'JFK', actual_departure_utc: at(-100) }),
        seg({ origin_iata: 'LAX', actual_departure_utc: at(-400) }),
      ],
      NOW,
    );
    expect(stats.homeBase).toBe('LAX');
  });
});

// ------------------------------------------------------------ levels ---

describe('levelFor', () => {
  it('has eight levels at the agreed thresholds', () => {
    expect(LEVELS.map((l) => [l.index, l.name, l.minMiles])).toEqual([
      [1, 'Boarding', 0],
      [2, 'Taxi', 1000],
      [3, 'Takeoff', 5000],
      [4, 'Climb', 15000],
      [5, 'Cruising Altitude', 30000],
      [6, 'Jet Stream', 50000],
      [7, 'Stratosphere', 75000],
      [8, 'Orbit', 100000],
    ]);
  });

  it('places the design example: 42,810 mi is level 5, 7,190 mi to Jet Stream, 64%', () => {
    const level = levelFor(42_810);
    expect(level.index).toBe(5);
    expect(level.name).toBe('Cruising Altitude');
    expect(level.nextName).toBe('Jet Stream');
    expect(level.milesToNext).toBe(7_190);
    expect(level.progress).toBeCloseTo(0.6405, 3);
  });

  it('crosses a threshold exactly on it', () => {
    expect(levelFor(999).index).toBe(1);
    expect(levelFor(1000).index).toBe(2);
    expect(levelFor(1000).progress).toBe(0);
  });

  it('stops at the top level with no next level', () => {
    expect(levelFor(100_000)).toEqual({ index: 8, name: 'Orbit', nextName: null, milesToNext: null, progress: 1 });
    expect(levelFor(250_000).index).toBe(8);
  });

  it('treats nonsense as zero', () => {
    expect(levelFor(-5).index).toBe(1);
    expect(levelFor(Number.NaN).index).toBe(1);
  });
});

// ------------------------------------------------------------ formatting ---

describe('formatting', () => {
  it('compacts at ten thousand', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(9_876)).toBe('9,876');
    expect(formatCompact(10_000)).toBe('10k');
    expect(formatCompact(42_810)).toBe('42.8k');
    expect(formatCompact(99_960)).toBe('100k');
    expect(formatCompact(999_960)).toBe('1M');
    expect(formatCompact(1_234_567)).toBe('1.2M');
  });

  it('formats member-since in the device zone', () => {
    expect(formatMemberSince('2025-03-14T15:00:00.000Z', NY)).toBe('Mar 2025');
    // 1 April 02:00 UTC is still 31 March in New York.
    expect(formatMemberSince('2025-04-01T02:00:00.000Z', NY)).toBe('Mar 2025');
    expect(formatMemberSince('nonsense', NY)).toBeNull();
  });

  it('takes initials and first names from untrusted names without breaking them', () => {
    expect(initialsOf('Jordan Lee')).toBe('JL');
    expect(initialsOf('  priya   van der Berg ')).toBe('PB');
    expect(initialsOf('Cher')).toBe('C');
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('😀 Smile')).toBe('😀S');
    expect(firstName('Marcus Reed')).toBe('Marcus');
    expect(firstName('   ')).toBe('Someone');
  });
});

describe('mrzLines', () => {
  const totals = { flights: 23, airports: 11, countries: 4, miles: 42810, level: 5 };

  it('matches the design for Jordan Lee', () => {
    const [one, two] = mrzLines('Jordan Lee', totals);
    expect(one).toBe('P<FBYLEE<<JORDAN'.padEnd(MRZ_LENGTH, '<'));
    expect(two).toBe('23FLT<11APT<4CTY<42810MI<LVL5'.padEnd(MRZ_LENGTH, '<'));
  });

  it('keeps only A-Z, drops accents, and is always exactly 44 characters', () => {
    const [one] = mrzLines("José O'Brien-Smith 3rd", totals);
    expect(one).toMatch(/^[A-Z<]{44}$/);
    expect(one.startsWith('P<FBY<RD<<JOSE<O<BRIEN<SMITH')).toBe(true);
    const [long] = mrzLines('A'.repeat(80), totals);
    expect(long).toHaveLength(MRZ_LENGTH);
    const [empty] = mrzLines('', totals);
    expect(empty).toBe('P<FBY'.padEnd(MRZ_LENGTH, '<'));
  });
});

// ------------------------------------------------------------ flight log ---

describe('flightOutcome', () => {
  const landed = (lateMin: number) =>
    flight({
      scheduled_arrival_utc: at(-24),
      actual_arrival_utc: new Date(new Date(at(-24)).getTime() + lateMin * MIN).toISOString(),
    });

  it('reads early, on time and delayed by the actual arrival', () => {
    expect(flightOutcome(landed(-12))).toEqual({ label: '12m early', tone: 'positive' });
    expect(flightOutcome(landed(-5))).toEqual({ label: '5m early', tone: 'positive' });
    expect(flightOutcome(landed(-4))).toEqual({ label: 'On time', tone: 'positive' });
    expect(flightOutcome(landed(15))).toEqual({ label: 'On time', tone: 'positive' });
    expect(flightOutcome(landed(25))).toEqual({ label: 'Delayed 25m', tone: 'warning' });
    expect(flightOutcome(landed(110))).toEqual({ label: 'Delayed 1h 50m', tone: 'warning' });
  });

  it('says Cancelled, Diverted, or plain Landed with no actual arrival', () => {
    expect(flightOutcome(flight({ status: 'cancelled' }))).toEqual({ label: 'Cancelled', tone: 'critical' });
    expect(flightOutcome(flight({ status: 'diverted' }))).toEqual({ label: 'Diverted', tone: 'warning' });
    expect(flightOutcome(flight({ actual_arrival_utc: null }))).toEqual({ label: 'Landed', tone: 'neutral' });
  });
});

describe('flightLogEntry', () => {
  it('shows the typed number, the origin-local date and the actual duration', () => {
    const entry = flightLogEntry(
      seg(
        {
          operating_carrier_iata: 'ZK',
          operating_flight_number: '77',
          origin_iata: 'JFK',
          destination_iata: 'LAX',
          origin_tz: NY,
          // 23:30 on 6 Sep in New York is already 7 Sep in UTC.
          departure_date_local: '2026-09-06',
          scheduled_departure_utc: '2026-09-07T03:30:00.000Z',
          actual_departure_utc: '2026-09-07T03:30:00.000Z',
          scheduled_arrival_utc: '2026-09-07T09:00:00.000Z',
          actual_arrival_utc: '2026-09-07T08:50:00.000Z',
        },
        { marketingCarrierIata: 'ZM', marketingFlightNumber: '1915' },
      ),
    );
    expect(entry.route).toBe('JFK → LAX');
    expect(entry.meta).toBe('Sep 6 · ZM 1915 · 5h 20m');
    expect(entry.pill).toEqual({ label: '10m early', tone: 'positive' });
    expect(entry.accessibilityLabel).toContain('JFK to LAX');
  });

  it('falls back to the operating number and the scheduled duration', () => {
    const f = flight({
      operating_carrier_iata: 'ZK',
      operating_flight_number: '8',
      departure_date_local: '2026-09-20',
      scheduled_departure_utc: '2026-09-20T12:00:00.000Z',
      actual_departure_utc: null,
      scheduled_arrival_utc: '2026-09-20T13:32:00.000Z',
      actual_arrival_utc: null,
    });
    expect(flightDurationMinutes(f)).toBe(92);
    expect(flightLogEntry({ segmentId: 's', sequenceNumber: 1, marketingCarrierIata: null, marketingFlightNumber: null, flight: f }).meta).toBe(
      'Sep 20 · ZK 8 · 1h 32m',
    );
  });

  it('omits an unknown duration rather than showing 0m', () => {
    const f = flight({ actual_departure_utc: null, scheduled_departure_utc: null });
    expect(flightDurationMinutes(f)).toBeNull();
    expect(flightLogEntry({ segmentId: 's', sequenceNumber: 1, marketingCarrierIata: null, marketingFlightNumber: null, flight: f }).meta).not.toContain('m ·');
  });
});

// ------------------------------------------------------------ friends ---

const THIS_YEAR = '2026-06-10';
const LAND = Date.parse('2026-06-10T20:00:00.000Z');
const landAt = (offsetMin: number) => new Date(LAND + offsetMin * MIN).toISOString();

function member(
  travelerId: string,
  displayName: string,
  landing: { offsetMin: number | null; airport?: string; date?: string } | null,
  isSelf = false,
): GroupMemberTrip {
  return {
    travelerId,
    isSelf,
    displayName,
    legs:
      landing === null
        ? []
        : [
            {
              sequenceNumber: 1,
              destinationIata: landing.airport ?? 'LAX',
              departureDateLocal: landing.date ?? THIS_YEAR,
              actualArrivalUtc: landing.offsetMin === null ? null : landAt(landing.offsetMin),
            },
          ],
  };
}

function group(id: string, members: GroupMemberTrip[], destinationIata: string | null = 'LAX'): GroupTripInput {
  return { groupId: id, destinationIata, members };
}

const me = (offsetMin: number | null, extra: { airport?: string; date?: string } = {}) =>
  member('me', 'Sam Rivera', { offsetMin, ...extra }, true);

describe('arrivalLeg', () => {
  const legs = [
    { sequenceNumber: 2, destinationIata: 'LAX', departureDateLocal: THIS_YEAR, actualArrivalUtc: null },
    { sequenceNumber: 3, destinationIata: 'SAN', departureDateLocal: THIS_YEAR, actualArrivalUtc: null },
    { sequenceNumber: 1, destinationIata: 'ORD', departureDateLocal: THIS_YEAR, actualArrivalUtc: null },
  ];

  it('is the first leg into the group destination', () => {
    expect(arrivalLeg(legs, 'lax')?.sequenceNumber).toBe(2);
  });

  it('is the last leg with no destination set, or none matching', () => {
    expect(arrivalLeg(legs, null)?.sequenceNumber).toBe(3);
    expect(arrivalLeg(legs, 'HND')?.sequenceNumber).toBe(3);
  });

  it('is nothing with no trip', () => {
    expect(arrivalLeg([], 'LAX')).toBeNull();
  });
});

describe('buildFriendsStats', () => {
  it('is empty with no groups', () => {
    const stats = buildFriendsStats([], NOW, NY);
    expect(stats).toEqual({
      groupTrips: 0,
      buddies: [],
      mostInSync: null,
      welcomeCommittee: null,
      longestWait: null,
    });
  });

  it('needs you and one other member landed for a group trip', () => {
    const stats = buildFriendsStats(
      [
        // You never landed: not a group trip.
        group('a', [me(null), member('p', 'Priya Shah', { offsetMin: 5 })]),
        // Nobody else landed: not a group trip.
        group('b', [me(0), member('m', 'Marcus Reed', { offsetMin: null }), member('x', 'No Trip', null)]),
        // You are not in it.
        group('c', [member('p', 'Priya Shah', { offsetMin: 0 }), member('m', 'Marcus Reed', { offsetMin: 3 })]),
      ],
      NOW,
      NY,
    );
    expect(stats.groupTrips).toBe(0);
    expect(stats.buddies).toEqual([]);
  });

  it('counts unclaimed travellers as buddies and ignores members who never landed', () => {
    const stats = buildFriendsStats(
      [
        group('a', [
          me(0),
          member('p', 'Priya Shah', { offsetMin: 10 }),
          member('u', 'Hana Unclaimed', { offsetMin: 30 }), // user_id NULL: still a buddy
          member('d', 'Dev Kapoor', { offsetMin: null }),
        ]),
        group('b', [me(0), member('p', 'Priya Shah', { offsetMin: 3 })]),
      ],
      NOW,
      NY,
    );
    expect(stats.groupTrips).toBe(2);
    expect(stats.buddies.map((b) => [b.firstName, b.sharedTrips])).toEqual([
      ['Priya', 2],
      ['Hana', 1],
    ]);
    expect(stats.buddies[0]?.initials).toBe('PS');
  });

  it('only counts this year, by the local departure date', () => {
    const lastYear = { date: '2025-12-31' };
    const stats = buildFriendsStats(
      [
        // A 23:30 departure on 31 Dec (local) landing in January: last year's trip.
        group('nye', [me(0, lastYear), member('p', 'Priya Shah', { offsetMin: 5, ...lastYear })]),
        group('now', [me(0), member('m', 'Marcus Reed', { offsetMin: 5 })]),
      ],
      NOW,
      NY,
    );
    expect(stats.groupTrips).toBe(1);
    expect(stats.buddies.map((b) => b.firstName)).toEqual(['Marcus']);
  });

  it('reads the year on the device, not in UTC', () => {
    const newYearsEve = new Date('2027-01-01T03:00:00.000Z'); // 22:00 on 31 Dec in New York
    expect(currentYear(newYearsEve, NY)).toBe('2026');
    expect(currentYear(newYearsEve, 'UTC')).toBe('2027');
  });

  describe('most in sync', () => {
    it('picks the buddy with the most landings within 20 minutes, same airport', () => {
      const stats = buildFriendsStats(
        [
          group('a', [me(0), member('p', 'Priya Shah', { offsetMin: 12 }), member('m', 'Marcus Reed', { offsetMin: -20 })]),
          group('b', [me(0), member('p', 'Priya Shah', { offsetMin: -8 }), member('m', 'Marcus Reed', { offsetMin: 21 })]),
        ],
        NOW,
        NY,
      );
      expect(stats.mostInSync).toEqual({ firstName: 'Priya', times: 2 });
      expect(friendsInsights(stats).mostInSync).toEqual({
        title: 'Most in sync: Priya',
        detail: 'You landed within 20 minutes of each other 2 times',
      });
    });

    it('breaks a tie by the smaller total gap', () => {
      const stats = buildFriendsStats(
        [group('a', [me(0), member('p', 'Priya Shah', { offsetMin: 15 }), member('m', 'Marcus Reed', { offsetMin: -4 })])],
        NOW,
        NY,
      );
      expect(stats.mostInSync).toEqual({ firstName: 'Marcus', times: 1 });
      expect(friendsInsights(stats).mostInSync?.detail).toBe(
        'You landed within 20 minutes of each other 1 time',
      );
    });

    it('ignores landings at another airport', () => {
      const stats = buildFriendsStats(
        [group('a', [me(0), member('p', 'Priya Shah', { offsetMin: 2, airport: 'BUR' })])],
        NOW,
        NY,
      );
      expect(stats.groupTrips).toBe(1);
      expect(stats.mostInSync).toBeNull();
      expect(friendsInsights(stats).mostInSync).toBeNull();
    });
  });

  describe('welcome committee', () => {
    it('counts trips where you landed strictly first', () => {
      const stats = buildFriendsStats(
        [
          group('a', [me(0), member('p', 'Priya Shah', { offsetMin: 1 })]),
          group('b', [me(0), member('p', 'Priya Shah', { offsetMin: 0 })]), // a tie is not first
          group('c', [me(0), member('p', 'Priya Shah', { offsetMin: -30 })]),
        ],
        NOW,
        NY,
      );
      expect(stats.welcomeCommittee).toEqual({ first: 1, total: 3 });
      expect(friendsInsights(stats).welcomeCommittee?.detail).toBe('First to land on 1 of 3 group trips');
    });

    it('ignores members who never landed and is hidden at zero', () => {
      const first = buildFriendsStats(
        [group('a', [me(0), member('p', 'Priya Shah', { offsetMin: 5 }), member('d', 'Dev Kapoor', { offsetMin: null })])],
        NOW,
        NY,
      );
      expect(first.welcomeCommittee).toEqual({ first: 1, total: 1 });
      expect(friendsInsights(first).welcomeCommittee?.detail).toBe('First to land on 1 of 1 group trip');

      const never = buildFriendsStats(
        [group('a', [me(10), member('p', 'Priya Shah', { offsetMin: 5 })])],
        NOW,
        NY,
      );
      expect(never.welcomeCommittee).toBeNull();
    });
  });

  describe('longest wait', () => {
    it('is the longest later landing at your airport, 5 minutes to 12 hours', () => {
      const stats = buildFriendsStats(
        [
          group('a', [
            me(0),
            member('m', 'Marcus Reed', { offsetMin: 100 }),
            member('o', 'Omar Said', { offsetMin: 12 * 60 + 1 }), // over 12 h: a different day
            member('e', 'Early Bird', { offsetMin: -300 }), // they waited for you, not you for them
            member('b', 'Bur Bank', { offsetMin: 200, airport: 'BUR' }), // another airport
          ]),
          group('b', [me(0), member('p', 'Priya Shah', { offsetMin: 4 })]), // under 5 min
        ],
        NOW,
        NY,
      );
      expect(stats.longestWait).toEqual({ minutes: 100, airport: 'LAX', firstName: 'Marcus' });
      expect(friendsInsights(stats).longestWait).toEqual({
        title: 'Longest wait',
        detail: '1h 40m at LAX until Marcus landed',
      });
    });

    it('includes exactly 5 minutes and exactly 12 hours', () => {
      const five = buildFriendsStats([group('a', [me(0), member('p', 'Priya Shah', { offsetMin: 5 })])], NOW, NY);
      expect(five.longestWait?.minutes).toBe(5);
      const twelve = buildFriendsStats([group('a', [me(0), member('p', 'Priya Shah', { offsetMin: 720 })])], NOW, NY);
      expect(twelve.longestWait?.minutes).toBe(720);
    });

    it('is hidden with nothing in range', () => {
      const stats = buildFriendsStats([group('a', [me(0), member('p', 'Priya Shah', { offsetMin: 3 })])], NOW, NY);
      expect(stats.longestWait).toBeNull();
      expect(friendsInsights(stats).longestWait).toBeNull();
    });
  });

  it('uses each member’s last leg when the group has no destination', () => {
    const twoLegs = (id: string, name: string, self: boolean, offsetMin: number): GroupMemberTrip => ({
      travelerId: id,
      isSelf: self,
      displayName: name,
      legs: [
        { sequenceNumber: 2, destinationIata: 'OPO', departureDateLocal: THIS_YEAR, actualArrivalUtc: landAt(offsetMin) },
        { sequenceNumber: 1, destinationIata: 'LIS', departureDateLocal: THIS_YEAR, actualArrivalUtc: landAt(-300) },
      ],
    });
    const stats = buildFriendsStats(
      [group('a', [twoLegs('me', 'Sam Rivera', true, 0), twoLegs('p', 'Priya Shah', false, 30)], null)],
      NOW,
      NY,
    );
    expect(stats.longestWait).toEqual({ minutes: 30, airport: 'OPO', firstName: 'Priya' });
  });

  it('counts the same buddy once across groups and within a group', () => {
    const stats = buildFriendsStats(
      [
        group('a', [me(0), member('p', 'Priya Shah', { offsetMin: 5 }), member('p', 'Priya Shah', { offsetMin: 5 })]),
        group('b', [me(0), member('p', 'Priya Shah', { offsetMin: 5 })]),
      ],
      NOW,
      NY,
    );
    expect(stats.buddies).toHaveLength(1);
    expect(stats.buddies[0]?.sharedTrips).toBe(2);
  });
});
