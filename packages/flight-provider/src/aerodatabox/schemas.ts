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

// ---------------------------------------------------------------------------
// Alert API (2026, credit-based). Source: docs/api-samples/webhook-notification-schema.md
//
// Unlike the lookup schemas above these are **strict about what we read**: every
// documented required field must be present with its documented type, because
// these values steer money (subscriptions bill credits) and flight writes. Unknown
// keys are *stripped* (`z.object`), not passed through — and the two objects the
// spec marks `additionalProperties: false` (the delivery envelope and its items)
// reject unknown keys outright.
// ---------------------------------------------------------------------------

/**
 * `SubscriptionContract`: the create response, each element of the list response,
 * and `subscription` inside a delivery.
 *
 * `subscriber` is **deliberately not modelled**. It holds the URL we registered,
 * which contains the receiver's secret token; leaving it out of the schema means
 * zod strips it and it can never travel further than this parse.
 *
 * `z.guid()` rather than `z.uuid()`: the shape is checked strictly (the id goes
 * into a URL path and a `uuid` column) without rejecting a provider id whose
 * version nibble is not RFC 9562. Lower-cased so it compares equal to what
 * Postgres hands back for a `uuid`.
 */
export const subscriptionContractSchema = z.object({
  id: z.guid().transform((id) => id.toLowerCase()),
  isActive: z.boolean(),
  createdOnUtc: z.string(),
  subject: z.object({
    type: z.string(),
    id: z.string(),
  }),
});

/** `GET /subscriptions/webhook`: an array (or 204 with no body when empty). */
export const subscriptionListSchema = z.array(subscriptionContractSchema).max(10_000);

/** `SubscriptionBalanceContract` inside a delivery. `creditsRemaining` is int64. */
export const deliveryBalanceSchema = z.object({
  creditsRemaining: z.number().int(),
  lastRefilledUtc: z.string().nullish(),
  lastDeductedUtc: z.string().nullish(),
});

/**
 * `FlightNotificationItemContract`: a lookup `FlightContract` plus two strings of
 * provider free text. `additionalProperties: false` in the spec, so strict here.
 *
 * The nested movement/aircraft/airline objects reuse the lookup schemas, which
 * the mapper already understands; fields we never read are typed `unknown`.
 */
export const notificationItemSchema = z.strictObject({
  number: z.string(),
  status: z.string(),
  codeshareStatus: z.string(),
  isCargo: z.boolean(),
  lastUpdatedUtc: z.string(),
  departure: movementSchema,
  arrival: movementSchema,
  /** Provider free text. Data only: dropped in `parseAlertDelivery`, never logged or stored. */
  notificationSummary: z.string().nullish(),
  /** Provider free text. Data only: dropped in `parseAlertDelivery`, never logged or stored. */
  notificationRemark: z.string().nullish(),
  greatCircleDistance: z.unknown().optional(),
  flightPlan: z.unknown().optional(),
  callSign: z.string().nullish(),
  aircraft: aircraftSchema.nullish(),
  airline: airlineSchema.nullish(),
  location: z.unknown().optional(),
});

/**
 * `FlightNotificationContract`: the body AeroDataBox POSTs to the receiver.
 * `additionalProperties: false` in the spec, so strict here.
 *
 * `flights` is capped: billing is per item, so a real delivery is small, and the
 * cap bounds the work one inbox row can cause.
 */
export const flightNotificationSchema = z.strictObject({
  flights: z.array(notificationItemSchema).max(200),
  subscription: subscriptionContractSchema,
  balance: deliveryBalanceSchema.nullish(),
});

export type AeroDataBoxFlight = z.infer<typeof flightSchema>;
export type AeroDataBoxMovement = z.infer<typeof movementSchema>;
export type AeroDataBoxAirportFeeds = z.infer<typeof airportFeedsSchema>;
export type AeroDataBoxSubscription = z.infer<typeof subscriptionContractSchema>;
