/**
 * An in-memory stand-in for `SupabaseClient`, covering exactly the call shapes
 * this API makes.
 *
 * It is a real little database rather than a canned-response stub, because the
 * things worth asserting are things only state can show: that `/v1/me` is
 * idempotent, that the second segment on a trip gets `sequence_number` 2, that
 * a failed add leaves no orphan trip behind, and — the invariant that matters
 * most (§12.7) — that the *user* client never touches `flights` at all.
 *
 * It enforces the unique constraints from §6.2 that the code recovers from, so
 * "insert and treat 23505 as somebody-already-did" is tested rather than
 * assumed.
 */
import type { Client, PostgrestErrorLike } from '../supabase';

export type Row = Record<string, unknown>;
export type Op = 'select' | 'insert' | 'upsert' | 'delete';

export interface FakeCall {
  table: string;
  op: Op;
}

interface Result<T> {
  data: T | null;
  error: PostgrestErrorLike | null;
}

/** The unique keys this fake enforces, as declared in the migrations. */
const UNIQUE_KEY: Record<string, (row: Row) => string | null> = {
  profiles: (row) => `id:${String(row.id)}`,
  // `travelers_self_traveler_uniq` — partial, on `user_id` where not null.
  travelers: (row) => (row.user_id == null ? null : `user:${String(row.user_id)}`),
  trips: () => null,
  // `unique (trip_id, sequence_number)`.
  trip_segments: (row) => `${String(row.trip_id)}:${String(row.sequence_number)}`,
  // The canonical flight key from §6.2.
  flights: (row) =>
    [
      row.operating_carrier_iata,
      row.operating_flight_number,
      row.departure_date_local,
      row.origin_iata,
    ]
      .map(String)
      .join(':'),
};

function uniqueViolation(table: string): PostgrestErrorLike {
  return {
    code: '23505',
    message: `duplicate key value violates unique constraint on ${table}`,
  };
}

let idCounter = 0;
/** A real v4-shaped uuid: `addFlightResponseSchema` validates the response. */
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, '0')}`;
}

export class FakeDatabase {
  private readonly tables = new Map<string, Row[]>();
  /** Errors to return instead of performing the next write on a table. */
  private readonly forced = new Map<
    string,
    Array<{ error: PostgrestErrorLike; then?: () => void }>
  >();

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing !== undefined) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  seed(table: string, ...rows: Row[]): void {
    this.rows(table).push(...rows);
  }

  /**
   * Make the next write to `table` fail with `error`.
   *
   * `then` runs at the moment the write fails, which is the seam that lets a
   * test reproduce the lost-update race exactly: the row appears *between* our
   * select and our insert, which is the only ordering the recovery path exists
   * for.
   */
  failNextWrite(table: string, error: PostgrestErrorLike, then?: () => void): void {
    const queue = this.forced.get(table) ?? [];
    queue.push(then === undefined ? { error } : { error, then });
    this.forced.set(table, queue);
  }

  private takeForced(table: string): PostgrestErrorLike | null {
    const queue = this.forced.get(table);
    if (queue === undefined || queue.length === 0) return null;
    const next = queue.shift();
    if (next === undefined) return null;
    next.then?.();
    return next.error;
  }

  private findByUniqueKey(table: string, row: Row): Row | undefined {
    const keyOf = UNIQUE_KEY[table];
    if (keyOf === undefined) return undefined;
    const key = keyOf(row);
    if (key === null) return undefined;
    return this.rows(table).find((existing) => keyOf(existing) === key);
  }

  insert(table: string, row: Row): Result<Row> {
    const forced = this.takeForced(table);
    if (forced !== null) return { data: null, error: forced };
    if (this.findByUniqueKey(table, row) !== undefined) {
      return { data: null, error: uniqueViolation(table) };
    }
    const stored: Row = {
      id: nextId(),
      created_at: '2026-09-12T00:00:00.000Z',
      ...row,
    };
    this.rows(table).push(stored);
    return { data: stored, error: null };
  }

  upsert(table: string, row: Row): Result<Row> {
    const forced = this.takeForced(table);
    if (forced !== null) return { data: null, error: forced };
    const existing = this.findByUniqueKey(table, row);
    if (existing !== undefined) {
      Object.assign(existing, row);
      return { data: existing, error: null };
    }
    return this.insert(table, row);
  }

  /** One client over this store. Each gets its own call log. */
  client(): { client: Client; calls: FakeCall[] } {
    const calls: FakeCall[] = [];
    const insertRow = this.insert.bind(this);
    const upsertRow = this.upsert.bind(this);
    const rowsOf = this.rows.bind(this);

    function record(table: string, op: Op): void {
      calls.push({ table, op });
    }

    /** `select(...).eq(...).order(...).limit(...)` ending in single/maybeSingle. */
    function selectBuilder(table: string) {
      const filters: Array<[string, unknown]> = [];
      let orderBy: { column: string; ascending: boolean } | null = null;
      let limit: number | null = null;

      function matching(): Row[] {
        let found = rowsOf(table).filter((row) =>
          filters.every(([column, value]) => row[column] === value),
        );
        if (orderBy !== null) {
          const { column, ascending } = orderBy;
          found = [...found].sort((a, b) => {
            const left = a[column] as number | string;
            const right = b[column] as number | string;
            if (left === right) return 0;
            return (left < right ? -1 : 1) * (ascending ? 1 : -1);
          });
        }
        if (limit !== null) found = found.slice(0, limit);
        return found;
      }

      const builder = {
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          orderBy = { column, ascending: options?.ascending ?? true };
          return builder;
        },
        limit(count: number) {
          limit = count;
          return builder;
        },
        async maybeSingle(): Promise<Result<Row>> {
          const found = matching();
          return { data: found[0] ?? null, error: null };
        },
        async single(): Promise<Result<Row>> {
          const found = matching();
          if (found.length === 0) {
            return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } };
          }
          return { data: found[0] as Row, error: null };
        },
      };
      return builder;
    }

    function writeBuilder(result: Result<Row>) {
      return {
        select() {
          return {
            async single(): Promise<Result<Row>> {
              return result;
            },
            async maybeSingle(): Promise<Result<Row>> {
              return result;
            },
          };
        },
        // `await client.from(t).insert(row)` with no `.select()` — the webhook
        // receiver's shape. supabase-js builders are thenables; so is this, so
        // a forced error reaches the caller instead of reading as success.
        then<T1 = Result<Row>, T2 = never>(
          onFulfilled?: ((value: Result<Row>) => T1 | PromiseLike<T1>) | null,
          onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ): Promise<T1 | T2> {
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
    }

    const client = {
      from(table: string) {
        return {
          select() {
            record(table, 'select');
            return selectBuilder(table);
          },
          insert(row: Row) {
            record(table, 'insert');
            return writeBuilder(insertRow(table, row));
          },
          upsert(row: Row) {
            record(table, 'upsert');
            return writeBuilder(upsertRow(table, row));
          },
          // No RLS here: any row matching the filter goes, whichever client
          // asked. That the orphan-trip cleanup in routes/flights.ts cannot
          // delete another traveller's trip is guaranteed only by
          // `trips_delete_own` in the real migration, so keep it on the
          // user-scoped client; this fake will not catch a swap to the
          // service client.
          delete() {
            record(table, 'delete');
            return {
              async eq(column: string, value: unknown): Promise<Result<null>> {
                const rows = rowsOf(table);
                for (let index = rows.length - 1; index >= 0; index -= 1) {
                  if ((rows[index] as Row)[column] === value) rows.splice(index, 1);
                }
                return { data: null, error: null };
              },
            };
          },
        };
      },
    } as unknown as Client;

    return { client, calls };
  }
}

/** True when `calls` never mentions `flights` — the §12.7 assertion. */
export function touchedFlights(calls: readonly FakeCall[]): boolean {
  return calls.some((call) => call.table === 'flights');
}
