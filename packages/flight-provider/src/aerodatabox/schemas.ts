/**
 * Loose zod schemas for the AeroDataBox wire format.
 *
 * Deliberately permissive: every object is `looseObject` and every field this
 * package does not read is simply absent from the schema. The provider adds
 * fields without warning, and a validation error on a field we never look at
 * would take out a lookup for nothing.
 *
 * Enums arrive as plain `string` for the same reason — a new `FlightStatus`
 * member must degrade to `'unknown'` in the mapper, not throw here.
 *
 * These types stop at this directory. Nothing above `aerodatabox/` may name
 * them (§7.1).
 */
import { z } from 'zod';

/**
 * An instant in both zones. Note the format: AeroDataBox emits
 * `"2026-09-12 01:59Z"` and `"2026-09-11 21:59-04:00"` — a space, not the
 * ISO-8601 `T`, and no seconds. The mapper normalises; nothing else should
 * touch these strings.
 */
export const dateTimeSchema = z.looseObject({
  utc: z.string().nullish(),
  local: z.string().nullish(),
});

export const airportSchema = z.looseObject({
  icao: z.string().nullish(),
  iata: z.string().nullish(),
  name: z.string().nullish(),
  shortName: z.string().nullish(),
  municipalityName: z.string().nullish(),
  countryCode: z.string().nullish(),
  timeZone: z.string().nullish(),
});

export const movementSchema = z.looseObject({
  airport: airportSchema.nullish(),
  scheduledTime: dateTimeSchema.nullish(),
  revisedTime: dateTimeSchema.nullish(),
  runwayTime: dateTimeSchema.nullish(),
  terminal: z.string().nullish(),
  gate: z.string().nullish(),
  quality: z.array(z.string()).nullish(),
});

export const aircraftSchema = z.looseObject({
  reg: z.string().nullish(),
  modeS: z.string().nullish(),
  model: z.string().nullish(),
});

export const airlineSchema = z.looseObject({
  name: z.string().nullish(),
  iata: z.string().nullish(),
  icao: z.string().nullish(),
});

export const flightSchema = z.looseObject({
  number: z.string(),
  callSign: z.string().nullish(),
  status: z.string().nullish(),
  codeshareStatus: z.string().nullish(),
  isCargo: z.boolean().nullish(),
  departure: movementSchema.nullish(),
  arrival: movementSchema.nullish(),
  aircraft: aircraftSchema.nullish(),
  airline: airlineSchema.nullish(),
  lastUpdatedUtc: z.string().nullish(),
});

/** `GET /flights/number/{number}/{dateLocal}` answers with an array (§8.12). */
export const flightListSchema = z.array(flightSchema);

const feedServiceSchema = z.looseObject({
  service: z.string().nullish(),
  status: z.string().nullish(),
});

/** `GET /health/services/airports/{icao}/feeds`. */
export const airportFeedsSchema = z.looseObject({
  flightSchedulesFeed: feedServiceSchema.nullish(),
  liveFlightUpdatesFeed: feedServiceSchema.nullish(),
  adsbUpdatesFeed: feedServiceSchema.nullish(),
  generalAvailability: z
    .looseObject({
      minAvailableLocalDate: z.string().nullish(),
      maxAvailableLocalDate: z.string().nullish(),
    })
    .nullish(),
});

/** `GET /subscriptions/balance` and `POST /subscriptions/balance/refill`. */
export const balanceSchema = z.looseObject({
  creditsRemaining: z.number(),
  lastRefilledUtc: z.string().nullish(),
  lastDeductedUtc: z.string().nullish(),
});

/** `POST /subscriptions/webhook/{subjectType}/{subjectId}`. */
export const subscriptionSchema = z.looseObject({
  id: z.string(),
  isActive: z.boolean().nullish(),
});

export type AeroDataBoxFlight = z.infer<typeof flightSchema>;
export type AeroDataBoxMovement = z.infer<typeof movementSchema>;
export type AeroDataBoxAirportFeeds = z.infer<typeof airportFeedsSchema>;
