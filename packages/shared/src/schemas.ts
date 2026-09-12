/**
 * Zod schemas for everything that crosses a boundary: provider → API → client.
 *
 * Parse at the edge, then trust the type. The provider package validates
 * candidates before they reach the domain (§7.1: no AeroDataBox response shape
 * may leak into the domain model), and the API validates request bodies before
 * anything touches Postgres.
 */
import { z } from 'zod';

import {
  FLIGHT_STATUSES,
  MEMBERSHIP_STATUSES,
  TRACKING_TIERS,
  type FlightCandidate,
} from './types';
import { isValidTimeZone } from './time';

type Assert<T extends true> = T;

// ---------- primitives ----------

/** Airline IATA designator: two alphanumerics, uppercase, e.g. "DL", "9W". */
export const carrierIataSchema = z
  .string()
  .regex(/^[A-Z0-9]{2}$/, 'expected a 2-character IATA airline code');

/** Bare flight number without the carrier prefix, e.g. "8517", "1A". */
export const flightNumberSchema = z
  .string()
  .regex(/^[0-9]{1,4}[A-Z]?$/, 'expected a 1-4 digit flight number');

/** Airport IATA code, e.g. "JFK". */
export const airportIataSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'expected a 3-letter IATA airport code');

/** Airport ICAO code, e.g. "KJFK". */
export const airportIcaoSchema = z
  .string()
  .regex(/^[A-Z]{4}$/, 'expected a 4-letter ICAO airport code');

/** IANA zone name, validated against the runtime's own ICU data. */
export const ianaTimeZoneSchema = z
  .string()
  .refine(isValidTimeZone, 'expected an IANA time zone, e.g. America/New_York');

/** Local calendar date at the origin airport, `YYYY-MM-DD` (§6.3). */
export const localDateSchema = z.iso.date();

/** UTC instant, ISO-8601 with a `Z` offset. Everything is stored UTC (§8.4). */
export const utcInstantSchema = z.iso.datetime();

const nullableUtcInstant = utcInstantSchema.nullable();

export const trackingTierSchema = z.enum(TRACKING_TIERS);
export const flightStatusSchema = z.enum(FLIGHT_STATUSES);
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);

// ---------- flight candidate ----------

/** The provider → API → client wire shape. Mirrors `FlightCandidate` exactly. */
export const flightCandidateSchema = z.object({
  marketingCarrierIata: carrierIataSchema,
  marketingFlightNumber: flightNumberSchema,
  operatingCarrierIata: carrierIataSchema,
  operatingFlightNumber: flightNumberSchema,
  departureDateLocal: localDateSchema,

  originIata: airportIataSchema,
  destinationIata: airportIataSchema,
  originIcao: airportIcaoSchema.optional(),
  destinationIcao: airportIcaoSchema.optional(),
  originTz: ianaTimeZoneSchema,
  destinationTz: ianaTimeZoneSchema,
  originName: z.string().min(1).optional(),
  destinationName: z.string().min(1).optional(),

  scheduledDepartureUtc: nullableUtcInstant,
  estimatedDepartureUtc: nullableUtcInstant,
  actualDepartureUtc: nullableUtcInstant,
  scheduledArrivalUtc: nullableUtcInstant,
  estimatedArrivalUtc: nullableUtcInstant,
  actualArrivalUtc: nullableUtcInstant,

  status: flightStatusSchema,
  trackingTier: trackingTierSchema,

  gate: z.string().nullable(),
  terminal: z.string().nullable(),

  aircraftReg: z.string().nullable(),
  aircraftModel: z.string().nullable(),
});

/**
 * Compile-time proof that the schema and the hand-written type cannot drift:
 * this alias stops compiling if either side gains, loses or renames a field.
 */
export type FlightCandidateContractChecked = [
  Assert<z.infer<typeof flightCandidateSchema> extends FlightCandidate ? true : false>,
  Assert<FlightCandidate extends z.infer<typeof flightCandidateSchema> ? true : false>,
];

/** A lookup returns an array — a number can operate several legs a day (§8.12). */
export const flightCandidateListSchema = z.array(flightCandidateSchema);

// ---------- free-text flight query ----------

/**
 * Input to the free-text parser behind the add-flight field (§3.1): the user
 * types `DL1234 Mar 12` or `DL1234 tomorrow`.
 *
 * `today` and `timeZone` are what a relative date is resolved against. They are
 * optional and supplied by the caller — the device's own date and zone —
 * because the server's local time is never used for anything (§8.4).
 */
export const flightQueryInputSchema = z.object({
  query: z.string().trim().min(2).max(120),
  today: localDateSchema.optional(),
  timeZone: ianaTimeZoneSchema.optional(),
});
export type FlightQueryInput = z.infer<typeof flightQueryInputSchema>;

/** Full designator as typed, e.g. "DL1234" or "DL 1234". */
export const flightDesignatorSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9]{2} ?[0-9]{1,4}[A-Z]?$/, 'expected a flight number such as DL1234');

/** The explicit form of a lookup: number plus the local date at the origin. */
export const flightLookupByNumberSchema = z.object({
  flightNumber: flightDesignatorSchema,
  dateLocal: localDateSchema,
});
export type FlightLookupByNumber = z.infer<typeof flightLookupByNumberSchema>;

/**
 * Body of `POST /v1/flights/lookup` (ADR 0001): free text, or an already split
 * number and date.
 */
export const flightLookupRequestSchema = z.union([
  flightQueryInputSchema,
  flightLookupByNumberSchema,
]);
export type FlightLookupRequest = z.infer<typeof flightLookupRequestSchema>;

/** What the parser yields and what the provider is called with (§7.1). */
export const flightLookupSchema = z.object({
  carrierIata: carrierIataSchema,
  flightNumber: flightNumberSchema,
  departureDateLocal: localDateSchema,
});
export type FlightLookup = z.infer<typeof flightLookupSchema>;

/** A lookup answers with an array, possibly empty. Never pick `[0]` (§8.12). */
export const flightLookupResponseSchema = z.object({
  candidates: flightCandidateListSchema,
});
export type FlightLookupResponse = z.infer<typeof flightLookupResponseSchema>;

// ---------- add flight ----------

/**
 * Body of `POST /v1/flights` (ADR 0001): the exact candidate the user picked
 * from the disambiguation list, plus an optional existing trip to append to
 * (layovers). A `manual`-tier flight is added the same way — it still gets a
 * `flights` row (§6.3) — with user-supplied times on the candidate.
 *
 * The server re-validates the candidate against the provider before ingesting,
 * so a client cannot forge times, and resolves the codeshare before insert
 * (§7.2). Handlers never write `flights` directly (§12.7).
 */
export const addFlightRequestSchema = z.object({
  candidate: flightCandidateSchema,
  tripId: z.uuid().optional(),
});
export type AddFlightRequest = z.infer<typeof addFlightRequestSchema>;

export const addFlightResponseSchema = z.object({
  tripId: z.uuid(),
  segmentId: z.uuid(),
  flightId: z.uuid(),
  sequenceNumber: z.int().min(1),
});
export type AddFlightResponse = z.infer<typeof addFlightResponseSchema>;

/** Error envelope shared by every endpoint (ADR 0001). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
