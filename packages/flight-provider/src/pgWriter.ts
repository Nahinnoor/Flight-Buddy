/**
 * The `FlightsWriter` the Render worker uses: plain SQL over a `pg` connection.
 *
 * The worker holds no Supabase key by design (ADR 0003 §6) — it logs in as
 * `flightbuddy_worker`, a role with `select, insert, update on public.flights` and
 * no DELETE anywhere. So rule 7's "only `ingestFlight` writes `flights`" keeps
 * holding by giving `ingestFlight` a second transport, not a second writer:
 * `ingest.ts` still decides every column and every value, and this file only
 * carries the row.
 *
 * Same semantics as the supabase-js writer, on purpose:
 * `insert … on conflict (canonical key) do update`, updating only the provider
 * fields plus `updated_at`, and clearing `archived_at`; the route columns in
 * `FLIGHT_COALESCE_COLUMNS` are `coalesce(excluded.col, flights.col)`, so a null
 * never erases a stored value (the supabase-js writer omits the key instead). Scheduling, lease and
 * webhook columns are not in the statement at all, so a concurrent poll pass
 * cannot lose its `next_poll_at` to an ingest.
 *
 * **Parameterised only.** Column names come from the frozen
 * `FLIGHT_UPSERT_COLUMNS` list and placeholders from its indices; nothing derived
 * from a provider payload is ever concatenated into the statement. `pg` is not
 * imported — the connection arrives as a function — so this package gains no
 * dependency.
 */
import {
  FLIGHTS_CONFLICT_COLUMNS,
  FLIGHT_COALESCE_COLUMNS,
  FLIGHT_UPSERT_COLUMNS,
  FlightIngestError,
  type FlightUpsertRow,
  type FlightsWriter,
} from './ingest';

/**
 * The one thing this writer needs from a database driver.
 *
 * Structurally satisfied by `pg`'s `Pool.query` and `Client.query`, and by a fake
 * in tests. Deliberately not `pg`'s own type: this package must stay importable
 * from the mobile client's dependency graph.
 */
export type QueryFn = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: { id: string }[] }>;

/** Columns that are the conflict key, so they are never in the `do update set` list. */
const CONFLICT_SET: ReadonlySet<string> = new Set(FLIGHTS_CONFLICT_COLUMNS);

/** Columns updated as `coalesce(new, existing)`: a null never erases a stored value. */
const COALESCE_SET: ReadonlySet<string> = new Set(FLIGHT_COALESCE_COLUMNS);

/** `jsonb` columns need an explicit cast: `pg` sends every parameter as text. */
const JSONB_COLUMNS: ReadonlySet<string> = new Set(['raw_payload']);

function placeholder(column: string, index: number): string {
  return JSONB_COLUMNS.has(column) ? `$${index + 1}::jsonb` : `$${index + 1}`;
}

/**
 * The upsert, built once at module load from the column list.
 *
 * Built rather than written out so a column added to `FLIGHT_UPSERT_COLUMNS`
 * cannot be silently missing from the insert list, the placeholder list or the
 * update list — the three places this kind of statement usually drifts.
 */
export const FLIGHTS_UPSERT_SQL: string = (() => {
  const columns = FLIGHT_UPSERT_COLUMNS.map((column) => `"${column}"`).join(', ');
  const values = FLIGHT_UPSERT_COLUMNS.map((column, index) => placeholder(column, index)).join(
    ', ',
  );
  const updates = FLIGHT_UPSERT_COLUMNS.filter((column) => !CONFLICT_SET.has(column))
    .map((column) =>
      COALESCE_SET.has(column)
        ? `"${column}" = coalesce(excluded."${column}", flights."${column}")`
        : `"${column}" = excluded."${column}"`,
    )
    .join(', ');
  const conflict = FLIGHTS_CONFLICT_COLUMNS.map((column) => `"${column}"`).join(', ');

  return `insert into public.flights (${columns})
values (${values})
on conflict (${conflict}) do update set ${updates}
returning id`;
})();

/** `raw_payload` is jsonb; everything else goes over the wire as `pg` takes it. */
function parameterFor(column: string, value: unknown): unknown {
  if (!JSONB_COLUMNS.has(column)) return value;
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * Build the worker's `FlightsWriter`.
 *
 * @param query Usually `(text, values) => pool.query(text, values)`.
 */
export function createPgFlightsWriter(query: QueryFn): FlightsWriter {
  return {
    async upsertFlight(row: FlightUpsertRow): Promise<{ id: string }> {
      const values = FLIGHT_UPSERT_COLUMNS.map((column) => parameterFor(column, row[column]));

      const result = await query(FLIGHTS_UPSERT_SQL, values);
      const id = result.rows[0]?.id;
      if (id === undefined) {
        throw new FlightIngestError('Upsert into flights returned no row.');
      }
      return { id };
    },
  };
}
