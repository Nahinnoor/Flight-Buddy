/**
 * Domain types shared by the mobile client, the API and the poller.
 *
 * These mirror the Postgres enums and the flight row in PROJECT_OVERVIEW §6.2.
 * Wire shapes are camelCase; the database is snake_case. Conversion happens at
 * the edge (see `database.types.ts`), never in the middle of the app.
 */

/** `tracking_tier` enum. See §7.3. */
export const TRACKING_TIERS = ['live', 'scheduled', 'manual'] as const;
export type TrackingTier = (typeof TRACKING_TIERS)[number];

/** `flight_status` enum. See §6.2. */
export const FLIGHT_STATUSES = [
  'scheduled',
  'delayed',
  'boarding',
  'departed',
  'en_route',
  'diverted',
  'landed',
  'cancelled',
  'unknown',
] as const;
export type FlightStatus = (typeof FLIGHT_STATUSES)[number];

/** `membership_status` enum. See §6.2. */
export const MEMBERSHIP_STATUSES = ['pending', 'active', 'removed'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * The wire shape between `@flightbuddy/flight-provider`, the API and the mobile
 * client. One candidate is one leg: a flight number can operate several legs on
 * one date, so lookups return an array (§3.1, §8.12).
 *
 * Rules that this shape encodes:
 * - The marketing number is what the user typed and what the UI shows first;
 *   the operating number is the canonical identity after codeshare resolution
 *   (§7.2). Never silently swap one for the other.
 * - `departureDateLocal` is the local date at the ORIGIN airport, not UTC
 *   (§6.3). A 23:50 JFK departure is one date locally and the next in UTC.
 * - Every timestamp is UTC ISO-8601. Display is airport-local with a zone
 *   label, computed from `originTz` / `destinationTz` (§8.4).
 */
export interface FlightCandidate {
  /** What the user typed, e.g. "DL". */
  marketingCarrierIata: string;
  /** What the user typed, e.g. "8517". */
  marketingFlightNumber: string;
  /** After codeshare resolution, e.g. "AF". */
  operatingCarrierIata: string;
  /** After codeshare resolution, e.g. "3612". */
  operatingFlightNumber: string;
  /** YYYY-MM-DD, local at the origin airport. */
  departureDateLocal: string;

  originIata: string;
  destinationIata: string;
  originIcao?: string;
  destinationIcao?: string;
  /** IANA zone, e.g. "America/New_York". */
  originTz: string;
  /** IANA zone, e.g. "Europe/Paris". */
  destinationTz: string;
  originName?: string;
  destinationName?: string;

  scheduledDepartureUtc: string | null;
  estimatedDepartureUtc: string | null;
  actualDepartureUtc: string | null;
  scheduledArrivalUtc: string | null;
  estimatedArrivalUtc: string | null;
  actualArrivalUtc: string | null;

  status: FlightStatus;
  trackingTier: TrackingTier;

  gate: string | null;
  terminal: string | null;

  aircraftReg: string | null;
  aircraftModel: string | null;

  /**
   * Great-circle distance origin → destination, whole kilometres, 0–20100.
   * `null` or absent when the provider gave no usable value; always absent for
   * candidates that did not come from the provider (e.g. manual-tier flights).
   * Stored as `flights.distance_km`.
   */
  distanceKm?: number | null;
  /**
   * ISO 3166-1 alpha-2 country of the origin airport, UPPERCASE (e.g. "GB").
   * `null` or absent when unknown. Stored as `flights.origin_country_code`.
   */
  originCountryCode?: string | null;
  /** As `originCountryCode`, for the destination. `flights.destination_country_code`. */
  destinationCountryCode?: string | null;
}

/** Upper bound for `distanceKm`: half the Earth's circumference (~20,038 km) plus margin. */
export const MAX_GREAT_CIRCLE_KM = 20_100;
