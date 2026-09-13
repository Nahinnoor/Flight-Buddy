/**
 * `flight-display.ts` is where the display rules from §7.2, §7.3, §8.8 and §9
 * actually live, and it is pure — no React, no Supabase, no network. So it is
 * the one part of the client that can be pinned down by tests, and the parts
 * worth pinning down are the ones where being subtly wrong is invisible:
 * showing the operating number instead of the user's, calling a 30-minute
 * delay "big", or presenting six-hour-old gate data as current.
 */
import { describe, expect, it } from 'vitest';

import {
  DELAY_HIGHLIGHT_MINUTES,
  countdownTickMs,
  countdownTo,
  flightNumbers,
  formatDelay,
  formatDuration,
  formatLocalDateShort,
  isLiveTracked,
  stalenessHint,
  statusLabel,
  statusTone,
} from './flight-display';

describe('flightNumbers (§7.2)', () => {
  it('shows the number the user typed and says who operates it', () => {
    expect(
      flightNumbers({
        marketingCarrierIata: 'DL',
        marketingFlightNumber: '8517',
        operatingCarrierIata: 'AF',
        operatingFlightNumber: '3612',
      }),
    ).toEqual({
      primary: 'DL 8517',
      operatedBy: 'Operated by Air France as AF 3612',
    });
  });

  it('says nothing about the operator when it is the same airline', () => {
    expect(
      flightNumbers({
        marketingCarrierIata: 'DL',
        marketingFlightNumber: '1234',
        operatingCarrierIata: 'DL',
        operatingFlightNumber: '1234',
      }),
    ).toEqual({ primary: 'DL 1234', operatedBy: null });
  });

  it('falls back to the operating number when no marketing number was stored', () => {
    expect(
      flightNumbers({
        marketingCarrierIata: null,
        marketingFlightNumber: null,
        operatingCarrierIata: 'WN',
        operatingFlightNumber: '1234',
      }),
    ).toEqual({ primary: 'WN 1234', operatedBy: null });
  });

  it('uses the raw code for a carrier it has no name for', () => {
    const { operatedBy } = flightNumbers({
      marketingCarrierIata: 'DL',
      marketingFlightNumber: '8517',
      operatingCarrierIata: 'ZZ',
      operatingFlightNumber: '1',
    });
    expect(operatedBy).toBe('Operated by ZZ as ZZ 1');
  });
});

describe('formatDuration', () => {
  it.each([
    [45, '45m'],
    [60, '1h'],
    [345, '5h 45m'],
    [0, '0m'],
  ])('%i minutes reads as %s', (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });

  it('keeps an unknown duration unknown rather than calling it zero', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-5)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});

describe('formatDelay (§9)', () => {
  it('distinguishes on time from unknown', () => {
    expect(formatDelay(0)).toBe('On time');
    expect(formatDelay(null)).toBeNull();
  });

  it('names late and early in the same units', () => {
    expect(formatDelay(45)).toBe('45 min late');
    expect(formatDelay(-10)).toBe('10 min early');
  });

  it('puts the highlight threshold where §9 puts the notification', () => {
    expect(DELAY_HIGHLIGHT_MINUTES).toBe(30);
  });
});

describe('countdownTo', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');

  it('coarsens as the target recedes and tightens as it approaches', () => {
    expect(countdownTo('2026-07-18T15:00:00.000Z', now)?.label).toBe('in 3d 3h');
    expect(countdownTo('2026-07-15T14:30:00.000Z', now)?.label).toBe('in 2h 30m');
    expect(countdownTo('2026-07-15T12:04:30.000Z', now)?.label).toBe('in 4m 30s');
    expect(countdownTo('2026-07-15T12:00:20.000Z', now)?.label).toBe('in 20s');
  });

  it('drops the smaller unit when it is zero', () => {
    expect(countdownTo('2026-07-17T12:00:00.000Z', now)?.label).toBe('in 2d');
    expect(countdownTo('2026-07-15T15:00:00.000Z', now)?.label).toBe('in 3h');
  });

  it('keeps counting after departure rather than going blank', () => {
    const past = countdownTo('2026-07-15T10:30:00.000Z', now);
    expect(past?.isPast).toBe(true);
    expect(past?.label).toBe('1h 30m ago');
  });

  it('has nothing to say about a time it does not have', () => {
    expect(countdownTo(null, now)).toBeNull();
    expect(countdownTo('not a date', now)).toBeNull();
  });

  it('ticks by the second only inside the last hour', () => {
    expect(countdownTickMs(30 * 60_000)).toBe(1_000);
    expect(countdownTickMs(-30 * 60_000)).toBe(1_000);
    expect(countdownTickMs(6 * 3_600_000)).toBe(30_000);
    expect(countdownTickMs(null)).toBe(60_000);
  });
});

describe('stalenessHint (§8.8)', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const soon = '2026-07-15T18:00:00.000Z'; // six hours out — inside the window.

  it('speaks up when close-in data has gone quiet', () => {
    expect(stalenessHint('2026-07-15T04:00:00.000Z', soon, now)).toBe('Last updated 8h ago');
  });

  it('stays quiet while the poller is keeping up', () => {
    expect(stalenessHint('2026-07-15T11:30:00.000Z', soon, now)).toBeNull();
  });

  it('stays quiet for a flight that is not due for days', () => {
    const farOut = '2026-08-01T18:00:00.000Z';
    expect(stalenessHint('2026-07-10T04:00:00.000Z', farOut, now)).toBeNull();
  });

  it('says nothing when there is nothing to compare', () => {
    expect(stalenessHint(null, soon, now)).toBeNull();
    expect(stalenessHint('2026-07-15T04:00:00.000Z', null, now)).toBeNull();
    expect(stalenessHint('rubbish', soon, now)).toBeNull();
  });
});

describe('tracking tier (§7.3)', () => {
  it('treats anything short of live as not live-tracked', () => {
    expect(isLiveTracked('live')).toBe(true);
    expect(isLiveTracked('scheduled')).toBe(false);
    expect(isLiveTracked('manual')).toBe(false);
  });
});

describe('status presentation', () => {
  it('labels every status in words, so colour is never the only signal', () => {
    expect(statusLabel('en_route')).toBe('En route');
    expect(statusLabel('cancelled')).toBe('Cancelled');
  });

  it('reserves the critical tone for the two that ruin a trip', () => {
    expect(statusTone('cancelled')).toBe('critical');
    expect(statusTone('diverted')).toBe('critical');
    expect(statusTone('delayed')).toBe('warning');
    expect(statusTone('scheduled')).toBe('neutral');
  });
});

describe('formatLocalDateShort (§3.1 step 3)', () => {
  it('renders the origin-local calendar date, whatever the device offset is', () => {
    expect(formatLocalDateShort('2026-03-12')).toBe('Mar 12');
    expect(formatLocalDateShort('2026-01-01')).toBe('Jan 1');
  });

  it('hands back anything it cannot read, rather than "Invalid Date"', () => {
    expect(formatLocalDateShort('tomorrow')).toBe('tomorrow');
  });
});
