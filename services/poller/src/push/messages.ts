/**
 * Lock-screen copy for a flight event (§9; overview §8.4 and rule 8 for times).
 *
 * ## Only our own typed fields
 *
 * Every word comes from a column we own and a fixed template: the number the user
 * added (`trip_segments.marketing_*`, falling back to the operating number), the
 * route's IATA codes, a gate or terminal, and instants from `flights` or the
 * event's own `new_value`, which the change detector wrote from typed fields.
 * Provider free text (`notificationSummary`, `notificationRemark`) never reaches
 * this module — it is dropped in `parseAlertDelivery` before anything is stored.
 *
 * Each value is still checked against a strict shape before it is used. A gate
 * is provider data even if it arrived in a typed column, and a lock screen is the
 * one place where a crafted string would be read by a person as if we wrote it.
 * Anything that fails its shape is left out of the sentence, never printed.
 *
 * ## Times
 *
 * Airport-local with a zone label, through `formatAirportLocal` from
 * `packages/shared/src/time.ts` (rule 8). Departure times use the origin's zone,
 * arrival times the destination's. A time on a different local date from the
 * flight's departure date gets the date in front ("Sep 13, 12:15 AM EDT"), so a
 * delay past midnight cannot be misread as an earlier time. (The helper has a
 * known "GMT for European summer time" label bug on Hermes, queued separately; the
 * worker runs on Node's full ICU, and this module adds no zone logic of its own.)
 *
 * ## Payload
 *
 * `data` carries `{ flightId, eventType }` and nothing else: ids the app needs to
 * open the right flight, no personal data (PHASE2_PLAN §5).
 */
import {
  formatAirportLocal,
  isValidTimeZone,
  localDateAtAirport,
  type FlightStatus,
} from '@flightbuddy/shared';

import type { FlightEventType } from '../engine/changeDetector';

/** The facts one message is built from, as the send job reads them. */
export interface MessageFacts {
  eventType: FlightEventType;
  flightId: string;
  previousValue: unknown;
  newValue: unknown;
  /** What the user added; null when the segment carries none. */
  marketingCarrierIata: string | null;
  marketingFlightNumber: string | null;
  operatingCarrierIata: string;
  operatingFlightNumber: string;
  originIata: string;
  destinationIata: string;
  originTz: string;
  destinationTz: string;
  /** `YYYY-MM-DD`, origin-local (§6.3). */
  departureDateLocal: string;
  status: FlightStatus;
  scheduledDepartureUtc: string | null;
  estimatedDepartureUtc: string | null;
  scheduledArrivalUtc: string | null;
  estimatedArrivalUtc: string | null;
}

export interface PushCopy {
  title: string;
  body: string;
  data: { flightId: string; eventType: FlightEventType };
}

const CARRIER = /^[A-Z0-9]{2}$/;
const FLIGHT_NUMBER = /^[0-9]{1,4}[A-Z]?$/;
const IATA = /^[A-Z]{3}$/;
/** Gates like `B12`, `12A`, `C-5`, `A1`. Short and plain on purpose. */
const GATE = /^[A-Za-z0-9-]{1,6}$/;
const TERMINAL = /^[A-Za-z0-9-]{1,4}$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clean(value: unknown, shape: RegExp): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return shape.test(trimmed) ? trimmed : null;
}

function field(record: unknown, key: string): unknown {
  return typeof record === 'object' && record !== null
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

/** "DL 1915": the user's number if the segment has one, else the operating one. */
export function displayFlightNumber(facts: MessageFacts): string | null {
  const marketingCarrier = clean(facts.marketingCarrierIata, CARRIER);
  const marketingNumber = clean(facts.marketingFlightNumber, FLIGHT_NUMBER);
  if (marketingCarrier !== null && marketingNumber !== null) {
    return `${marketingCarrier} ${marketingNumber}`;
  }
  const carrier = clean(facts.operatingCarrierIata, CARRIER);
  const number = clean(facts.operatingFlightNumber, FLIGHT_NUMBER);
  return carrier !== null && number !== null ? `${carrier} ${number}` : null;
}

function route(facts: MessageFacts): string | null {
  const origin = clean(facts.originIata, IATA);
  const destination = clean(facts.destinationIata, IATA);
  return origin !== null && destination !== null ? `${origin} → ${destination}` : null;
}

function validInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** "Sep 13" from `2026-09-13`, with no time-zone arithmetic at all. */
function shortDate(localDate: string): string | null {
  const match = LOCAL_DATE.exec(localDate);
  if (match === null) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month === undefined ? null : `${month} ${Number(match[3])}`;
}

/**
 * An instant at an airport: "3:45 PM EDT", or "Sep 13, 12:15 AM EDT" when that
 * is not the flight's departure date there. `null` when anything is unusable.
 */
export function airportTime(
  utc: unknown,
  timeZone: string,
  departureDateLocal: string,
): string | null {
  const instant = validInstant(utc);
  if (instant === null || !isValidTimeZone(timeZone)) return null;
  const time = formatAirportLocal(instant, timeZone);
  const localDate = localDateAtAirport(instant, timeZone);
  if (localDate === departureDateLocal) return time;
  const date = shortDate(localDate);
  return date === null ? time : `${date}, ${time}`;
}

/** "45 min", "1 h 20 min", "2 h". */
export function formatDuration(minutes: number): string {
  const whole = Math.max(Math.round(minutes), 0);
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function joinParts(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
}

function positiveMinutes(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Build the title and body for one event and one recipient.
 *
 * Never throws: a field that fails its shape is dropped from the sentence. The
 * one thing that cannot be dropped is a flight number, and without one there is
 * still "Your flight".
 */
export function buildPushCopy(facts: MessageFacts): PushCopy {
  const flight = displayFlightNumber(facts) ?? 'Your flight';
  const path = route(facts);
  const origin = clean(facts.originIata, IATA);
  const destination = clean(facts.destinationIata, IATA);
  const date = facts.departureDateLocal;
  const departureTime = (utc: unknown) => airportTime(utc, facts.originTz, date);
  const arrivalTime = (utc: unknown) => airportTime(utc, facts.destinationTz, date);
  const believedDeparture = facts.estimatedDepartureUtc ?? facts.scheduledDepartureUtc;

  let title: string;
  let body: string;

  switch (facts.eventType) {
    case 'cancelled': {
      const scheduled = departureTime(facts.scheduledDepartureUtc);
      title = `${flight} cancelled`;
      body = joinParts([path, scheduled === null ? null : `was due to depart ${scheduled}`]);
      break;
    }

    case 'delay': {
      const late =
        positiveMinutes(field(facts.newValue, 'delayMinutes')) ??
        positiveMinutes(field(facts.newValue, 'movedByMinutes'));
      const now = departureTime(field(facts.newValue, 'departureUtc'));
      title = late === null ? `${flight} delayed` : `${flight} delayed ${formatDuration(late)}`;
      body = joinParts([path, now === null ? null : `now departs ${now}`]);
      break;
    }

    case 'gate_change': {
      const gate = clean(field(facts.newValue, 'gate'), GATE);
      const previous = clean(field(facts.previousValue, 'gate'), GATE);
      const terminal = clean(field(facts.newValue, 'terminal'), TERMINAL);
      const departs = departureTime(believedDeparture);
      if (gate === null) {
        title = `${flight} gate change`;
        body = joinParts([path, 'open FlightBuddy for the new gate']);
      } else {
        title =
          previous === null
            ? `${flight} departs from gate ${gate}`
            : `${flight} gate change: ${gate}`;
        body = joinParts([
          path,
          terminal === null ? null : `Terminal ${terminal}`,
          previous === null ? null : `was ${previous}`,
          departs === null ? null : `departs ${departs}`,
        ]);
      }
      break;
    }

    case 'departed': {
      const tookOff = departureTime(field(facts.newValue, 'actualDepartureUtc'));
      const due = arrivalTime(facts.estimatedArrivalUtc ?? facts.scheduledArrivalUtc);
      title = origin === null ? `${flight} departed` : `${flight} departed ${origin}`;
      body = joinParts([
        path,
        tookOff === null ? null : `took off ${tookOff}`,
        due === null ? null : `due ${due}`,
      ]);
      break;
    }

    case 'landed': {
      if (facts.status === 'diverted') {
        // The stored destination and its zone may not be where it came down.
        title = `${flight} landed after a diversion`;
        body = 'Open FlightBuddy for the airport';
      } else {
        const landedAt = arrivalTime(field(facts.newValue, 'actualArrivalUtc'));
        title = destination === null ? `${flight} landed` : `${flight} landed at ${destination}`;
        body = joinParts([path, landedAt === null ? null : `landed ${landedAt}`]);
      }
      break;
    }

    case 'diverted': {
      const newDestination = clean(field(facts.newValue, 'destinationIata'), IATA);
      title = `${flight} diverted`;
      // Not `route()`: the stored destination may already be the new one.
      body =
        newDestination !== null
          ? `Now heading to ${newDestination}`
          : 'Open FlightBuddy for details';
      break;
    }
  }

  // A route is always worth saying; never leave a body empty.
  if (body === '') body = path ?? 'Open FlightBuddy for details';

  return {
    title,
    body,
    data: { flightId: facts.flightId, eventType: facts.eventType },
  };
}
