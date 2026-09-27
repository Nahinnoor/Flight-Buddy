/**
 * AeroDataBox → `FlightCandidate`.
 *
 * This is the only file that knows what an AeroDataBox response looks like.
 * Everything it produces is the shared contract (§7.1).
 *
 * ## Codeshare resolution (§7.2)
 *
 * Measured against the live API, not assumed: `GET /flights/number/{n}/{date}`
 * resolves codeshares server-side. Asking for the marketing number `DL9659`
 * returns `number: "KL 1405"`, `airline: KLM`, `codeshareStatus: "IsOperator"`
 * — the operating flight, already resolved. So the candidate that leaves this
 * function *is* the resolved form, which is what §7.2 requires (resolve before
 * insert, never after).
 *
 * The marketing pair is therefore taken from what the user typed and the
 * operating pair from the response. When the typed number is already the
 * operating flight the two are equal, which is the common case.
 *
 * The one degraded path: if the response still carries
 * `codeshareStatus: "IsCodeshared"`, the provider did *not* resolve it and
 * there is no operating number anywhere in the contract — `FlightContract` has
 * no codeshare block, only an aircraft registration shared with the operating
 * flight. In that case the marketing number is the best canonical identity
 * available and both pairs are set from it. Never silently invent one.
 */
import {
  MAX_GREAT_CIRCLE_KM,
  localDateAtAirport,
  parseFlightDesignator,
  type FlightCandidate,
  type FlightStatus,
} from '@flightbuddy/shared';

import { ProviderDataError } from '../errors';
import type { AeroDataBoxFlight, AeroDataBoxMovement } from './schemas';

/**
 * AeroDataBox `FlightStatus` → the `flight_status` enum in §6.2.
 *
 * | AeroDataBox         | FlightBuddy  | Why |
 * |---------------------|--------------|-----|
 * | `Expected`          | `scheduled`  | The normal pre-departure state. |
 * | `CheckIn`           | `scheduled`  | Check-in open is not yet a boarding event; §9 notifies on boarding. |
 * | `Boarding`          | `boarding`   | Direct. |
 * | `GateClosed`        | `boarding`   | Still at the gate, still the boarding phase. No `gate_closed` event exists. |
 * | `Departed`          | `departed`   | Direct. |
 * | `EnRoute`           | `en_route`   | Direct. |
 * | `Approaching`       | `en_route`   | Airborne. The arrival countdown, not a separate state. |
 * | `Delayed`           | `delayed`    | Direct. |
 * | `Arrived`           | `landed`     | Direct. |
 * | `Canceled`          | `cancelled`  | Direct. |
 * | `Diverted`          | `diverted`   | Direct. |
 * | `CanceledUncertain` | `unknown`    | "May be cancelled". Mapping it to `cancelled` would push a cancellation notification off a guess; §8.2 says compare before emitting. |
 * | `Unknown`, anything else | `unknown` | Unrecognised provider values degrade rather than throw. |
 */
const STATUS_MAP: Readonly<Record<string, FlightStatus>> = {
  Unknown: 'unknown',
  Expected: 'scheduled',
  CheckIn: 'scheduled',
  Boarding: 'boarding',
  GateClosed: 'boarding',
  Departed: 'departed',
  EnRoute: 'en_route',
  Approaching: 'en_route',
  Delayed: 'delayed',
  Arrived: 'landed',
  Canceled: 'cancelled',
  CanceledUncertain: 'unknown',
  Diverted: 'diverted',
};

/** Provider statuses that mean the aircraft has physically left the gate. */
const AFTER_DEPARTURE = new Set(['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Diverted']);

/** Provider statuses that mean the aircraft is on the ground at destination. */
const AFTER_ARRIVAL = new Set(['Arrived']);

export function mapStatus(providerStatus: string | null | undefined): FlightStatus {
  if (providerStatus === null || providerStatus === undefined) return 'unknown';
  return STATUS_MAP[providerStatus] ?? 'unknown';
}

/**
 * Normalise an AeroDataBox timestamp to a UTC ISO-8601 string ending in `Z`.
 *
 * The provider emits `"2026-09-12 01:59Z"` and `"2026-09-11 21:59-04:00"`:
 * a space where ISO-8601 wants `T`, and no seconds. `Date` rejects the first
 * form outright on some engines, so the space is replaced before parsing.
 */
export function toUtcIso(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = new Date(trimmed.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** The `YYYY-MM-DD` prefix of a local time string, or `null`. */
function localDatePart(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match === null ? null : (match[1] as string);
}

function upperOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed === '' ? null : trimmed;
}

function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The great-circle distance in whole kilometres, or `null`.
 *
 * The lookup API writes `greatCircleDistance.km`; the webhook serializer writes
 * the same object with PascalCase keys (`Km`). Lowercase wins when both exist.
 * Provider data is untrusted input, so anything that is not a finite number in
 * `[0, MAX_GREAT_CIRCLE_KM]` — a string, NaN, a negative, a distance longer than
 * half the planet — is `null`, never a thrown error: a bad distance must not
 * cost the user their flight.
 */
export function greatCircleKm(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const own = (key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
  const km = own('km') ? record.km : own('Km') ? record.Km : null;
  if (typeof km !== 'number' || !Number.isFinite(km)) return null;
  if (km < 0 || km > MAX_GREAT_CIRCLE_KM) return null;
  return Math.round(km);
}

/**
 * An ISO 3166-1 alpha-2 code, uppercased (`"gb"` → `"GB"`), or `null`.
 *
 * Exactly two ASCII letters or nothing: no trimming, no longer codes, no
 * guessing. The column's check constraint enforces the same shape.
 */
export function countryCodeOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) return null;
  return value.toUpperCase();
}

/**
 * The origin-local departure date (§6.3).
 *
 * Read from the provider's own local string rather than derived from the UTC
 * instant, because that string is what AeroDataBox keys the flight on. The UTC
 * conversion is a fallback for the rare movement that carries only `utc`.
 */
function departureDateLocal(departure: AeroDataBoxMovement, originTz: string): string {
  const fromLocal =
    localDatePart(departure.scheduledTime?.local) ??
    localDatePart(departure.revisedTime?.local) ??
    localDatePart(departure.runwayTime?.local);
  if (fromLocal !== null) return fromLocal;

  const utc =
    toUtcIso(departure.scheduledTime?.utc) ??
    toUtcIso(departure.revisedTime?.utc) ??
    toUtcIso(departure.runwayTime?.utc);
  if (utc === null) {
    throw new ProviderDataError('Flight has no departure time, so it has no local date.');
  }
  return localDateAtAirport(utc, originTz);
}

interface ResolvedAirport {
  iata: string;
  icao: string | undefined;
  tz: string;
  name: string | undefined;
  countryCode: string | null;
}

function resolveAirport(
  movement: AeroDataBoxMovement | null | undefined,
  side: 'departure' | 'arrival',
): ResolvedAirport {
  const airport = movement?.airport;
  const iata = upperOrNull(airport?.iata);
  const tz = textOrNull(airport?.timeZone);
  // Both are load-bearing: `origin_iata` is part of the canonical unique key
  // (§6.2) and the zone is what every display in the app formats against
  // (§8.4). A leg without them cannot be stored, so it is not a candidate.
  if (iata === null || !/^[A-Z]{3}$/.test(iata)) {
    throw new ProviderDataError(`Flight ${side} has no IATA airport code.`);
  }
  if (tz === null) {
    throw new ProviderDataError(`Flight ${side} airport ${iata} has no time zone.`);
  }
  const icao = upperOrNull(airport?.icao);
  return {
    iata,
    icao: icao !== null && /^[A-Z]{4}$/.test(icao) ? icao : undefined,
    tz,
    name: textOrNull(airport?.name) ?? undefined,
    countryCode: countryCodeOrNull(airport?.countryCode),
  };
}

/**
 * Turn one provider flight into one candidate leg.
 *
 * @param raw One element of the `/flights/number/...` array.
 * @param typedNumber The designator the user typed, e.g. `"dl 9659"`. It
 *   becomes the marketing pair and is never overwritten by the operating one
 *   (§7.2: never silently swap the number the user typed).
 * @throws ProviderDataError when the leg cannot be expressed as a candidate.
 */
export function toFlightCandidate(raw: AeroDataBoxFlight, typedNumber: string): FlightCandidate {
  const marketing = parseFlightDesignator(typedNumber);
  if (marketing === null) {
    throw new ProviderDataError(`"${typedNumber}" is not a flight number.`);
  }

  // The response's own number is the operating flight — see the file comment.
  const operating = parseFlightDesignator(raw.number) ?? marketing;

  const departure = raw.departure;
  const arrival = raw.arrival;
  if (departure === null || departure === undefined) {
    throw new ProviderDataError('Flight has no departure information.');
  }
  if (arrival === null || arrival === undefined) {
    throw new ProviderDataError('Flight has no arrival information.');
  }
  const origin = resolveAirport(departure, 'departure');
  const destination = resolveAirport(arrival, 'arrival');

  const providerStatus = raw.status ?? null;
  const hasDeparted = providerStatus !== null && AFTER_DEPARTURE.has(providerStatus);
  const hasArrived = providerStatus !== null && AFTER_ARRIVAL.has(providerStatus);

  // `revisedTime` is "actual OR estimated" and `runwayTime` is wheels up/down;
  // the provider never says which, so the status decides. Both are kept once
  // the flight has moved: `estimated*` stays comparable with `scheduled*` for
  // the delay calculation, `actual*` records what happened.
  const revisedDeparture = toUtcIso(departure.revisedTime?.utc);
  const runwayDeparture = toUtcIso(departure.runwayTime?.utc);
  const revisedArrival = toUtcIso(arrival.revisedTime?.utc);
  const runwayArrival = toUtcIso(arrival.runwayTime?.utc);

  return {
    marketingCarrierIata: marketing.carrierIata,
    marketingFlightNumber: marketing.flightNumber,
    operatingCarrierIata: operating.carrierIata,
    operatingFlightNumber: operating.flightNumber,
    departureDateLocal: departureDateLocal(departure, origin.tz),

    originIata: origin.iata,
    destinationIata: destination.iata,
    ...(origin.icao === undefined ? {} : { originIcao: origin.icao }),
    ...(destination.icao === undefined ? {} : { destinationIcao: destination.icao }),
    originTz: origin.tz,
    destinationTz: destination.tz,
    ...(origin.name === undefined ? {} : { originName: origin.name }),
    ...(destination.name === undefined ? {} : { destinationName: destination.name }),

    scheduledDepartureUtc: toUtcIso(departure.scheduledTime?.utc),
    estimatedDepartureUtc: revisedDeparture,
    actualDepartureUtc: hasDeparted ? (runwayDeparture ?? revisedDeparture) : null,
    scheduledArrivalUtc: toUtcIso(arrival.scheduledTime?.utc),
    estimatedArrivalUtc: revisedArrival,
    actualArrivalUtc: hasArrived ? (runwayArrival ?? revisedArrival) : null,

    status: mapStatus(providerStatus),
    // Overwritten by `lookupCandidates` once feed health is known (§7.3). The
    // conservative default is the one that keeps polling rather than trusting
    // alerts that may never arrive.
    trackingTier: 'scheduled',

    gate: textOrNull(departure.gate),
    terminal: textOrNull(departure.terminal),

    aircraftReg: upperOrNull(raw.aircraft?.reg),
    aircraftModel: textOrNull(raw.aircraft?.model),

    distanceKm: greatCircleKm(raw.greatCircleDistance),
    originCountryCode: origin.countryCode,
    destinationCountryCode: destination.countryCode,
  };
}
