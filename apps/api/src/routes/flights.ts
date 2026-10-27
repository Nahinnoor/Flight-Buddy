/**
 * `POST /v1/flights/lookup` and `POST /v1/flights` — the add-flight flow (§3.1).
 *
 * Three rules from PROJECT_OVERVIEW shape every line below.
 *
 * 1. **Never pick `[0]`** (§8.12). A flight number can operate several legs on
 *    one date; lookup returns all of them and the *user* chooses. The add
 *    endpoint takes the leg they chose, identified by its origin.
 * 2. **Never trust the posted candidate's data** (ADR 0001). The client could
 *    have edited every timestamp on the way back. The server looks the flight
 *    up again by its operating number and date, matches the leg on origin, and
 *    ingests what the *provider* just said — the posted candidate is used only
 *    to identify which leg was meant, plus the marketing pair below.
 * 3. **Never write `flights` from a handler** (§12.7). `ingestFlight` with the
 *    service-role client is the only writer; this file writes `trips` and
 *    `trip_segments` as the user, under RLS.
 *
 * The marketing carrier and number are the one thing taken verbatim from the
 * client: they are what the user typed, they are display data, and they belong
 * on the segment — never on the shared `flights` row (§6.1, §7.2).
 */
import { ingestFlight, lookupCandidates, type LookupRequest } from '@flightbuddy/flight-provider';
import {
  flightLookupByNumberSchema,
  flightQueryInputSchema,
  parseFlightQuery,
  addFlightRequestSchema,
  type AddFlightResponse,
  type FlightCandidate,
  type FlightLookupResponse,
} from '@flightbuddy/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';

import { requireUser, requireUserClient } from '../auth';
import type { AppDeps } from '../deps';
import { BadRequestError, DatabaseError, NotFoundError, dbFailure } from '../errors';
import { isRecord } from '../guards';
import { ensureIdentity, type TravelerView } from '../identity';
import { isUniqueViolation, type Client } from '../supabase';

/**
 * Turn either accepted body into a number and a date.
 *
 * Free text is resolved against the *client's* clock and zone, never the
 * server's (§8.4): "tomorrow" in Auckland is not "tomorrow" in Oregon, and this
 * process runs wherever Render put it.
 */
function resolveLookup(body: unknown, now: () => Date): LookupRequest {
  if (!isRecord(body)) return flightLookupByNumberSchema.parse(body);

  if ('query' in body) {
    const input = flightQueryInputSchema.parse(body);
    // Uppercase-insensitive already; the parser normalises internally.
    const reference = input.today === undefined ? now() : new Date(`${input.today}T12:00:00.000Z`);
    const zone = input.today === undefined ? (input.timeZone ?? 'UTC') : 'UTC';
    const parsed = parseFlightQuery(input.query, reference, zone);
    if ('error' in parsed) {
      // A parse failure is the user's typing, not a provider or server fault.
      throw new BadRequestError(parsed.error, 'INVALID_QUERY');
    }
    return parsed;
  }

  // Lenient on case and surrounding space, strict on shape: the shared schema
  // is the contract, but "dl 1234" is a thing people type.
  const { flightNumber } = body;
  return flightLookupByNumberSchema.parse({
    ...body,
    flightNumber:
      typeof flightNumber === 'string' ? flightNumber.trim().toUpperCase() : flightNumber,
  });
}

// -------------------------------------------------------------- add flight ---

/**
 * An airport whose feed health cannot be read degrades that flight to the
 * `scheduled` tier (§7.3). Logged, never silent: an invisible degrade is how
 * every flight came back `scheduled` while both airports had live coverage.
 * ICAO code and error class only — no payload, no user data.
 */
function logFeedHealthError(log: FastifyBaseLogger, icao: string, error: unknown): void {
  log.warn(
    { icao, errorName: error instanceof Error ? error.name : 'unknown' },
    'feed health unavailable: flight stays on the scheduled tier',
  );
}

/**
 * Ask the provider again and return the leg the user actually picked.
 *
 * Matching is on `originIata` because that is the one field that distinguishes
 * the legs of a multi-leg number on a given date, and it is part of the
 * canonical key in §6.2. Everything else on the returned candidate is fresh.
 */
async function reverifyCandidate(
  deps: AppDeps,
  posted: FlightCandidate,
  log: FastifyBaseLogger,
): Promise<FlightCandidate> {
  const designator = `${posted.operatingCarrierIata}${posted.operatingFlightNumber}`;
  const fresh = await lookupCandidates(
    deps.provider,
    { flightNumber: designator, dateLocal: posted.departureDateLocal },
    { onFeedHealthError: (icao, error) => logFeedHealthError(log, icao, error) },
  );

  const match = fresh.find((leg) => leg.originIata === posted.originIata);
  if (match === undefined) {
    throw new BadRequestError(
      `The flight data provider no longer has ${designator} from ${posted.originIata} on ${posted.departureDateLocal}. Search again.`,
      'CANDIDATE_MISMATCH',
      {
        detail: `re-lookup returned ${fresh.length} leg(s): ${fresh.map((leg) => leg.originIata).join(',') || 'none'}`,
      },
    );
  }
  return match;
}

/** The trip a segment goes on, and whether this request is what created it. */
interface ResolvedTrip {
  tripId: string;
  /** True when the request created it, so a later failure can undo it. */
  created: boolean;
}

/**
 * The trip `POST /v1/flights` appends to: the caller's own `tripId` if given,
 * otherwise a new trip for their self-traveller.
 */
async function resolveTrip(
  supabase: Client,
  traveler: TravelerView,
  tripId: string | undefined,
): Promise<ResolvedTrip> {
  if (tripId !== undefined) {
    // Read as the user: RLS already hides other people's trips, and the
    // explicit traveler check additionally rejects a co-member's trip, which
    // is readable but not one this user may append a segment to.
    const found = await supabase
      .from('trips')
      .select('id, traveler_id')
      .eq('id', tripId)
      .maybeSingle();
    if (found.error !== null) {
      throw dbFailure('Could not read that trip.', found.error);
    }
    if (found.data === null || found.data.traveler_id !== traveler.id) {
      throw new NotFoundError('That trip does not exist.', 'TRIP_NOT_FOUND');
    }
    return { tripId, created: false };
  }

  const created = await supabase
    .from('trips')
    .insert({ traveler_id: traveler.id })
    .select('id')
    .single();
  if (created.error !== null || created.data === null) {
    throw dbFailure('Could not create a trip for that flight.', created.error);
  }
  return { tripId: created.data.id, created: true };
}

/** `max(sequence_number) + 1`, or 1 for a trip with no segments yet. */
async function nextSequenceNumber(supabase: Client, tripId: string): Promise<number> {
  const last = await supabase
    .from('trip_segments')
    .select('sequence_number')
    .eq('trip_id', tripId)
    .order('sequence_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last.error !== null) {
    throw dbFailure('Could not read that trip.', last.error);
  }
  return last.data === null ? 1 : last.data.sequence_number + 1;
}

/** How many times to recompute `sequence_number` after a unique violation. */
const SEQUENCE_ATTEMPTS = 3;

interface InsertedSegment {
  segmentId: string;
  sequenceNumber: number;
}

/**
 * Insert the segment, recomputing the sequence number if a concurrent add to
 * the same trip took it. `unique (trip_id, sequence_number)` is what makes the
 * clash visible instead of silent (§6.2).
 */
async function insertSegment(
  supabase: Client,
  trip: ResolvedTrip,
  flightId: string,
  posted: FlightCandidate,
): Promise<InsertedSegment> {
  const { tripId } = trip;
  let lastError = 'sequence_number contention';

  for (let attempt = 0; attempt < SEQUENCE_ATTEMPTS; attempt += 1) {
    // A trip this request just created has no segments, so the first try
    // needs no read; a retry means somebody else added one.
    const sequenceNumber =
      attempt === 0 && trip.created ? 1 : await nextSequenceNumber(supabase, tripId);
    const inserted = await supabase
      .from('trip_segments')
      .insert({
        trip_id: tripId,
        flight_id: flightId,
        sequence_number: sequenceNumber,
        // What the user typed, not what the provider returned (§7.2).
        marketing_carrier_iata: posted.marketingCarrierIata,
        marketing_flight_number: posted.marketingFlightNumber,
      })
      .select('id')
      .single();

    if (inserted.error === null && inserted.data !== null) {
      return { segmentId: inserted.data.id, sequenceNumber };
    }
    if (!isUniqueViolation(inserted.error)) {
      throw dbFailure('Could not add that flight to your trip.', inserted.error);
    }
    lastError = `sequence_number ${sequenceNumber} taken`;
  }

  throw new DatabaseError('Could not add that flight to your trip.', { detail: lastError });
}

/**
 * Undo a trip this request created, so a failed add does not leave an empty
 * trip on the dashboard. Best effort by design: the original error is what the
 * caller needs to see, and a failure to clean up must not replace it.
 */
async function discardTrip(
  supabase: Client,
  tripId: string,
  request: FastifyRequest,
): Promise<void> {
  try {
    const { error } = await supabase.from('trips').delete().eq('id', tripId);
    if (error !== null) {
      request.log.warn({ tripId, detail: error.message }, 'could not discard the trip we created');
    }
  } catch (error) {
    request.log.warn({ err: error, tripId }, 'could not discard the trip we created');
  }
}

// ----------------------------------------------------------------- routes ---

/** Registered under the `/v1` prefix (`app.ts`). */
export function registerFlightRoutes(app: FastifyInstance, deps: AppDeps): void {
  /**
   * Lookup. Zero candidates is a 404, not an empty 200: "we have no such
   * flight" is a different thing for the UI to say than "here are none of
   * the many", and it is the branch that offers a manual add (§3.1).
   */
  app.post('/flights/lookup', async (request): Promise<FlightLookupResponse> => {
    requireUser(request);
    const lookup = resolveLookup(request.body, deps.now);

    const candidates = await lookupCandidates(deps.provider, lookup, {
      onFeedHealthError: (icao, error) => logFeedHealthError(request.log, icao, error),
    });
    if (candidates.length === 0) {
      throw new NotFoundError(
        `No flight ${lookup.flightNumber} on ${lookup.dateLocal}. Check the number and the date.`,
      );
    }
    return { candidates };
  });

  /**
   * Add. Order matters: identity, then re-verify, then ingest, then the trip,
   * then the segment. Ingest is safe to repeat — it is an upsert on the
   * canonical key — so a failure after it leaves nothing to undo except a trip
   * this request created.
   */
  app.post('/flights', async (request): Promise<AddFlightResponse> => {
    // The caller before the body, like the `onRequest` hook: if a route ever
    // lost the hook, an anonymous body would get a 401 here, not a 400.
    const user = requireUser(request);
    const supabase = requireUserClient(request);
    const { candidate, tripId } = addFlightRequestSchema.parse(request.body);

    const { traveler } = await ensureIdentity(supabase, user.id, user.email);
    const fresh = await reverifyCandidate(deps, candidate, request.log);

    // The only `flights` write in the whole API, and it is not this file's.
    const { flightId } = await ingestFlight(fresh, deps.serviceClient);

    const trip = await resolveTrip(supabase, traveler, tripId);
    try {
      const segment = await insertSegment(supabase, trip, flightId, candidate);
      return {
        tripId: trip.tripId,
        segmentId: segment.segmentId,
        flightId,
        sequenceNumber: segment.sequenceNumber,
      };
    } catch (error) {
      if (trip.created) await discardTrip(supabase, trip.tripId, request);
      throw error;
    }
  });
}
