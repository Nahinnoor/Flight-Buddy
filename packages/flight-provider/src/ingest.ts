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
 */
import type { Database, FlightCandidate } from '@flightbuddy/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

type FlightInsert = Database['public']['Tables']['flights']['Insert'];
type RawPayload = FlightInsert['raw_payload'];

/**
 * The unique constraint from §6.2, as PostgREST wants it: the conflict target
 * of `insert ... on conflict (...) do update`.
 */
export const FLIGHTS_CONFLICT_TARGET =
  'operating_carrier_iata,operating_flight_number,departure_date_local,origin_iata';

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

  constructor(message: string, options: { code?: string; details?: string } = {}) {
    super(message);
    this.name = 'FlightIngestError';
    this.code = options.code;
    this.details = options.details;
  }
}

/**
 * Upsert one candidate leg into `flights` and return its id.
 *
 * Every column written is a value the provider returned, plus `raw_payload` and
 * `updated_at`. Scheduling, lease, webhook and archive columns are absent from
 * the payload, so an update leaves whatever the poller put there untouched.
 *
 * @param candidate One leg, codeshare already resolved (§7.2).
 * @param supabase A service-role client. RLS denies this write to anyone else.
 */
export async function ingestFlight(
  candidate: FlightCandidate,
  supabase: SupabaseClient<Database>,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const now = (options.now ?? (() => new Date()))();
  // The default snapshot is the candidate minus the marketing pair: that pair
  // is what the *user* typed, and nothing a user typed belongs on a row shared
  // by every traveller on the aircraft (§6.1). It lives on `trip_segments`.
  const { marketingCarrierIata: _mc, marketingFlightNumber: _mn, ...providerFields } = candidate;
  const rawPayload = (options.rawPayload ?? providerFields) as RawPayload;

  const row: FlightInsert = {
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
  };

  const { data, error } = await supabase
    .from('flights')
    .upsert(row, { onConflict: FLIGHTS_CONFLICT_TARGET })
    .select('id')
    .single();

  if (error !== null) {
    throw new FlightIngestError(
      `Could not ingest ${candidate.operatingCarrierIata}${candidate.operatingFlightNumber} on ${candidate.departureDateLocal}: ${error.message}`,
      { code: error.code, details: error.details },
    );
  }
  if (data === null) {
    throw new FlightIngestError('Upsert into flights returned no row.');
  }

  return { flightId: data.id };
}
