/**
 * Which of one poll's (or one delivery's) detected events wake anybody (§9).
 *
 * `changeDetector.ts` records every §9 transition as a `flight_events` row — the
 * history is complete. This decides which of them become a push. The two differ
 * only where one poll sees several things at once, or sees news that no longer
 * matters by the time we saw it:
 *
 * - **An already-cancelled flight notifies nothing further.** The cancellation
 *   itself was the news; a gate or time moving on a cancelled flight is noise.
 * - **Once airborne, gate and delay news is moot.** A departure gate changing
 *   after pushback, or a delay seen in the same poll as the departure, would wake
 *   someone for something they can no longer act on; the `departed` push carries
 *   the actual take-off time instead.
 * - **Landed supersedes departed** when one poll spans the whole flight (a long
 *   back-off or a restart): one push, "landed", not two at the same instant.
 * - **Diverted supersedes landed** in the same poll: "landed at <destination>"
 *   would name the airport it did not land at.
 *
 * The §9 list itself — cancellation, delay over 30 minutes, gate change,
 * departed, landed, diverted — is exactly `FLIGHT_EVENT_TYPES`; the detector
 * emits nothing else (terminal-only changes, early estimates and a gate the
 * provider dropped are already silent there).
 *
 * A second guard lives in the fan-out SQL (`repository.ts`):
 * `ONCE_PER_FLIGHT_EVENT_TYPES` notify a user at most once per flight. It holds
 * only `departed` and `landed`, which physically happen once, so a status that
 * bounces through `unknown` cannot announce them twice.
 *
 * **`cancelled` and `diverted` are deliberately not in it.** A flight that is
 * cancelled, reinstated and cancelled again produces two `cancelled` events that
 * look exactly like a bounce at this layer, and the second is the one the
 * traveller must act on — §9 lets cancellations break through everything. So
 * every cancellation or diversion event notifies: a rare duplicate costs a
 * second buzz, a swallowed cancellation can cost someone the flight. The
 * bounce itself is fixed at its source, where "no information" must not
 * overwrite a known status (open task in STATUS).
 */
import type { FlightStatus } from '@flightbuddy/shared';

import { FLIGHT_EVENT_TYPES, type DetectedEvent, type FlightEventType } from './changeDetector';

/** Transitions that physically happen once per flight: notify once per user per flight. */
export const ONCE_PER_FLIGHT_EVENT_TYPES: readonly FlightEventType[] = ['departed', 'landed'];

const AIRBORNE_STATUSES: ReadonlySet<FlightStatus> = new Set<FlightStatus>([
  'departed',
  'en_route',
  'diverted',
  'landed',
]);

/** The fresh state the events were detected against. */
export interface PolicyState {
  status: FlightStatus;
  actualDepartureUtc: string | null;
}

/**
 * The event types in this batch that should notify, in `FLIGHT_EVENT_TYPES`
 * order. A batch never holds two events of one type (the detector keys by type).
 */
export function notifyingEventTypes(
  events: readonly Pick<DetectedEvent, 'type'>[],
  fresh: PolicyState,
): FlightEventType[] {
  const present = new Set(events.map((event) => event.type));

  if (fresh.status === 'cancelled') {
    return present.has('cancelled') ? ['cancelled'] : [];
  }

  const airborne = fresh.actualDepartureUtc !== null || AIRBORNE_STATUSES.has(fresh.status);
  if (airborne) {
    present.delete('gate_change');
    present.delete('delay');
  }
  if (present.has('landed')) present.delete('departed');
  if (present.has('diverted')) present.delete('landed');

  return FLIGHT_EVENT_TYPES.filter((type) => present.has(type));
}
