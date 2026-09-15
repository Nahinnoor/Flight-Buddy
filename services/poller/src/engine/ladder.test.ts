import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_AFTER_LANDING_MS,
  JITTER_FRACTION,
  LADDER_BOUNDARIES,
  LADDER_INTERVALS,
  applyJitter,
  ladderIntervalMs,
  nextPollAt,
  type LadderFlight,
} from './ladder';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** rng that returns exactly 0.5, i.e. no jitter, so intervals are readable. */
const noJitter = () => 0.5;

const NOW = new Date('2026-09-15T12:00:00.000Z');

/** A `live`-tier flight departing `msFromNow` after `NOW`, nothing observed yet. */
function flight(overrides: Partial<LadderFlight> = {}): LadderFlight {
  return {
    tracking_tier: 'live',
    status: 'scheduled',
    scheduled_departure_utc: null,
    estimated_departure_utc: null,
    actual_departure_utc: null,
    scheduled_arrival_utc: null,
    estimated_arrival_utc: null,
    actual_arrival_utc: null,
    alert_subscription_id: null,
    ...overrides,
  };
}

/** Departing `ms` after `NOW`, arriving `flightMs` after that. */
function departingIn(ms: number, flightMs = 3 * HOUR, overrides: Partial<LadderFlight> = {}) {
  const departure = new Date(NOW.getTime() + ms).toISOString();
  const arrival = new Date(NOW.getTime() + ms + flightMs).toISOString();
  return flight({
    scheduled_departure_utc: departure,
    scheduled_arrival_utc: arrival,
    ...overrides,
  });
}

describe('nextPollAt — tier gates', () => {
  it('never polls a manual-tier flight', () => {
    expect(
      nextPollAt(departingIn(2 * HOUR, 3 * HOUR, { tracking_tier: 'manual' }), NOW, noJitter),
    ).toBeNull();
    // Even once it has departed, and even far out.
    expect(
      nextPollAt(departingIn(30 * 24 * HOUR, 3 * HOUR, { tracking_tier: 'manual' }), NOW, noJitter),
    ).toBeNull();
  });

  it('keeps a scheduled-tier flight on the failover ladder permanently', () => {
    const scheduledTier = departingIn(3 * HOUR, 3 * HOUR, {
      tracking_tier: 'scheduled',
      alert_subscription_id: 'sub-1',
    });
    // Even with webhooks on and a subscription id present: scheduled tier never
    // gets alerts, so it must never stop polling (§7.3).
    expect(ladderIntervalMs(scheduledTier, NOW, { webhooksEnabled: true })).toBe(
      LADDER_INTERVALS.EVERY_15M,
    );
  });
});

describe('nextPollAt — the wave-3 webhook seam', () => {
  const subscribed = departingIn(3 * HOUR, 3 * HOUR, {
    tracking_tier: 'live',
    alert_subscription_id: 'sub-1',
  });

  it('keeps polling inside T-24h while webhooks are off (the default)', () => {
    // Wave 2 has no subscriptions yet; stopping here would be a 24-hour blind spot.
    expect(nextPollAt(subscribed, NOW, noJitter)).not.toBeNull();
    expect(ladderIntervalMs(subscribed, NOW)).toBe(LADDER_INTERVALS.EVERY_15M);
  });

  it('stops polling a subscribed live flight once webhooks are enabled', () => {
    expect(nextPollAt(subscribed, NOW, noJitter, { webhooksEnabled: true })).toBeNull();
  });

  it('keeps polling an unsubscribed live flight even with webhooks enabled', () => {
    const unsubscribed = departingIn(3 * HOUR, 3 * HOUR, { alert_subscription_id: null });
    expect(nextPollAt(unsubscribed, NOW, noJitter, { webhooksEnabled: true })).not.toBeNull();
  });

  it('polls a subscribed live flight outside T-24h regardless of the flag', () => {
    // Nothing is subscribed three days out, but if it were, the pre-window ladder
    // still owns it: the handover is at T-24h, not at subscription time.
    const farOut = departingIn(72 * HOUR, 3 * HOUR, { alert_subscription_id: 'sub-1' });
    expect(ladderIntervalMs(farOut, NOW, { webhooksEnabled: true })).toBe(LADDER_INTERVALS.DAILY);
  });
});

describe('nextPollAt — pre-window bands', () => {
  const cases: [string, number, number][] = [
    ['30 days out → weekly', 30 * 24 * HOUR, LADDER_INTERVALS.WEEKLY],
    ['just over 7 days → weekly', LADDER_BOUNDARIES.SEVEN_DAYS + 1, LADDER_INTERVALS.WEEKLY],
    ['exactly 7 days → daily', LADDER_BOUNDARIES.SEVEN_DAYS, LADDER_INTERVALS.DAILY],
    ['5 days out → daily', 5 * 24 * HOUR, LADDER_INTERVALS.DAILY],
    ['just over 48 h → daily', LADDER_BOUNDARIES.FORTY_EIGHT_HOURS + 1, LADDER_INTERVALS.DAILY],
    ['exactly 48 h → every 4 h', LADDER_BOUNDARIES.FORTY_EIGHT_HOURS, LADDER_INTERVALS.EVERY_4H],
    ['36 h out → every 4 h', 36 * HOUR, LADDER_INTERVALS.EVERY_4H],
    [
      'just over 24 h → every 4 h',
      LADDER_BOUNDARIES.TWENTY_FOUR_HOURS + 1,
      LADDER_INTERVALS.EVERY_4H,
    ],
  ];

  for (const [name, msOut, expected] of cases) {
    it(name, () => {
      expect(ladderIntervalMs(departingIn(msOut), NOW)).toBe(expected);
    });
  }
});

describe('nextPollAt — failover bands', () => {
  const cases: [string, number, number][] = [
    ['exactly 24 h → hourly', LADDER_BOUNDARIES.TWENTY_FOUR_HOURS, LADDER_INTERVALS.HOURLY],
    ['12 h out → hourly', 12 * HOUR, LADDER_INTERVALS.HOURLY],
    ['just over 6 h → hourly', LADDER_BOUNDARIES.SIX_HOURS + 1, LADDER_INTERVALS.HOURLY],
    ['exactly 6 h → every 15 min', LADDER_BOUNDARIES.SIX_HOURS, LADDER_INTERVALS.EVERY_15M],
    ['2 h out → every 15 min', 2 * HOUR, LADDER_INTERVALS.EVERY_15M],
    [
      'just over 75 min → every 15 min',
      LADDER_BOUNDARIES.SEVENTY_FIVE_MINUTES + 1,
      LADDER_INTERVALS.EVERY_15M,
    ],
    [
      'exactly 75 min → every 5 min',
      LADDER_BOUNDARIES.SEVENTY_FIVE_MINUTES,
      LADDER_INTERVALS.EVERY_5M,
    ],
    ['10 min out → every 5 min', 10 * MINUTE, LADDER_INTERVALS.EVERY_5M],
    ['at the scheduled time → every 5 min', 0, LADDER_INTERVALS.EVERY_5M],
    ['40 min past departure, not airborne → every 5 min', -40 * MINUTE, LADDER_INTERVALS.EVERY_5M],
  ];

  for (const [name, msOut, expected] of cases) {
    it(name, () => {
      expect(ladderIntervalMs(departingIn(msOut), NOW)).toBe(expected);
    });
  }

  it('holds at every 5 min past the scheduled time until wheels up', () => {
    // The overdue flight is the interesting one: it stays on the tightest
    // pre-departure cadence rather than falling into an in-flight band.
    const overdue = departingIn(-3 * HOUR, 3 * HOUR);
    expect(ladderIntervalMs(overdue, NOW)).toBe(LADDER_INTERVALS.EVERY_5M);
  });
});

describe('nextPollAt — in flight', () => {
  it('polls every 30 min once wheels up', () => {
    const airborne = flight({
      scheduled_departure_utc: new Date(NOW.getTime() - HOUR).toISOString(),
      actual_departure_utc: new Date(NOW.getTime() - HOUR).toISOString(),
      scheduled_arrival_utc: new Date(NOW.getTime() + 5 * HOUR).toISOString(),
      status: 'en_route',
    });
    expect(ladderIntervalMs(airborne, NOW)).toBe(LADDER_INTERVALS.IN_FLIGHT);
  });

  it('tightens to every 10 min inside the final 45 minutes', () => {
    const arriving = flight({
      scheduled_departure_utc: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
      actual_departure_utc: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
      scheduled_arrival_utc: new Date(
        NOW.getTime() + LADDER_BOUNDARIES.FINAL_45_MINUTES,
      ).toISOString(),
      status: 'en_route',
    });
    expect(ladderIntervalMs(arriving, NOW)).toBe(LADDER_INTERVALS.FINAL_APPROACH);

    const oneMsEarlier = flight({
      ...arriving,
      scheduled_arrival_utc: new Date(
        NOW.getTime() + LADDER_BOUNDARIES.FINAL_45_MINUTES + 1,
      ).toISOString(),
    });
    expect(ladderIntervalMs(oneMsEarlier, NOW)).toBe(LADDER_INTERVALS.IN_FLIGHT);
  });

  it('stays on the 10-minute band when the arrival time is already past', () => {
    const overdue = flight({
      scheduled_departure_utc: new Date(NOW.getTime() - 8 * HOUR).toISOString(),
      actual_departure_utc: new Date(NOW.getTime() - 8 * HOUR).toISOString(),
      scheduled_arrival_utc: new Date(NOW.getTime() - HOUR).toISOString(),
      status: 'en_route',
    });
    expect(ladderIntervalMs(overdue, NOW)).toBe(LADDER_INTERVALS.FINAL_APPROACH);
  });

  it('falls back to every 30 min for a flight with no scheduled arrival', () => {
    // §8.9: some flights never report an arrival time at all. That must not make
    // the ladder undefined — it degrades to the in-flight cadence, and the archive
    // backstop is what eventually retires the row.
    const noArrival = flight({
      scheduled_departure_utc: new Date(NOW.getTime() - HOUR).toISOString(),
      actual_departure_utc: new Date(NOW.getTime() - HOUR).toISOString(),
      scheduled_arrival_utc: null,
      estimated_arrival_utc: null,
      actual_arrival_utc: null,
      status: 'en_route',
    });
    expect(ladderIntervalMs(noArrival, NOW)).toBe(LADDER_INTERVALS.IN_FLIGHT);
    expect(nextPollAt(noArrival, NOW, noJitter)).toEqual(
      new Date(NOW.getTime() + LADDER_INTERVALS.IN_FLIGHT),
    );
  });

  it('falls back to daily when nothing at all is known about the times', () => {
    const blank = flight({});
    expect(ladderIntervalMs(blank, NOW)).toBe(LADDER_INTERVALS.DAILY);
  });
});

describe('nextPollAt — landed', () => {
  it('schedules exactly one more poll, at landed + 30 min, un-jittered', () => {
    const landedAt = new Date(NOW.getTime() - 5 * MINUTE);
    const landed = flight({
      scheduled_departure_utc: new Date(NOW.getTime() - 4 * HOUR).toISOString(),
      actual_departure_utc: new Date(NOW.getTime() - 4 * HOUR).toISOString(),
      scheduled_arrival_utc: landedAt.toISOString(),
      actual_arrival_utc: landedAt.toISOString(),
      status: 'landed',
    });

    // Un-jittered on purpose: a negative jitter here would archive early.
    for (const rng of [() => 0, () => 0.5, () => 0.999]) {
      expect(nextPollAt(landed, NOW, rng)).toEqual(
        new Date(landedAt.getTime() + ARCHIVE_AFTER_LANDING_MS),
      );
    }
  });

  it('becomes due immediately once landed + 30 min has passed', () => {
    const landedAt = new Date(NOW.getTime() - 2 * HOUR);
    const landed = flight({
      actual_departure_utc: new Date(NOW.getTime() - 6 * HOUR).toISOString(),
      scheduled_departure_utc: new Date(NOW.getTime() - 6 * HOUR).toISOString(),
      actual_arrival_utc: landedAt.toISOString(),
      scheduled_arrival_utc: landedAt.toISOString(),
      status: 'landed',
    });
    expect(ladderIntervalMs(landed, NOW)).toBe(0);
    expect(nextPollAt(landed, NOW, noJitter)).toEqual(NOW);
  });
});

describe('nextPollAt — anchors', () => {
  it('uses the estimated time when it is later than scheduled', () => {
    // Scheduled 90 min out (15-min band), estimated 5 h out (15-min band) — pick a
    // pair that straddles a boundary so the choice is visible.
    const delayed = flight({
      scheduled_departure_utc: new Date(NOW.getTime() + 90 * MINUTE).toISOString(),
      estimated_departure_utc: new Date(NOW.getTime() + 7 * HOUR).toISOString(),
      scheduled_arrival_utc: new Date(NOW.getTime() + 10 * HOUR).toISOString(),
    });
    expect(ladderIntervalMs(delayed, NOW)).toBe(LADDER_INTERVALS.HOURLY);
  });

  it('ignores an estimate that runs early: the aircraft can still leave on time', () => {
    const early = flight({
      scheduled_departure_utc: new Date(NOW.getTime() + 7 * HOUR).toISOString(),
      estimated_departure_utc: new Date(NOW.getTime() + 90 * MINUTE).toISOString(),
      scheduled_arrival_utc: new Date(NOW.getTime() + 10 * HOUR).toISOString(),
    });
    expect(ladderIntervalMs(early, NOW)).toBe(LADDER_INTERVALS.HOURLY);
  });

  it('prefers the actual time over both once it exists', () => {
    const departed = flight({
      scheduled_departure_utc: new Date(NOW.getTime() + 4 * HOUR).toISOString(),
      estimated_departure_utc: new Date(NOW.getTime() + 5 * HOUR).toISOString(),
      actual_departure_utc: new Date(NOW.getTime() - 10 * MINUTE).toISOString(),
      scheduled_arrival_utc: new Date(NOW.getTime() + 6 * HOUR).toISOString(),
    });
    // Airborne, not "4 hours to go".
    expect(ladderIntervalMs(departed, NOW)).toBe(LADDER_INTERVALS.IN_FLIGHT);
  });
});

describe('nextPollAt — timezone traps (§8.4)', () => {
  it('is unaffected by a DST transition in the origin zone', () => {
    // US spring forward 2027: 2027-03-14 02:00 America/New_York → 03:00.
    // A flight leaving JFK at 04:00 EDT is 08:00Z; six wall-clock hours earlier is
    // 21:00 EST the previous day = 02:00Z, but only FIVE real hours have passed.
    // The ladder must read the real gap (5 h → 15-minute band), not the wall-clock
    // one (6 h → hourly band).
    const departureUtc = '2027-03-14T08:00:00.000Z'; // 04:00 EDT at JFK
    const nowUtc = new Date('2027-03-14T03:00:00.000Z'); // 22:00 EST the night before

    const jfk = flight({
      scheduled_departure_utc: departureUtc,
      scheduled_arrival_utc: '2027-03-14T15:00:00.000Z',
    });

    expect(departureUtc.endsWith('Z')).toBe(true);
    expect(ladderIntervalMs(jfk, nowUtc)).toBe(LADDER_INTERVALS.EVERY_15M);

    // And the returned instant is `now` plus the interval, with no local-time drift.
    expect(nextPollAt(jfk, nowUtc, noJitter)).toEqual(
      new Date(nowUtc.getTime() + LADDER_INTERVALS.EVERY_15M),
    );
  });

  it('is unaffected by a southern-hemisphere DST transition either', () => {
    // Australia 2027-10-03: 02:00 → 03:00 AEDT in Australia/Sydney.
    const syd = flight({
      scheduled_departure_utc: '2027-10-02T16:30:00.000Z', // 03:30 AEDT on the 3rd
      scheduled_arrival_utc: '2027-10-03T06:30:00.000Z',
    });
    const now = new Date('2027-10-02T14:30:00.000Z');
    expect(ladderIntervalMs(syd, now)).toBe(LADDER_INTERVALS.EVERY_15M);
  });

  it('places a date-line crossing by its UTC instant, not its local date', () => {
    // NZ26 AKL → LAX departs 2026-09-16 19:20 NZST (= 2026-09-16T07:20Z) and lands
    // 2026-09-16 11:05 PDT (= 2026-09-16T18:05Z) — arriving "before" it left, in
    // local dates. `departure_date_local` is 2026-09-16 at AKL either way, and the
    // ladder must never consult it.
    const crossing = flight({
      scheduled_departure_utc: '2026-09-16T07:20:00.000Z',
      scheduled_arrival_utc: '2026-09-16T18:05:00.000Z',
    });

    // 2026-09-15T12:00Z is 19 h 20 m before departure → hourly failover band.
    expect(ladderIntervalMs(crossing, NOW)).toBe(LADDER_INTERVALS.HOURLY);

    // And once airborne, the arrival is genuinely in the future in UTC terms.
    const airborne = flight({
      ...crossing,
      actual_departure_utc: '2026-09-16T07:20:00.000Z',
      status: 'en_route',
    });
    expect(ladderIntervalMs(airborne, new Date('2026-09-16T17:40:00.000Z'))).toBe(
      LADDER_INTERVALS.FINAL_APPROACH,
    );
    expect(ladderIntervalMs(airborne, new Date('2026-09-16T10:00:00.000Z'))).toBe(
      LADDER_INTERVALS.IN_FLIGHT,
    );
  });

  it('gives the same answer whichever zone the server thinks it is in', () => {
    // The function only sees `Date` instants, so this is a structural guarantee:
    // an ISO string with an explicit offset and its `Z` equivalent are one instant.
    const withOffset = flight({
      scheduled_departure_utc: '2026-09-16T03:00:00.000-09:00',
      scheduled_arrival_utc: '2026-09-16T09:00:00.000-09:00',
    });
    const withZulu = flight({
      scheduled_departure_utc: '2026-09-16T12:00:00.000Z',
      scheduled_arrival_utc: '2026-09-16T18:00:00.000Z',
    });
    expect(ladderIntervalMs(withOffset, NOW)).toBe(ladderIntervalMs(withZulu, NOW));
  });
});

describe('jitter', () => {
  it('spans exactly ±10 % across the rng range', () => {
    expect(applyJitter(1000, () => 0)).toBe(900);
    expect(applyJitter(1000, () => 0.5)).toBe(1000);
    // rng() is [0, 1), so 1.1x is the open upper bound.
    expect(applyJitter(1000, () => 0.999999)).toBe(1100);
  });

  it('stays within ±10 % for every band and every rng draw', () => {
    const bands: [LadderFlight, number][] = [
      [departingIn(30 * 24 * HOUR), LADDER_INTERVALS.WEEKLY],
      [departingIn(5 * 24 * HOUR), LADDER_INTERVALS.DAILY],
      [departingIn(36 * HOUR), LADDER_INTERVALS.EVERY_4H],
      [departingIn(12 * HOUR), LADDER_INTERVALS.HOURLY],
      [departingIn(2 * HOUR), LADDER_INTERVALS.EVERY_15M],
      [departingIn(10 * MINUTE), LADDER_INTERVALS.EVERY_5M],
    ];

    // A deterministic sweep beats a random one: it fails the same way every time.
    const draws = Array.from({ length: 101 }, (_, i) => i / 101);

    for (const [subject, interval] of bands) {
      for (const draw of draws) {
        const next = nextPollAt(subject, NOW, () => draw);
        expect(next).not.toBeNull();
        const delta = (next as Date).getTime() - NOW.getTime();
        expect(delta).toBeGreaterThanOrEqual(Math.floor(interval * (1 - JITTER_FRACTION)));
        expect(delta).toBeLessThanOrEqual(Math.ceil(interval * (1 + JITTER_FRACTION)));
        // And never in the past, which would busy-loop the worker.
        expect(delta).toBeGreaterThan(0);
      }
    }
  });

  it('spreads flights that became due together', () => {
    // §8.3: many flights coming due at once against a 1 req/s limit.
    const draws = [0, 0.25, 0.5, 0.75, 0.99];
    const times = draws.map((draw) =>
      (nextPollAt(departingIn(12 * HOUR), NOW, () => draw) as Date).getTime(),
    );
    expect(new Set(times).size).toBe(draws.length);
  });
});
