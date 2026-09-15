/**
 * The only writer of `flights` (ADR 0001, §12.7).
 *
 * A flight is a shared real-world fact, not a row belonging to a user (§6.1),
 * so exactly one function writes it, with the service-role key, from values the
 * provider returned. The API calls this and then writes `trip_segments`; the
 * Phase 2 poller calls the same function for status updates and gets the
 * conflict handling for free.
 *
 * Two rules are enforced here rather than trusted to callers:
 *
 * 1. **Upsert on the canonical key.** The codeshare is already resolved in the
 *    candidate (§7.2), so the operating identity is the key and two travellers
 *    on the same aircraft under different numbers land on one row.
 * 2. **Never touch `next_poll_at`.** Scheduling is Phase 2's column (§7.4). An
 *    add-flight that reset it would drag a flight's poll forward or, worse,
 *    clear it and silently stop tracking.
 *
 * ## Why there is a `FlightsWriter` seam
 *
 * Phase 2 gave the poller a **`pg` connection and no Supabase key at all**: the
 * worker logs in as the restricted `flightbuddy_worker` role (ADR 0003 §6) and
 * deliberately holds neither the service-role nor the anon key. Rule 7 still says
 * this function is the only writer of `flights`, so the transport moved behind a
 * one-method interface instead of the rule bending. The row this file builds —
 * which columns are written and which are left alone — is unchanged and shared by
 * both implementations; only the statement that carries it differs.
 */
import type { Database, FlightCandidate } from '@flightbuddy/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

type FlightInsert = Database['public']['Tables']['flights']['Insert'];

/**
 * The unique constraint from §6.2, as PostgREST wants it: the conflict target
 * of `insert ... on conflict (...) do update`.
 */
export const FLIGHTS_CONFLICT_TARGET =
  'operating_carrier_iata,operating_flight_number,departure_date_local,origin_iata';

/** The same key as columns, for writers that build SQL rather than a REST call. */
export const FLIGHTS_CONFLICT_COLUMNS = [
  'operating_carrier_iata',
  'operating_flight_number',
  'departure_date_local',
  'origin_iata',
] as const;

/**
 * Every column `ingestFlight` writes, and the only columns any writer may touch.
 *
 * Scheduling (`next_poll_at`, `poll_lease_until`, `last_polled_at`,
 * `poll_failure_count`), webhook lifecycle (`alert_subscription_id`,
 * `alert_subscribed_at`), `id` and `created_at` are absent on purpose: they belong
 * to the poller and an ingest must leave whatever it put there alone.
 */
export const FLIGHT_UPSERT_COLUMNS = [
  // canonical identity (§6.2 unique key)
  'operating_carrier_iata',
  'operating_flight_number',
  'departure_date_local',
  'origin_iata',

  'destination_iata',
  'origin_tz',
  'destination_tz',

  'status',
  'tracking_tier',

  'gate',
  'terminal',

  'scheduled_departure_utc',
  'estimated_departure_utc',
  'actual_departure_utc',
  'scheduled_arrival_utc',
  'estimated_arrival_utc',
  'actual_arrival_utc',

  'aircraft_reg',
  'aircraft_model',

  'raw_payload',
  'updated_at',
  'archived_at',
] as const satisfies readonly (keyof FlightInsert)[];

/** The row shape `ingestFlight` builds: exactly `FLIGHT_UPSERT_COLUMNS`, all present. */
export type FlightUpsertRow = Required<Pick<FlightInsert, (typeof FLIGHT_UPSERT_COLUMNS)[number]>>;

/**
 * The transport `ingestFlight` writes through.
 *
 * One method, one contract: upsert on the canonical key, update only the columns
 * present in `row`, return the row's id. `createSupabaseFlightsWriter` is what the
 * API uses; `createPgFlightsWriter` (`./pgWriter`) is what the worker uses.
 */
export interface FlightsWriter {
  upsertFlight(row: FlightUpsertRow): Promise<{ id: string }>;
}

/** True for a `FlightsWriter`, false for a `SupabaseClient`. */
function isFlightsWriter(
  target: SupabaseClient<Database> | FlightsWriter,
): target is FlightsWriter {
  return typeof (target as FlightsWriter).upsertFlight === 'function';
}

export interface IngestOptions {
  /**
   * The provider response to keep for debugging. Defaults to the candidate,
   * which is the normalised form of it. The poller passes the raw body.
   */
  rawPayload?: unknown;
  /** Injected for tests. Defaults to the wall clock. */
  now?: () => Date;
}

export interface IngestResult {
  /** `flights.id`, the value `trip_segments.flight_id` points at. */
  flightId: string;
}

/** A write to `flights` that Postgres refused. */
export class FlightIngestError extends Error {
  readonly code: string | undefined;
  readonly details: string | undefined;

  constructor(message: string, options: { code?: string; details?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'FlightIngestError';
    this.code = options.code;
    this.details = options.details;
  }
}

/**
 * A `FlightsWriter` backed by supabase-js. What `apps/api` passes (service role).
 *
 * RLS denies this write to anyone but the service role, which is the API's half of
 * rule 7; the worker's half is the `flightbuddy_worker` grant set instead.
 */
export function createSupabaseFlightsWriter(supabase: SupabaseClient<Database>): FlightsWriter {
  return {
    async upsertFlight(row: FlightUpsertRow): Promise<{ id: string }> {
      const { data, error } = await supabase
        .from('flights')
        .upsert(row, { onConflict: FLIGHTS_CONFLICT_TARGET })
        .select('id')
        .single();

      if (error !== null) {
        throw new FlightIngestError(error.message, { code: error.code, details: error.details });
      }
      if (data === null) {
        throw new FlightIngestError('Upsert into flights returned no row.');
      }
      return { id: data.id };
    },
  };
}

/**
 * Upsert one candidate leg into `flights` and return its id.
 *
 * Every column written is a value the provider returned, plus `raw_payload`,
 * `updated_at` and `archived_at = null`. Scheduling, lease and webhook columns
 * are absent from the payload, so an update leaves whatever the poller put
 * there untouched. `archived_at` is cleared on purpose: a flight is archived
 * when its last segment goes (§6.3 trigger) or after landing, and an add is
 * someone asking to see it again.
 *
 * @param candidate One leg, codeshare already resolved (§7.2).
 * @param target A service-role supabase-js client (the API), or a `FlightsWriter`
 *   (the worker, which has a `pg` pool and no Supabase key). A client is wrapped
 *   in `createSupabaseFlightsWriter` so existing callers need no change.
 */
export async function ingestFlight(
  candidate: FlightCandidate,
  target: SupabaseClient<Database> | FlightsWriter,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const writer = isFlightsWriter(target) ? target : createSupabaseFlightsWriter(target);
  const now = (options.now ?? (() => new Date()))();
  // The default snapshot is the candidate minus the marketing pair: that pair
  // is what the *user* typed, and nothing a user typed belongs on a row shared
  // by every traveller on the aircraft (§6.1). It lives on `trip_segments`.
  const { marketingCarrierIata: _mc, marketingFlightNumber: _mn, ...providerFields } = candidate;
  const rawPayload = (options.rawPayload ?? providerFields) as FlightUpsertRow['raw_payload'];

  const row: FlightUpsertRow = {
    // canonical identity (§6.2 unique key)
    operating_carrier_iata: candidate.operatingCarrierIata,
    operating_flight_number: candidate.operatingFlightNumber,
    departure_date_local: candidate.departureDateLocal,
    origin_iata: candidate.originIata,

    destination_iata: candidate.destinationIata,
    origin_tz: candidate.originTz,
    destination_tz: candidate.destinationTz,

    status: candidate.status,
    tracking_tier: candidate.trackingTier,

    gate: candidate.gate,
    terminal: candidate.terminal,

    scheduled_departure_utc: candidate.scheduledDepartureUtc,
    estimated_departure_utc: candidate.estimatedDepartureUtc,
    actual_departure_utc: candidate.actualDepartureUtc,
    scheduled_arrival_utc: candidate.scheduledArrivalUtc,
    estimated_arrival_utc: candidate.estimatedArrivalUtc,
    actual_arrival_utc: candidate.actualArrivalUtc,

    aircraft_reg: candidate.aircraftReg,
    aircraft_model: candidate.aircraftModel,

    raw_payload: rawPayload,
    updated_at: now.toISOString(),
    archived_at: null,
  };

  try {
    const { id } = await writer.upsertFlight(row);
    return { flightId: id };
  } catch (error) {
    // The identity in the message is the operating flight, never anything a user
    // typed and never a provider body: this string reaches logs.
    const leg = `${candidate.operatingCarrierIata}${candidate.operatingFlightNumber} on ${candidate.departureDateLocal}`;
    if (error instanceof FlightIngestError) {
      throw new FlightIngestError(`Could not ingest ${leg}: ${error.message}`, {
        code: error.code,
        details: error.details,
      });
    }
    // A driver error's message can name hosts, roles or constraints; only its
    // class name is safe in a message that reaches logs. The original stays
    // reachable as `cause` for a debugger, never serialised.
    throw new FlightIngestError(
      `Could not ingest ${leg}: ${error instanceof Error ? error.name : 'unknown error'}`,
      { cause: error },
    );
  }
}
