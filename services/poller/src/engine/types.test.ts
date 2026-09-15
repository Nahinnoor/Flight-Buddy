import { types as pgTypes } from 'pg';
import { describe, expect, it } from 'vitest';

import { ENGINE_TYPES } from './types';

const OID_DATE = 1082;
const OID_TIMESTAMPTZ = 1184;
const OID_TEXT = 25;

function parserFor(oid: number): (value: string) => unknown {
  return ENGINE_TYPES.getTypeParser(oid, 'text') as (value: string) => unknown;
}

describe('ENGINE_TYPES — date', () => {
  it('keeps a date as the origin-local calendar date, as text', () => {
    // `departure_date_local` is a LOCAL date at the origin airport (§6.3): the
    // string is the value, and turning it into an instant is already wrong.
    expect(parserFor(OID_DATE)('2026-09-15')).toBe('2026-09-15');
    expect(parserFor(OID_DATE)('2099-01-01')).toBe('2099-01-01');
  });

  it('is the fix for the bug pg’s default would introduce', () => {
    // pg's own parser builds a Date at the *server's* local midnight. On a worker
    // running behind UTC that reads back as the previous day — §8.4, exactly.
    const asDate = pgTypes.getTypeParser(OID_DATE, 'text')('2099-01-01') as Date;
    expect(asDate).toBeInstanceOf(Date);
    expect(parserFor(OID_DATE)('2099-01-01')).not.toBeInstanceOf(Date);
  });
});

describe('ENGINE_TYPES — timestamptz', () => {
  it('normalises every wire form Postgres emits to a UTC ISO string', () => {
    // A space separator and a two-digit offset: `new Date()` rejects both in Node,
    // which is why this delegates to pg's parser and only changes the shape.
    expect(parserFor(OID_TIMESTAMPTZ)('2026-09-15 23:21:40.123+00')).toBe(
      '2026-09-15T23:21:40.123Z',
    );
    expect(parserFor(OID_TIMESTAMPTZ)('2026-09-15 23:21:40+00')).toBe('2026-09-15T23:21:40.000Z');
    // A non-UTC server zone must still come back as the same instant in UTC.
    expect(parserFor(OID_TIMESTAMPTZ)('2026-09-15 16:21:40.5-07')).toBe('2026-09-15T23:21:40.500Z');
  });

  it('refuses a value that is not a finite instant rather than inventing one', () => {
    expect(() => parserFor(OID_TIMESTAMPTZ)('infinity')).toThrow(TypeError);
  });
});

describe('ENGINE_TYPES — everything else', () => {
  it('falls through to pg’s own parsers', () => {
    expect(parserFor(OID_TEXT)('B6 1411')).toBe('B6 1411');
  });
});
