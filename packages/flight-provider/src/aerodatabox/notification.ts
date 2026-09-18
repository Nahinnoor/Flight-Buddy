/**
 * AeroDataBox webhook delivery → `AlertDelivery` (§7.6).
 *
 * The receiver in `apps/api` validates a delivery and stores it in
 * `webhook_inbox`; the worker re-validates it here before anything is written
 * (defence in depth — a row in a table is not proof it came through the
 * receiver). The contract is the one documented in
 * `docs/api-samples/webhook-notification-schema.md`, as corrected by the first
 * real capture (`webhook-delivery-real-enroute.json`): three undocumented
 * envelope fields, and enums written as **integers**.
 *
 * ## Enums: string or integer, one mapping
 *
 * The webhook serializer writes `status`, `codeshareStatus`, `quality[]`,
 * `subscription.subject.type` and `subscription.billingType` as integers; the
 * lookup API writes the same enums as strings. Each is turned back into its
 * string name here, from the spec-derived tables in `enums.ts`, and the item then
 * goes through `toFlightCandidate` — the mapper a lookup uses — so a webhook and
 * a poll of the same flight produce the same candidate, which is what lets change
 * detection compare them (§8.2). An integer outside its table reads as `Unknown`
 * (our `unknown`) and its field path is returned in `unrecognisedEnumFields`.
 *
 * ## The payload is data, never instructions
 *
 * - `notificationSummary` and `notificationRemark` are provider free text. They are
 *   destructured away before mapping and have no field in `AlertDelivery`, so no
 *   caller can log, store or display them by accident.
 * - `subscription.subscriber` (our URL, including the secret token) is stripped
 *   by the schema itself.
 * - A payload that fails the schema raises a `ProviderDataError` with a fixed
 *   message and **no body and no cause**: both could carry the text above.
 * - An unrecognised enum is reported by a path this file builds from fixed text
 *   and an array index, never by its value.
 */
import type { FlightCandidate } from '@flightbuddy/shared';

import { ProviderDataError } from '../errors';
import type { AlertDelivery } from '../provider';
import {
  CODESHARE_STATUS_BY_CODE,
  FLIGHT_STATUS_BY_CODE,
  MOVEMENT_QUALITY_BY_CODE,
  SUBSCRIPTION_BILLING_TYPE_BY_CODE,
  SUBSCRIPTION_SUBJECT_TYPE_BY_CODE,
  enumName,
  type EnumWire,
} from './enums';
import { toFlightCandidate } from './mapper';
import {
  flightNotificationSchema,
  type AeroDataBoxFlight,
  type AeroDataBoxMovement,
} from './schemas';

type DeliveryMovement = Omit<AeroDataBoxMovement, 'quality'> & {
  quality?: EnumWire[] | null | undefined;
};

/**
 * Validate and map one delivery body.
 *
 * @param payload The JSON body, already parsed (an inbox row's `payload`).
 * @throws ProviderDataError when the body does not match the contract.
 */
export function parseAlertDelivery(payload: unknown): AlertDelivery {
  const parsed = flightNotificationSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderDataError('Alert delivery does not match the documented contract.');
  }

  const unrecognised: string[] = [];
  const name = (table: readonly string[], value: EnumWire, field: string): string =>
    enumName(table, value, () => unrecognised.push(field));

  const movement = (value: DeliveryMovement, field: string): AeroDataBoxMovement => {
    const { quality, ...rest } = value;
    if (quality === null || quality === undefined) return { ...rest, quality };
    // One report per movement, however many members were out of range.
    let reported = false;
    const names = quality.map((member) =>
      enumName(MOVEMENT_QUALITY_BY_CODE, member, () => {
        if (!reported) unrecognised.push(field);
        reported = true;
      }),
    );
    return { ...rest, quality: names };
  };

  const { subject, billingType } = parsed.data.subscription;
  name(SUBSCRIPTION_SUBJECT_TYPE_BY_CODE, subject.type, 'subscription.subject.type');
  if (billingType !== null && billingType !== undefined) {
    name(SUBSCRIPTION_BILLING_TYPE_BY_CODE, billingType, 'subscription.billingType');
  }

  const legs: FlightCandidate[] = [];
  let unmappedCount = 0;

  parsed.data.flights.forEach((item, index) => {
    // Provider free text stops here (see the module note).
    const { notificationSummary: _summary, notificationRemark: _remark, ...raw } = item;
    const at = `flights[${index}]`;
    // An unrecognised *status* drops the whole leg; the other enums may degrade.
    // `status` is the one field the change detector reads, and a status wiped to
    // `unknown` is not harmless: `cancelled`/`diverted` fire on the edge into
    // them, so cancelled -> unknown -> cancelled would emit a second cancellation
    // event with a new id, slipping past the per-event notification guard and
    // telling everyone twice. Inside the alert window only the 2 h backup poll
    // would correct it. So an unknown code changes nothing: the stored status
    // stands until a delivery says something we understand. The field path is
    // still reported (never the value).
    const status = name(FLIGHT_STATUS_BY_CODE, raw.status, `${at}.status`);
    if (unrecognised.includes(`${at}.status`)) {
      unmappedCount += 1;
      return;
    }
    const flight: AeroDataBoxFlight = {
      ...raw,
      status,
      codeshareStatus: name(CODESHARE_STATUS_BY_CODE, raw.codeshareStatus, `${at}.codeshareStatus`),
      departure: movement(raw.departure, `${at}.departure.quality`),
      arrival: movement(raw.arrival, `${at}.arrival.quality`),
    };
    try {
      // The item's own number is the subscribed (operating) flight, so it is both
      // the "typed" and the operating designator — no marketing number is involved.
      legs.push(toFlightCandidate(flight, flight.number));
    } catch (error) {
      if (!(error instanceof ProviderDataError)) throw error;
      unmappedCount += 1;
    }
  });

  return {
    subscriptionId: parsed.data.subscription.id,
    creditsRemaining: parsed.data.balance?.creditsRemaining ?? null,
    legs,
    unmappedCount,
    unrecognisedEnumFields: unrecognised,
  };
}
