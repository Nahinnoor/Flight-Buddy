/**
 * AeroDataBox enums as the **webhook** serializer writes them: integers.
 *
 * The lookup REST API and the documented contract write every enum as its
 * string name (`"EnRoute"`). The alert delivery serializer writes the same
 * enums as integers (`2`) — observed in the first real captured delivery,
 * 2026-09-18 (`docs/api-samples/webhook-delivery-real-enroute.json`). The
 * integer meanings are not guessed: AeroDataBox's own OpenAPI spec
 * (`https://api.market/store/aedbx/aerodatabox/openapi.yaml`, read 2026-09-18)
 * numbers every member in each schema's description, and its `enum` array lists
 * them in the same order. Each table below is that list, index = integer, and
 * names the spec schema it was copied from.
 *
 * This file is the one place those numbers live. `notification.ts` uses it to
 * turn a delivery's integers back into the string names the mapper already
 * understands, so a webhook and a poll go through one mapping (§8.2).
 *
 * ## An integer outside a table
 *
 * Decodes to `Unknown` and is reported by field path (never by value). It never
 * throws and never guesses: a wrong guess at an enum's numbering turns an
 * on-time departure into a cancellation. `Unknown` is not a member of every
 * provider enum (movement quality has none); nothing downstream reads those as
 * anything but opaque.
 *
 * **`status` is the exception.** `parseAlertDelivery` drops a leg whose status
 * code is outside the table instead of recording it as `unknown`: the change
 * detector fires `cancelled`/`diverted` on the edge into them, so a status wiped
 * to `unknown` and then restored would emit the event twice. The other enums
 * drive no event and degrade in place.
 */
import { z } from 'zod';

/** Spec schema `FlightStatus`. */
export const FLIGHT_STATUS_BY_CODE = [
  'Unknown', // 0
  'Expected', // 1
  'EnRoute', // 2
  'CheckIn', // 3
  'Boarding', // 4
  'GateClosed', // 5
  'Departed', // 6
  'Delayed', // 7
  'Approaching', // 8
  'Arrived', // 9
  'Canceled', // 10
  'Diverted', // 11
  'CanceledUncertain', // 12
] as const;

/** Spec schema `CodeshareStatus`. */
export const CODESHARE_STATUS_BY_CODE = [
  'Unknown', // 0
  'IsOperator', // 1
  'IsCodeshared', // 2
] as const;

/** Spec schema `FlightAirportMovementQualityEnum` (`departure.quality[]`, `arrival.quality[]`). */
export const MOVEMENT_QUALITY_BY_CODE = [
  'Basic', // 0
  'Live', // 1
  'Approximate', // 2
] as const;

/** Spec schema `SubscriptionBillingType` (`subscription.billingType`). */
export const SUBSCRIPTION_BILLING_TYPE_BY_CODE = [
  'LifetimeBased', // 0 (deprecated)
  'CreditBased', // 1
] as const;

/** Spec schema `SubscriptionSubjectType` (`subscription.subject.type`). */
export const SUBSCRIPTION_SUBJECT_TYPE_BY_CODE = [
  'FlightByNumber', // 0
  'FlightByAirportIcao', // 1
] as const;

/** What an integer outside its table reads as. */
export const UNRECOGNISED_ENUM_NAME = 'Unknown';

/**
 * An enum on the wire: the documented string name, or its integer. Any other
 * JSON type is still refused — only the two encodings the provider is known to
 * use are accepted.
 */
export const enumWireSchema = z.union([z.string(), z.number()]);

export type EnumWire = z.infer<typeof enumWireSchema>;

/**
 * The string name for a wire value.
 *
 * - A string is returned unchanged; whether it is a known name is the mapper's
 *   business (an unknown one degrades to `unknown` there, as for a lookup).
 * - An integer inside `table` becomes its name.
 * - Any other number (out of range, negative, fractional) becomes
 *   `UNRECOGNISED_ENUM_NAME` and `onUnrecognised` is called — with nothing, so
 *   a caller can only report the field it asked about, never the value.
 */
export function enumName(
  table: readonly string[],
  value: EnumWire,
  onUnrecognised: () => void,
): string {
  if (typeof value === 'string') return value;
  if (Number.isInteger(value) && value >= 0 && value < table.length) {
    return table[value] as string;
  }
  onUnrecognised();
  return UNRECOGNISED_ENUM_NAME;
}
