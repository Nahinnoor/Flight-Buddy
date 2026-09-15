import type { FlightCandidate } from '@flightbuddy/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_DELAY_THRESHOLD_MINUTES,
  detectChanges,
  type PreviousFlight,
} from './changeDetector';
import { fixtureCandidates } from './testFixtures';

const MINUTE = 60_000;

/** The stored row that corresponds exactly to a candidate: the no-op baseline. */
function rowFrom(candidate: FlightCandidate): PreviousFlight {
  return {
    status: candidate.status,
    gate: candidate.gate,
    terminal: candidate.terminal,
    scheduled_departure_utc: candidate.scheduledDepartureUtc,
    estimated_departure_utc: candidate.estimatedDepartureUtc,
    actual_departure_utc: candidate.actualDepartureUtc,
    scheduled_arrival_utc: candidate.scheduledArrivalUtc,
    estimated_arrival_utc: candidate.estimatedArrivalUtc,
    actual_arrival_utc: candidate.actualArrivalUtc,
  };
}

function shift(iso: string | null, ms: number): string | null {
  return iso === null ? null : new Date(new Date(iso).getTime() + ms).toISOString();
}

describe('detectChanges', () => {
  /** B6 1411 JFK → LAS, a real captured live leg. */
  let b6: FlightCandidate;
  /** DL 9659 marketing → KL 1405 operating, the codeshare fixture. */
  let codeshare: FlightCandidate;

  beforeAll(async () => {
    const [live] = await fixtureCandidates('flights-number-live-today', {
      flightNumber: 'B6 1411',
      dateLocal: '2026-09-11',
    });
    const [marketing] = await fixtureCandidates('flights-number-codeshare-marketing', {
      flightNumber: 'DL 9659',
      dateLocal: '2026-09-12',
    });
    if (live === undefined || marketing === undefined) throw new Error('fixture produced no leg');
    b6 = live;
    codeshare = marketing;
  });

  describe('no-ops', () => {
    it('yields nothing when the provider returns exactly what we stored', () => {
      expect(detectChanges(rowFrom(b6), b6)).toEqual([]);
      expect(detectChanges(rowFrom(codeshare), codeshare)).toEqual([]);
    });

    it('yields nothing on a second identical poll of an already-delayed flight', () => {
      // The §8.2 guard: lateness is not news, *movement* is. A flight sitting at
      // 40 minutes late must not re-notify every fifteen minutes.
      const late: FlightCandidate = {
        ...b6,
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, 40 * MINUTE),
        status: 'delayed',
      };
      expect(detectChanges(rowFrom(late), late)).toEqual([]);
    });

    it('yields nothing when the provider drops a gate it used to report', () => {
      const withGate = { ...b6, gate: 'B24' };
      const gateGone = { ...b6, gate: null };
      expect(detectChanges(rowFrom(withGate), gateGone)).toEqual([]);
    });

    it('yields nothing for a terminal change alone (§9 does not notify on it)', () => {
      const moved = { ...b6, terminal: '4' };
      expect(detectChanges(rowFrom(b6), moved)).toEqual([]);
    });

    it('yields nothing when an already-departed flight is polled again', () => {
      const airborne: FlightCandidate = {
        ...b6,
        status: 'en_route',
        actualDepartureUtc: b6.scheduledDepartureUtc,
      };
      expect(detectChanges(rowFrom(airborne), airborne)).toEqual([]);
    });
  });

  describe('cancelled', () => {
    it('fires on the transition into cancelled', () => {
      const events = detectChanges(rowFrom(b6), { ...b6, status: 'cancelled' });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'cancelled',
        previousValue: { status: b6.status },
        newValue: { status: 'cancelled' },
        source: 'poll',
      });
    });

    it('does not re-fire for a flight already stored as cancelled', () => {
      const cancelled = { ...b6, status: 'cancelled' as const };
      expect(detectChanges(rowFrom(cancelled), cancelled)).toEqual([]);
    });

    it('suppresses the noise a cancellation drags with it', () => {
      // Gate cleared, times abandoned: one piece of news, one notification.
      const cancelled: FlightCandidate = {
        ...b6,
        status: 'cancelled',
        gate: 'Z99',
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, 6 * 60 * MINUTE),
      };
      const events = detectChanges(rowFrom({ ...b6, gate: 'A1' }), cancelled);
      expect(events.map((e) => e.type)).toEqual(['cancelled']);
    });
  });

  describe('diverted', () => {
    it('fires on the transition into diverted and carries the new destination', () => {
      const diverted: FlightCandidate = {
        ...b6,
        status: 'diverted',
        destinationIata: 'SLC',
        actualDepartureUtc: b6.scheduledDepartureUtc,
      };
      const previous = rowFrom({ ...b6, actualDepartureUtc: b6.scheduledDepartureUtc });

      const events = detectChanges(previous, diverted);

      expect(events.map((e) => e.type)).toEqual(['diverted']);
      expect(events[0]?.newValue).toMatchObject({ status: 'diverted', destinationIata: 'SLC' });
    });

    it('does not re-fire once stored as diverted', () => {
      const diverted = { ...b6, status: 'diverted' as const };
      expect(detectChanges(rowFrom(diverted), diverted)).toEqual([]);
    });
  });

  describe('delay', () => {
    it('fires when the departure moves more than 30 minutes past the last known value', () => {
      const slipped: FlightCandidate = {
        ...b6,
        status: 'delayed',
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, 31 * MINUTE),
      };

      const events = detectChanges(rowFrom(b6), slipped);

      expect(events.map((e) => e.type)).toEqual(['delay']);
      expect(events[0]?.newValue).toMatchObject({ movedByMinutes: 31, delayMinutes: 31 });
      expect(events[0]?.previousValue).toMatchObject({
        departureUtc: b6.estimatedDepartureUtc ?? b6.scheduledDepartureUtc,
      });
    });

    it('does not fire at exactly the threshold ("over 30 minutes")', () => {
      const exactly30: FlightCandidate = {
        ...b6,
        estimatedDepartureUtc: shift(
          b6.scheduledDepartureUtc,
          DEFAULT_DELAY_THRESHOLD_MINUTES * MINUTE,
        ),
      };
      expect(detectChanges(rowFrom(b6), exactly30)).toEqual([]);
    });

    it('fires again only for a further slip past the new last known value', () => {
      const first: FlightCandidate = {
        ...b6,
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, 40 * MINUTE),
      };
      // +20 more: total 60 late, but only 20 of movement. Not news.
      const nudge: FlightCandidate = {
        ...b6,
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, 60 * MINUTE),
      };
      expect(detectChanges(rowFrom(first), nudge)).toEqual([]);

      // +45 more: news, and the reported lateness is against the schedule.
      const slipAgain: FlightCandidate = {
        ...b6,
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, 85 * MINUTE),
      };
      const events = detectChanges(rowFrom(first), slipAgain);
      expect(events.map((e) => e.type)).toEqual(['delay']);
      expect(events[0]?.newValue).toMatchObject({ movedByMinutes: 45, delayMinutes: 85 });
    });

    it('never fires for a departure pulled earlier', () => {
      const earlier: FlightCandidate = {
        ...b6,
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, -45 * MINUTE),
      };
      expect(detectChanges(rowFrom(b6), earlier)).toEqual([]);
    });

    it('measures against the actual departure once there is one', () => {
      const previous = rowFrom({
        ...b6,
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, 10 * MINUTE),
      });
      const pushedOff: FlightCandidate = {
        ...b6,
        status: 'departed',
        actualDepartureUtc: shift(b6.scheduledDepartureUtc, 50 * MINUTE),
      };

      const events = detectChanges(previous, pushedOff);

      expect(events.map((e) => e.type)).toEqual(['delay', 'departed']);
      expect(events[0]?.newValue).toMatchObject({ movedByMinutes: 40, delayMinutes: 50 });
    });

    it('respects a configured threshold', () => {
      const slipped: FlightCandidate = {
        ...b6,
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, 16 * MINUTE),
      };
      expect(detectChanges(rowFrom(b6), slipped, { delayThresholdMinutes: 15 })).toHaveLength(1);
      expect(detectChanges(rowFrom(b6), slipped)).toEqual([]);
    });

    it('stays silent when either side has no departure time at all', () => {
      const noTimes = { ...b6, scheduledDepartureUtc: null, estimatedDepartureUtc: null };
      expect(detectChanges(rowFrom(noTimes), b6)).toEqual([]);
      expect(detectChanges(rowFrom(b6), noTimes)).toEqual([]);
    });
  });

  describe('gate_change', () => {
    it('fires when a gate is assigned for the first time', () => {
      const assigned = { ...b6, gate: 'B24' };

      const events = detectChanges(rowFrom(b6), assigned);

      expect(events.map((e) => e.type)).toEqual(['gate_change']);
      expect(events[0]?.previousValue).toMatchObject({ gate: null });
      expect(events[0]?.newValue).toMatchObject({ gate: 'B24', terminal: b6.terminal });
    });

    it('fires when the gate is reassigned', () => {
      const events = detectChanges(rowFrom({ ...b6, gate: 'B24' }), { ...b6, gate: 'C11' });

      expect(events.map((e) => e.type)).toEqual(['gate_change']);
      expect(events[0]?.previousValue).toMatchObject({ gate: 'B24' });
      expect(events[0]?.newValue).toMatchObject({ gate: 'C11' });
    });

    it('does not fire when the gate is unchanged', () => {
      const same = { ...b6, gate: 'B24' };
      expect(detectChanges(rowFrom(same), same)).toEqual([]);
    });

    it('carries the terminal alongside, because a gate without one misdirects people', () => {
      const moved = { ...b6, gate: 'C11', terminal: '4' };
      const events = detectChanges(rowFrom({ ...b6, gate: 'B24', terminal: '5' }), moved);
      expect(events[0]?.previousValue).toEqual({ gate: 'B24', terminal: '5' });
      expect(events[0]?.newValue).toEqual({ gate: 'C11', terminal: '4' });
    });
  });

  describe('departed', () => {
    it('fires when an actual departure time appears', () => {
      const off: FlightCandidate = {
        ...b6,
        status: 'departed',
        actualDepartureUtc: b6.scheduledDepartureUtc,
      };

      const events = detectChanges(rowFrom(b6), off);

      expect(events.map((e) => e.type)).toEqual(['departed']);
      expect(events[0]?.newValue).toMatchObject({
        status: 'departed',
        actualDepartureUtc: b6.scheduledDepartureUtc,
      });
    });

    it('fires on a status-only departure, for feeds that report no wheels-up time', () => {
      const events = detectChanges(rowFrom(b6), { ...b6, status: 'en_route' });
      expect(events.map((e) => e.type)).toEqual(['departed']);
    });

    it('does not fire twice when the time arrives after the status did', () => {
      // Poll 1 said `en_route`; poll 2 adds the timestamp. One departure, one event.
      const statusOnly = { ...b6, status: 'en_route' as const };
      const withTime: FlightCandidate = {
        ...statusOnly,
        actualDepartureUtc: b6.scheduledDepartureUtc,
      };
      expect(detectChanges(rowFrom(statusOnly), withTime)).toEqual([]);
    });
  });

  describe('landed', () => {
    it('fires when an actual arrival time appears', () => {
      const airborne = rowFrom({
        ...b6,
        status: 'en_route',
        actualDepartureUtc: b6.scheduledDepartureUtc,
      });
      const down: FlightCandidate = {
        ...b6,
        status: 'landed',
        actualDepartureUtc: b6.scheduledDepartureUtc,
        actualArrivalUtc: b6.scheduledArrivalUtc,
      };

      const events = detectChanges(airborne, down);

      expect(events.map((e) => e.type)).toEqual(['landed']);
      expect(events[0]?.newValue).toMatchObject({ actualArrivalUtc: b6.scheduledArrivalUtc });
    });

    it('does not fire twice once stored as landed', () => {
      const down: FlightCandidate = {
        ...b6,
        status: 'landed',
        actualDepartureUtc: b6.scheduledDepartureUtc,
        actualArrivalUtc: b6.scheduledArrivalUtc,
      };
      expect(detectChanges(rowFrom(down), down)).toEqual([]);
    });

    it('reports departure and landing together when one poll spans both', () => {
      // A worker restart or a long back-off can skip the whole flight.
      const down: FlightCandidate = {
        ...b6,
        status: 'landed',
        actualDepartureUtc: b6.scheduledDepartureUtc,
        actualArrivalUtc: b6.scheduledArrivalUtc,
      };
      expect(detectChanges(rowFrom(b6), down).map((e) => e.type)).toEqual(['departed', 'landed']);
    });
  });

  describe('shape', () => {
    it('stamps every event with the source, defaulting to poll', () => {
      const events = detectChanges(rowFrom(b6), { ...b6, gate: 'B24', status: 'cancelled' });
      expect(events.every((e) => e.source === 'poll')).toBe(true);

      const fromWebhook = detectChanges(rowFrom(b6), { ...b6, gate: 'B24' }, { source: 'webhook' });
      expect(fromWebhook[0]?.source).toBe('webhook');
    });

    it('emits in a deterministic order when several things change at once', () => {
      const previous = rowFrom(b6);
      const chaos: FlightCandidate = {
        ...b6,
        status: 'landed',
        gate: 'C11',
        estimatedDepartureUtc: shift(b6.scheduledDepartureUtc, 90 * MINUTE),
        actualDepartureUtc: shift(b6.scheduledDepartureUtc, 90 * MINUTE),
        actualArrivalUtc: shift(b6.scheduledArrivalUtc, 90 * MINUTE),
      };

      expect(detectChanges(previous, chaos).map((e) => e.type)).toEqual([
        'delay',
        'gate_change',
        'departed',
        'landed',
      ]);
    });

    it('carries only provider fields, never anything the user typed', () => {
      const events = detectChanges(rowFrom(codeshare), { ...codeshare, gate: 'D7' });
      // DL 9659 is the marketing number; the operating leg is KL 1405.
      expect(codeshare.marketingFlightNumber).toBe('9659');
      expect(JSON.stringify(events)).not.toContain('9659');
    });
  });
});
