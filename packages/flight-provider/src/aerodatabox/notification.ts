/**
 * AeroDataBox webhook delivery → `AlertDelivery` (§7.6).
 *
 * The receiver in `apps/api` validates a delivery and stores it in
 * `webhook_inbox`; the worker re-validates it here before anything is written
 * (defence in depth — a row in a table is not proof it came through the
 * receiver). The contract is the one documented in
 * `docs/api-samples/webhook-notification-schema.md`.
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
 *
 * Everything else goes through `toFlightCandidate`, the mapper a lookup uses, so
 * a webhook and a poll of the same flight produce the same candidate — which is
 * what lets change detection compare them (§8.2).
 */
import type { FlightCandidate } from '@flightbuddy/shared';

import { ProviderDataError } from '../errors';
import type { AlertDelivery } from '../provider';
import { toFlightCandidate } from './mapper';
import { flightNotificationSchema } from './schemas';

/**
 * Validate and map one delivery body.
 *
 * @param payload The JSON body, already parsed (an inbox row's `payload`).
 * @throws ProviderDataError when the body does not match the documented contract.
 */
export function parseAlertDelivery(payload: unknown): AlertDelivery {
  const parsed = flightNotificationSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderDataError('Alert delivery does not match the documented contract.');
  }

  const legs: FlightCandidate[] = [];
  let unmappedCount = 0;

  for (const item of parsed.data.flights) {
    // Provider free text stops here (see the module note).
    const { notificationSummary: _summary, notificationRemark: _remark, ...flight } = item;
    try {
      // The item's own number is the subscribed (operating) flight, so it is both
      // the "typed" and the operating designator — no marketing number is involved.
      legs.push(toFlightCandidate(flight, flight.number));
    } catch (error) {
      if (!(error instanceof ProviderDataError)) throw error;
      unmappedCount += 1;
    }
  }

  return {
    subscriptionId: parsed.data.subscription.id,
    creditsRemaining: parsed.data.balance?.creditsRemaining ?? null,
    legs,
    unmappedCount,
  };
}
