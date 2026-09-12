import { describe, expect, it } from 'vitest';

import {
  delayMinutes,
  durationMinutes,
  formatAirportLocal,
  isValidTimeZone,
  localDateAtAirport,
  zoneAbbreviation,
} from './time';

describe('formatAirportLocal', () => {
  it('renders US eastern summer time as the docs example does', () => {
    // §3.1 disambiguation row: "DL 1234 · Mar 12 · JFK → LAX · 3:45 PM EDT"
    expect(formatAirportLocal('2026-07-15T19:45:00Z', 'America/New_York')).toBe('3:45 PM EDT');
  });

  it('switches label across the US DST boundary', () => {
    expect(formatAirportLocal('2026-01-15T19:45:00Z', 'America/New_York')).toBe('2:45 PM EST');
  });

  it('renders London in BST during British summer time', () => {
    expect(formatAirportLocal('2026-07-15T12:00:00Z', 'Europe/London')).toBe('1:00 PM BST');
  });

  it('renders London in GMT outside British summer time', () => {
    expect(formatAirportLocal('2026-01-15T12:00:00Z', 'Europe/London')).toBe('12:00 PM GMT');
  });

  it('falls back to an offset label for zones without an abbreviation', () => {
    expect(formatAirportLocal('2026-07-15T12:00:00Z', 'Asia/Kolkata')).toBe('5:30 PM GMT+5:30');
  });

  it('formats midnight and noon unambiguously', () => {
    expect(formatAirportLocal('2026-07-16T04:00:00Z', 'America/New_York')).toBe('12:00 AM EDT');
    expect(formatAirportLocal('2026-07-15T16:00:00Z', 'America/New_York')).toBe('12:00 PM EDT');
  });

  it('separates the day period with a plain space, not U+202F', () => {
    const formatted = formatAirportLocal('2026-07-15T19:45:00Z', 'America/New_York');
    expect(formatted).not.toMatch(/[\u00a0\u202f]/);
    expect(formatted.split(' ')).toHaveLength(3);
  });

  it('rejects an unparseable instant', () => {
    expect(() => formatAirportLocal('not-a-date', 'America/New_York')).toThrow(TypeError);
  });
});

describe('localDateAtAirport', () => {
  it('keeps a late JFK departure on the local date, not the UTC one', () => {
    // 23:50 local at JFK on 15 Jul 2026 (EDT, UTC-4) is 03:50Z on the 16th.
    const utc = '2026-07-16T03:50:00Z';
    expect(utc.slice(0, 10)).toBe('2026-07-16');
    expect(localDateAtAirport(utc, 'America/New_York')).toBe('2026-07-15');
  });

  it('keeps an early Sydney departure on the local date, not the UTC one', () => {
    // 08:00 local in Sydney (AEST, UTC+10) is 22:00Z the previous day.
    expect(localDateAtAirport('2026-07-14T22:00:00Z', 'Australia/Sydney')).toBe('2026-07-15');
  });

  it('is exact at local midnight either side', () => {
    expect(localDateAtAirport('2026-07-16T03:59:59Z', 'America/New_York')).toBe('2026-07-15');
    expect(localDateAtAirport('2026-07-16T04:00:00Z', 'America/New_York')).toBe('2026-07-16');
  });

  it('handles the US spring-forward day, when 02:00–03:00 local does not exist', () => {
    // 8 Mar 2026, 02:00 EST → 03:00 EDT.
    expect(localDateAtAirport('2026-03-08T06:59:00Z', 'America/New_York')).toBe('2026-03-08');
    expect(localDateAtAirport('2026-03-08T07:00:00Z', 'America/New_York')).toBe('2026-03-08');
    expect(formatAirportLocal('2026-03-08T06:59:00Z', 'America/New_York')).toBe('1:59 AM EST');
    expect(formatAirportLocal('2026-03-08T07:00:00Z', 'America/New_York')).toBe('3:00 AM EDT');
  });

  it('handles the UK BST transition', () => {
    // BST starts 29 Mar 2026 at 01:00 UTC.
    expect(formatAirportLocal('2026-03-29T00:59:00Z', 'Europe/London')).toBe('12:59 AM GMT');
    expect(formatAirportLocal('2026-03-29T01:00:00Z', 'Europe/London')).toBe('2:00 AM BST');
    expect(localDateAtAirport('2026-03-29T01:00:00Z', 'Europe/London')).toBe('2026-03-29');
    // A 23:50 Heathrow departure in BST is already the next date in UTC.
    expect(localDateAtAirport('2026-07-15T22:50:00Z', 'Europe/London')).toBe('2026-07-15');
    expect(localDateAtAirport('2026-07-15T23:50:00Z', 'Europe/London')).toBe('2026-07-16');
  });

  it('handles a zone with a fractional offset across the date line', () => {
    expect(localDateAtAirport('2026-07-15T18:45:00Z', 'Asia/Kathmandu')).toBe('2026-07-16');
  });
});

describe('durationMinutes', () => {
  it('measures a flight in whole minutes', () => {
    expect(durationMinutes('2026-07-15T19:45:00Z', '2026-07-16T03:15:00Z')).toBe(450);
  });

  it('is unaffected by a DST transition inside the interval', () => {
    // Departs JFK 01:30 EST, lands 04:30 EDT on spring-forward day: 2h, not 3h.
    expect(durationMinutes('2026-03-08T06:30:00Z', '2026-03-08T08:30:00Z')).toBe(120);
  });

  it('goes negative when the instants are reversed', () => {
    expect(durationMinutes('2026-07-15T12:00:00Z', '2026-07-15T11:30:00Z')).toBe(-30);
  });

  it('rounds to the nearest minute', () => {
    expect(durationMinutes('2026-07-15T12:00:00Z', '2026-07-15T12:00:31Z')).toBe(1);
    expect(durationMinutes('2026-07-15T12:00:00Z', '2026-07-15T12:00:29Z')).toBe(0);
  });

  it('accepts Date objects as well as ISO strings', () => {
    expect(durationMinutes(new Date('2026-07-15T12:00:00Z'), '2026-07-15T13:00:00Z')).toBe(60);
  });
});

describe('delayMinutes', () => {
  it('reports a late estimate as positive minutes', () => {
    expect(delayMinutes('2026-07-15T19:45:00Z', '2026-07-15T20:30:00Z')).toBe(45);
  });

  it('reports an early estimate as negative minutes', () => {
    expect(delayMinutes('2026-07-15T19:45:00Z', '2026-07-15T19:30:00Z')).toBe(-15);
  });

  it('distinguishes on time from unknown', () => {
    expect(delayMinutes('2026-07-15T19:45:00Z', '2026-07-15T19:45:00Z')).toBe(0);
    expect(delayMinutes('2026-07-15T19:45:00Z', null)).toBeNull();
    expect(delayMinutes(null, '2026-07-15T19:45:00Z')).toBeNull();
    expect(delayMinutes(undefined, undefined)).toBeNull();
  });
});

describe('zone helpers', () => {
  it('validates IANA zones against the runtime ICU data', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });

  it('labels UTC itself', () => {
    expect(zoneAbbreviation('2026-07-15T12:00:00Z', 'UTC')).toBe('UTC');
  });
});
