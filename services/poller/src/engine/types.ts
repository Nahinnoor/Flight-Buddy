/**
 * Row shapes the engine reads, and the `pg` type parsers that produce them.
 *
 * Everything in this worker is an **absolute UTC instant as an ISO-8601 string**,
 * and `departure_date_local` is a `YYYY-MM-DD` string that is a *local* date at
 * the origin airport (§6.3). `pg`'s defaults give neither: a `date` column comes
 * back as a JS `Date` at the *server's* local midnight — which is exactly the §8.4
 * bug ("never use the server's local time for anything"), because a worker running
 * in a zone behind UTC would turn `2026-09-15` into `2026-09-14T…`. A `timestamptz`
 * comes back as a `Date`, which is correct but not the string shape the generated
 * `Database` types and `ingestFlight` expect.
 *
 * So the engine passes `ENGINE_TYPES` on every query. It is scoped to those
 * queries on purpose: mutating `pg`'s global parser table would also change what
 * pg-boss sees from its own tables.
 */
import { types as pgTypes } from 'pg';

import type { Database } from '@flightbuddy/shared';

/** A `flights` row, exactly as the generated Supabase types describe it. */
export type FlightRow = Database['public']['Tables']['flights']['Row'];

/** Postgres OIDs. `select typname, oid from pg_type where typname in (…)`. */
const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;

/** Keep `date` as the text Postgres sent: `2026-09-15`, no zone, no `Date`. */
function parseDate(value: string): string {
  return value;
}

/**
 * `timestamptz` → UTC ISO-8601, the one representation the whole codebase uses.
 *
 * Built on `pg`'s own parser rather than `new Date(value)`. Postgres sends
 * `2026-09-15 23:21:40.123+00` — a space separator and a **two-digit** offset —
 * and `new Date` rejects that in Node. `pg` already knows every form the server
 * emits, so this only changes the representation, not the parsing.
 */
const pgParseTimestamptz = pgTypes.getTypeParser(OID_TIMESTAMPTZ, 'text') as (
  value: string,
) => unknown;

function parseTimestamptz(value: string): string {
  const parsed = pgParseTimestamptz(value);
  if (parsed instanceof Date && !Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  // `infinity` / `-infinity`, or anything else `pg` could not turn into a Date.
  // No column in this schema uses them, and inventing an instant would be worse
  // than saying so.
  throw new TypeError('Postgres returned a timestamptz that is not a finite instant');
}

/**
 * Per-query type parsers. Pass as the `types` option to `client.query`.
 *
 * `pg`'s own `Query` type calls this `CustomTypesConfig`; the shape is a single
 * `getTypeParser(oid, format)`.
 */
export const ENGINE_TYPES = {
  getTypeParser(oid: number, format?: unknown): unknown {
    if (oid === OID_DATE) return parseDate;
    if (oid === OID_TIMESTAMPTZ || oid === OID_TIMESTAMP) return parseTimestamptz;
    return (pgTypes.getTypeParser as (oid: number, format?: unknown) => unknown)(oid, format);
  },
};
