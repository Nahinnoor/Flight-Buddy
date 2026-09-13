import { describe, expect, it } from 'vitest';

import { parseFlightDesignator, parseFlightQuery } from './flightQuery';
import { flightDesignatorSchema, localDateSchema } from './schemas';

/** A fixed instant: 2026-09-11 21:59 in New York, already 2026-09-12 in UTC. */
const NOW = new Date('2026-09-12T01:59:00Z');
const NY = 'America/New_York';

function ok(result: ReturnType<typeof parseFlightQuery>) {
  if ('error' in result) throw new Error(`expected a parse, got: ${result.error}`);
  return result;
}

describe('parseFlightDesignator', () => {
  it.each([
    ['DL1234', 'DL', '1234'],
    ['dl 1234', 'DL', '1234'],
    ['DL 1234', 'DL', '1234'],
    ['dl-1234', 'DL', '1234'],
    ['B61411', 'B6', '1411'],
    ['b6 1411', 'B6', '1411'],
    ['9W123', '9W', '123'],
    ['DL0012', 'DL', '12'],
    ['AA1', 'AA', '1'],
  ])('splits %s', (input, carrier, number) => {
    expect(parseFlightDesignator(input)).toEqual({
      carrierIata: carrier,
      flightNumber: number,
      designator: `${carrier}${number}`,
    });
  });

  it.each(['', '1234', '12 345', 'DELTA 1234', 'DL12345', 'DL'])('rejects %s', (input) => {
    expect(parseFlightDesignator(input)).toBeNull();
  });
});

describe('parseFlightQuery', () => {
  it('reads a month-name date in either order', () => {
    expect(ok(parseFlightQuery('DL1234 Mar 12', NOW, NY))).toEqual({
      flightNumber: 'DL1234',
      dateLocal: '2027-03-12',
    });
    expect(ok(parseFlightQuery('DL 1234 12 Mar', NOW, NY))).toEqual({
      flightNumber: 'DL1234',
      dateLocal: '2027-03-12',
    });
  });

  it("reads relative dates against the caller's zone, not UTC", () => {
    // NOW is already the 12th in UTC but still the 11th in New York.
    expect(ok(parseFlightQuery('dl1234 today', NOW, NY)).dateLocal).toBe('2026-09-11');
    expect(ok(parseFlightQuery('dl1234 tomorrow', NOW, NY)).dateLocal).toBe('2026-09-12');
    expect(ok(parseFlightQuery('DL1234 today', NOW, 'UTC')).dateLocal).toBe('2026-09-12');
  });

  it('reads an explicit ISO date', () => {
    expect(ok(parseFlightQuery('DL1234 2026-09-12', NOW, NY))).toEqual({
      flightNumber: 'DL1234',
      dateLocal: '2026-09-12',
    });
  });

  it('reads a month-first numeric date', () => {
    expect(ok(parseFlightQuery('DL1234 3/12', NOW, NY)).dateLocal).toBe('2027-03-12');
    expect(ok(parseFlightQuery('DL1234 9/20', NOW, NY)).dateLocal).toBe('2026-09-20');
    expect(ok(parseFlightQuery('DL1234 3/12/2029', NOW, NY)).dateLocal).toBe('2029-03-12');
    expect(ok(parseFlightQuery('DL1234 3/12/29', NOW, NY)).dateLocal).toBe('2029-03-12');
  });

  it('rolls a yearless date that has already passed into next year', () => {
    // Today is 2026-09-11 in New York.
    expect(ok(parseFlightQuery('DL1234 Sep 12', NOW, NY)).dateLocal).toBe('2026-09-12');
    expect(ok(parseFlightQuery('DL1234 Sep 11', NOW, NY)).dateLocal).toBe('2026-09-11');
    // Yesterday is inside the grace window, so it stays in this year.
    expect(ok(parseFlightQuery('DL1234 Sep 10', NOW, NY)).dateLocal).toBe('2026-09-10');
    // Two days ago is past the window: the user means next year.
    expect(ok(parseFlightQuery('DL1234 Sep 9', NOW, NY)).dateLocal).toBe('2027-09-09');
    expect(ok(parseFlightQuery('DL1234 Jan 5', NOW, NY)).dateLocal).toBe('2027-01-05');
  });

  it('handles two-character alphanumeric carriers', () => {
    expect(ok(parseFlightQuery('B61411 tomorrow', NOW, NY)).flightNumber).toBe('B61411');
    expect(ok(parseFlightQuery('b6 1411 tomorrow', NOW, NY)).flightNumber).toBe('B61411');
    expect(ok(parseFlightQuery('9W 123 today', NOW, NY)).flightNumber).toBe('9W123');
  });

  it('asks for a date when only a flight number is given', () => {
    const result = parseFlightQuery('DL1234', NOW, NY);
    expect(result).toEqual({ error: expect.stringContaining('Add a date') });
  });

  it('rejects text that does not start with a flight number', () => {
    expect(parseFlightQuery('tomorrow DL1234', NOW, NY)).toEqual({
      error: expect.stringContaining('Start with a flight number'),
    });
    expect(parseFlightQuery('', NOW, NY)).toEqual({
      error: expect.stringContaining('flight number'),
    });
  });

  it('rejects an unreadable or impossible date', () => {
    expect(parseFlightQuery('DL1234 sometime next week', NOW, NY)).toEqual({
      error: expect.stringContaining('Could not read'),
    });
    expect(parseFlightQuery('DL1234 Feb 30', NOW, NY)).toEqual({
      error: expect.stringContaining('not a real date'),
    });
    expect(parseFlightQuery('DL1234 2026-02-30', NOW, NY)).toEqual({
      error: expect.stringContaining('not a real date'),
    });
  });

  it('rejects a time zone the runtime does not know', () => {
    expect(parseFlightQuery('DL1234 today', NOW, 'Mars/Olympus_Mons')).toEqual({
      error: expect.stringContaining('time zone'),
    });
  });

  it('produces output the shared schemas accept', () => {
    const result = ok(parseFlightQuery('dl 1234 12 mar', NOW, NY));
    expect(flightDesignatorSchema.parse(result.flightNumber)).toBe('DL1234');
    expect(localDateSchema.parse(result.dateLocal)).toBe(result.dateLocal);
  });
});
