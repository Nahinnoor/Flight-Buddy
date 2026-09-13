/**
 * Client for the Fastify API (ADR 0001).
 *
 * Scope is deliberately small: the app talks to the API only to look a flight
 * up and to add one. Everything it *reads* comes from Supabase directly, under
 * RLS, so this file is not a general-purpose data layer.
 *
 * Two rules it enforces on the client side:
 *
 * - every response is parsed with the zod schemas from `@flightbuddy/shared`
 *   before anything downstream sees it, so a server that drifts from the
 *   contract fails here with a readable message rather than three screens later
 *   as `undefined is not an object`;
 * - a lookup returns the array it was given. Nothing in here picks `[0]`
 *   (§8.12) — disambiguation is the caller's job.
 */
import {
  addFlightResponseSchema,
  apiErrorSchema,
  flightLookupResponseSchema,
  parseFlightDesignator,
  parseFlightQuery,
  type AddFlightRequest,
  type AddFlightResponse,
  type FlightLookupRequest,
  type FlightLookupResponse,
} from '@flightbuddy/shared';

import { deviceTimeZone } from './device-time';
import { API_URL, MOCK_API } from './env';
import { mockCandidates } from './mock/candidates';
import { addMockSegment } from './mock/store';
import { supabase } from './supabase';

/** Every failure the caller can see, including transport and validation ones. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /** True when signing in again is what would fix this. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 'not_authenticated';
  }
}

/** Message shown when the API gave us something the contract does not allow. */
const CONTRACT_VIOLATION =
  'The server sent something this version of the app does not understand. Try updating the app.';

async function accessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error !== null) {
    throw new ApiError('not_authenticated', error.message);
  }
  const token = data.session?.access_token;
  if (token === undefined) {
    throw new ApiError('not_authenticated', 'You are signed out. Sign in and try again.');
  }
  return token;
}

/**
 * POSTs `body` to `/v1<path>` with the caller's Supabase access token and
 * validates the reply against `schema`.
 *
 * The error envelope is `{ error: { code, message } }` for every endpoint, so a
 * non-2xx response is decoded once here and rethrown as an `ApiError` carrying
 * the server's own code. A body that is neither the envelope nor valid JSON
 * still produces an `ApiError`, never a raw `SyntaxError`.
 */
async function post<T>(
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const token = await accessToken();

  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal?.aborted === true) throw new ApiError('aborted', 'Request cancelled.');
    throw new ApiError(
      'network_error',
      'Could not reach FlightBuddy. Check your connection and try again.',
    );
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const envelope = apiErrorSchema.safeParse(payload);
    if (envelope.success) {
      throw new ApiError(envelope.data.error.code, envelope.data.error.message, response.status);
    }
    throw new ApiError(
      'http_error',
      `Request failed (${response.status}).`,
      response.status,
    );
  }

  try {
    return parse(payload);
  } catch {
    throw new ApiError('invalid_response', CONTRACT_VIOLATION, response.status);
  }
}

// ---------------------------------------------------------------- mock mode --

/**
 * Stands in for the server's parse-then-look-up. It reuses the *same* parser
 * the API will (`@flightbuddy/shared`), so mock mode cannot accept an input
 * production would reject, and the result goes back through
 * `flightLookupResponseSchema` so it cannot produce a shape production would.
 *
 * `today` is honoured the way the server must honour it (§8.4): "tomorrow" is
 * relative to the *device's* calendar date, never this process's. Passing that
 * date at noon UTC and reading it back in UTC is the one substitution that
 * cannot be knocked sideways by an offset.
 */
function mockLookup(request: FlightLookupRequest): FlightLookupResponse {
  let flightNumber: string;
  let dateLocal: string;

  if ('query' in request) {
    const anchoredToDevice = request.today !== undefined;
    const parsed = parseFlightQuery(
      request.query,
      anchoredToDevice ? new Date(`${request.today as string}T12:00:00.000Z`) : new Date(),
      anchoredToDevice ? 'UTC' : (request.timeZone ?? deviceTimeZone()),
    );
    if ('error' in parsed) throw new ApiError('invalid_query', parsed.error);
    ({ flightNumber, dateLocal } = parsed);
  } else {
    ({ flightNumber, dateLocal } = request);
  }

  const designator = parseFlightDesignator(flightNumber);
  if (designator === null) {
    throw new ApiError('invalid_query', `"${flightNumber}" is not a flight number.`);
  }

  return flightLookupResponseSchema.parse({
    candidates: mockCandidates(designator.designator, dateLocal),
  });
}

/**
 * Writes to the in-memory store so the dashboard has something to render —
 * mock mode is only useful if it reaches the flight card, not just the lookup.
 */
function mockAdd(request: AddFlightRequest): AddFlightResponse {
  return addFlightResponseSchema.parse(addMockSegment(request.candidate));
}

// ------------------------------------------------------------------- public --

/**
 * `POST /v1/flights/lookup`. Returns 0, 1 or many candidates — a flight number
 * can operate several legs on one date (§3.1, §8.12). The caller disambiguates.
 */
export async function lookupFlights(
  request: FlightLookupRequest,
  signal?: AbortSignal,
): Promise<FlightLookupResponse> {
  if (MOCK_API) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return mockLookup(request);
  }
  return post('/flights/lookup', request, (value) => flightLookupResponseSchema.parse(value), signal);
}

/**
 * `POST /v1/flights`. `candidate` is the exact one the user picked; the server
 * re-validates it against the provider before ingesting, so nothing here needs
 * to be trusted. `tripId` appends a segment to an existing trip (layovers).
 */
export async function addFlight(
  request: AddFlightRequest,
  signal?: AbortSignal,
): Promise<AddFlightResponse> {
  if (MOCK_API) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return mockAdd(request);
  }
  return post('/flights', request, (value) => addFlightResponseSchema.parse(value), signal);
}

/** Best-effort human-readable text for anything thrown by this module. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return 'Something went wrong.';
}
