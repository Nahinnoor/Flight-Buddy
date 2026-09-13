/**
 * Fixtures for `EXPO_PUBLIC_MOCK_API=1`.
 *
 * The add-flight flow has three distinct shapes and every one of them has to be
 * exercisable before `apps/api` exists, because two of them are exactly the
 * cases that get skipped:
 *
 * - `DL1234` — one candidate. The happy path.
 * - `DL8517` — one candidate, a codeshare: Delta sells it, Air France flies it
 *   as AF 3612 (§7.2). Proves the card shows the user's number first and
 *   "Operated by …" second, and that the delay pill lights up over 30 minutes.
 * - `WN1234` — **two** candidates: one flight number, two legs on one date
 *   (§8.12). This is the case where taking `[0]` silently puts someone on the
 *   wrong aeroplane, so the disambiguation list must be reachable in dev.
 *
 * Anything else resolves to zero candidates, which is the "No flight found"
 * branch.
 *
 * Times are expressed as minutes past 00:00 UTC on the requested local date, so
 * the fixtures follow whatever date the user types and the countdown on the
 * dashboard stays meaningful. The offsets are chosen so North American summer
 * dates render the wall-clock times in the comments.
 */
import type { FlightCandidate } from '@flightbuddy/shared';

/** `2026-07-15`, 1185 → `2026-07-15T19:45:00.000Z` (3:45 PM EDT at JFK). */
function at(dateLocal: string, minutesPastUtcMidnight: number): string {
  const base = new Date(`${dateLocal}T00:00:00.000Z`);
  return new Date(base.getTime() + minutesPastUtcMidnight * 60_000).toISOString();
}

const HOUR = 60;
const DAY = 24 * HOUR;

/** A plain domestic direct flight, on time, live-tracked. */
function directFlight(dateLocal: string): FlightCandidate {
  const scheduledDeparture = at(dateLocal, 19 * HOUR + 45); // 3:45 PM EDT
  const scheduledArrival = at(dateLocal, 23 * HOUR + 12); // 4:12 PM PDT

  return {
    marketingCarrierIata: 'DL',
    marketingFlightNumber: '1234',
    operatingCarrierIata: 'DL',
    operatingFlightNumber: '1234',
    departureDateLocal: dateLocal,

    originIata: 'JFK',
    destinationIata: 'LAX',
    originIcao: 'KJFK',
    destinationIcao: 'KLAX',
    originTz: 'America/New_York',
    destinationTz: 'America/Los_Angeles',
    originName: 'New York John F. Kennedy',
    destinationName: 'Los Angeles International',

    scheduledDepartureUtc: scheduledDeparture,
    estimatedDepartureUtc: scheduledDeparture,
    actualDepartureUtc: null,
    scheduledArrivalUtc: scheduledArrival,
    estimatedArrivalUtc: scheduledArrival,
    actualArrivalUtc: null,

    status: 'scheduled',
    trackingTier: 'live',

    gate: 'B22',
    terminal: '4',

    aircraftReg: 'N825DN',
    aircraftModel: 'Airbus A321neo',
  };
}

/**
 * The §7.2 example: the user bought DL 8517, Air France operates it as AF 3612.
 * Running 45 minutes late, which is past the 30-minute notify threshold (§9).
 */
function codeshareFlight(dateLocal: string): FlightCandidate {
  const scheduledDeparture = at(dateLocal, 21 * HOUR + 55); // 5:55 PM EDT
  const scheduledArrival = at(dateLocal, DAY + 9 * HOUR + 40); // 11:40 AM CEST, next day

  return {
    marketingCarrierIata: 'DL',
    marketingFlightNumber: '8517',
    operatingCarrierIata: 'AF',
    operatingFlightNumber: '3612',
    departureDateLocal: dateLocal,

    originIata: 'ATL',
    destinationIata: 'CDG',
    originIcao: 'KATL',
    destinationIcao: 'LFPG',
    originTz: 'America/New_York',
    destinationTz: 'Europe/Paris',
    originName: 'Atlanta Hartsfield-Jackson',
    destinationName: 'Paris Charles de Gaulle',

    scheduledDepartureUtc: scheduledDeparture,
    estimatedDepartureUtc: at(dateLocal, 22 * HOUR + 40),
    actualDepartureUtc: null,
    scheduledArrivalUtc: scheduledArrival,
    estimatedArrivalUtc: at(dateLocal, DAY + 10 * HOUR + 20),
    actualArrivalUtc: null,

    status: 'delayed',
    trackingTier: 'live',

    gate: 'E12',
    terminal: 'I',

    aircraftReg: 'F-HRBA',
    aircraftModel: 'Airbus A350-900',
  };
}

/**
 * One flight number, two legs on the same date. The second leg is
 * `scheduled` tier, so picking it shows the **Not live-tracked** badge (§7.3).
 */
function multiLegFlights(dateLocal: string): FlightCandidate[] {
  const firstDeparture = at(dateLocal, 16 * HOUR + 30); // 9:30 AM PDT
  const firstArrival = at(dateLocal, 17 * HOUR + 45); // 10:45 AM MST
  const secondDeparture = at(dateLocal, 18 * HOUR + 40); // 11:40 AM MST
  const secondArrival = at(dateLocal, 22 * HOUR + 5); // 5:05 PM CDT

  const shared = {
    marketingCarrierIata: 'WN',
    marketingFlightNumber: '1234',
    operatingCarrierIata: 'WN',
    operatingFlightNumber: '1234',
    departureDateLocal: dateLocal,
    status: 'scheduled',
    actualDepartureUtc: null,
    actualArrivalUtc: null,
    aircraftReg: 'N8642E',
    aircraftModel: 'Boeing 737 MAX 8',
  } as const;

  return [
    {
      ...shared,
      originIata: 'LAS',
      destinationIata: 'PHX',
      originIcao: 'KLAS',
      destinationIcao: 'KPHX',
      originTz: 'America/Los_Angeles',
      destinationTz: 'America/Phoenix',
      originName: 'Las Vegas Harry Reid',
      destinationName: 'Phoenix Sky Harbor',
      scheduledDepartureUtc: firstDeparture,
      estimatedDepartureUtc: firstDeparture,
      scheduledArrivalUtc: firstArrival,
      estimatedArrivalUtc: firstArrival,
      trackingTier: 'live',
      gate: 'C7',
      terminal: '3',
    },
    {
      ...shared,
      originIata: 'PHX',
      destinationIata: 'AUS',
      originIcao: 'KPHX',
      destinationIcao: 'KAUS',
      originTz: 'America/Phoenix',
      destinationTz: 'America/Chicago',
      originName: 'Phoenix Sky Harbor',
      destinationName: 'Austin-Bergstrom',
      scheduledDepartureUtc: secondDeparture,
      estimatedDepartureUtc: secondDeparture,
      scheduledArrivalUtc: secondArrival,
      estimatedArrivalUtc: secondArrival,
      trackingTier: 'scheduled',
      gate: null,
      terminal: '4',
    },
  ];
}

const FIXTURES: Record<string, (dateLocal: string) => FlightCandidate[]> = {
  DL1234: (date) => [directFlight(date)],
  DL8517: (date) => [codeshareFlight(date)],
  WN1234: multiLegFlights,
};

/** Every designator the mock knows, for the hint under the add-flight field. */
export const MOCK_DESIGNATORS = Object.keys(FIXTURES);

/**
 * Answers a lookup from the fixtures. `designator` is the normalised, unspaced
 * form (`DL1234`); an unknown one returns `[]` so the empty state is reachable.
 */
export function mockCandidates(designator: string, dateLocal: string): FlightCandidate[] {
  return FIXTURES[designator.toUpperCase()]?.(dateLocal) ?? [];
}
