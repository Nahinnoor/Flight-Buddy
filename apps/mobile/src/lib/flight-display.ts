/**
 * Turning a `flights` row into the words on a card.
 *
 * No formatting of times happens here — that is `formatAirportLocal` in
 * `@flightbuddy/shared`, which is the only thing allowed to decide what a
 * timestamp reads as (§8.4). This file handles labels, tones and the derived
 * judgements: is this late enough to shout about, is this data old enough to
 * distrust.
 */
import type { FlightStatus, TrackingTier } from '@flightbuddy/shared';

/** Past this many minutes a delay is a notifying event (§9), so the UI shouts. */
export const DELAY_HIGHLIGHT_MINUTES = 30;

/** A flight polled less recently than this, inside the window below, is stale. */
const STALENESS_AGE_HOURS = 6;

/** Staleness only matters close in; a flight three weeks out is meant to be quiet. */
const STALENESS_WINDOW_HOURS = 24;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type StatusTone = 'neutral' | 'positive' | 'warning' | 'critical';

const STATUS_LABELS: Record<FlightStatus, string> = {
  scheduled: 'Scheduled',
  delayed: 'Delayed',
  boarding: 'Boarding',
  departed: 'Departed',
  en_route: 'En route',
  diverted: 'Diverted',
  landed: 'Landed',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
};

const STATUS_TONES: Record<FlightStatus, StatusTone> = {
  scheduled: 'neutral',
  delayed: 'warning',
  boarding: 'positive',
  departed: 'positive',
  en_route: 'positive',
  diverted: 'critical',
  landed: 'neutral',
  cancelled: 'critical',
  unknown: 'neutral',
};

export function statusLabel(status: FlightStatus): string {
  return STATUS_LABELS[status];
}

export function statusTone(status: FlightStatus): StatusTone {
  return STATUS_TONES[status];
}

/**
 * Display names for the carriers most likely to show up as an *operating*
 * carrier on a codeshare. Presentation only — nothing keys on it, and an
 * unknown code falls through to the code itself, which is never wrong, only
 * terse.
 *
 * The right home for this is a carriers table fed by the provider; until that
 * exists, "Operated by AF as AF 3612" is still correct, just less friendly.
 */
const CARRIER_NAMES: Record<string, string> = {
  AA: 'American Airlines',
  AC: 'Air Canada',
  AF: 'Air France',
  AS: 'Alaska Airlines',
  AY: 'Finnair',
  AZ: 'ITA Airways',
  BA: 'British Airways',
  CX: 'Cathay Pacific',
  DL: 'Delta Air Lines',
  EI: 'Aer Lingus',
  EK: 'Emirates',
  IB: 'Iberia',
  JL: 'Japan Airlines',
  KE: 'Korean Air',
  KL: 'KLM',
  LH: 'Lufthansa',
  LX: 'SWISS',
  NH: 'ANA',
  NZ: 'Air New Zealand',
  OS: 'Austrian Airlines',
  QF: 'Qantas',
  QR: 'Qatar Airways',
  SK: 'SAS',
  SQ: 'Singapore Airlines',
  TK: 'Turkish Airlines',
  TP: 'TAP Air Portugal',
  UA: 'United Airlines',
  VS: 'Virgin Atlantic',
  WN: 'Southwest Airlines',
};

export function carrierName(iata: string): string {
  return CARRIER_NAMES[iata.toUpperCase()] ?? iata.toUpperCase();
}

/** `DL 8517`. */
export function designator(carrierIata: string, flightNumber: string): string {
  return `${carrierIata.toUpperCase()} ${flightNumber}`;
}

/**
 * The two numbers a card shows, per §7.2: the user's own number first, the
 * operating one only when it differs. Never swap them — a user who sees a
 * number they did not type assumes the wrong flight was looked up.
 */
export function flightNumbers(input: {
  marketingCarrierIata: string | null;
  marketingFlightNumber: string | null;
  operatingCarrierIata: string;
  operatingFlightNumber: string;
}): { primary: string; operatedBy: string | null } {
  const operating = designator(input.operatingCarrierIata, input.operatingFlightNumber);

  const hasMarketing =
    input.marketingCarrierIata !== null && input.marketingFlightNumber !== null;
  const marketing = hasMarketing
    ? designator(input.marketingCarrierIata as string, input.marketingFlightNumber as string)
    : operating;

  if (marketing === operating) return { primary: marketing, operatedBy: null };

  return {
    primary: marketing,
    operatedBy: `Operated by ${carrierName(input.operatingCarrierIata)} as ${operating}`,
  };
}

/** `5h 45m`, `45m`. `null` in, `null` out — an unknown duration is not `0m`. */
export function formatDuration(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/** `25 min late`, `10 min early`, `On time`. `null` means genuinely unknown. */
export function formatDelay(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes === 0) return 'On time';
  if (minutes > 0) return `${minutes} min late`;
  return `${Math.abs(minutes)} min early`;
}

/**
 * `2026-03-12` → `Mar 12`, for the disambiguation list (§3.1 step 3).
 *
 * Formatted at noon UTC in the UTC zone: the string is a calendar date at the
 * origin airport, not an instant, and parsing it as midnight anywhere risks the
 * device's own offset rolling it to the previous day.
 */
export function formatLocalDateShort(dateLocal: string): string {
  const date = new Date(`${dateLocal}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateLocal;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    calendar: 'gregory',
    numberingSystem: 'latn',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export interface Countdown {
  label: string;
  /** True once the target instant has passed. */
  isPast: boolean;
  /** Milliseconds until the target; negative once past. */
  remainingMs: number;
}

/**
 * Time to departure, at a granularity that matches how far away it is: days and
 * hours a week out, seconds in the last hour. A ticking seconds display three
 * days before a flight is noise, and a screen that only says "in 1h" when
 * boarding closes in four minutes is worse than useless.
 */
export function countdownTo(targetUtc: string | null, now: Date = new Date()): Countdown | null {
  if (targetUtc === null) return null;

  const target = new Date(targetUtc).getTime();
  if (Number.isNaN(target)) return null;

  const remainingMs = target - now.getTime();
  const absolute = Math.abs(remainingMs);
  const isPast = remainingMs < 0;

  let magnitude: string;
  if (absolute >= DAY_MS) {
    const days = Math.floor(absolute / DAY_MS);
    const hours = Math.floor((absolute % DAY_MS) / HOUR_MS);
    magnitude = hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  } else if (absolute >= HOUR_MS) {
    const hours = Math.floor(absolute / HOUR_MS);
    const minutes = Math.floor((absolute % HOUR_MS) / MINUTE_MS);
    magnitude = minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  } else if (absolute >= MINUTE_MS) {
    const minutes = Math.floor(absolute / MINUTE_MS);
    const seconds = Math.floor((absolute % MINUTE_MS) / 1000);
    magnitude = `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  } else {
    magnitude = `${Math.floor(absolute / 1000)}s`;
  }

  return {
    label: isPast ? `${magnitude} ago` : `in ${magnitude}`,
    isPast,
    remainingMs,
  };
}

/** How often a countdown of this size needs redrawing, in milliseconds. */
export function countdownTickMs(remainingMs: number | null): number {
  if (remainingMs === null) return 60_000;
  return Math.abs(remainingMs) < HOUR_MS ? 1_000 : 30_000;
}

/** `Not live-tracked` applies to anything the provider cannot follow (§7.3). */
export function isLiveTracked(tier: TrackingTier): boolean {
  return tier === 'live';
}

/**
 * §8.8: a flight whose data has quietly stopped refreshing must say so rather
 * than present hours-old gate and status information as current. Only inside
 * the 24-hour window, where the poller should be running often enough that six
 * hours of silence means something is wrong.
 */
export function stalenessHint(
  updatedAt: string | null,
  departureUtc: string | null,
  now: Date = new Date(),
): string | null {
  if (updatedAt === null || departureUtc === null) return null;

  const departure = new Date(departureUtc).getTime();
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(departure) || Number.isNaN(updated)) return null;

  const untilDeparture = departure - now.getTime();
  if (untilDeparture > STALENESS_WINDOW_HOURS * HOUR_MS) return null;

  const ageHours = (now.getTime() - updated) / HOUR_MS;
  if (ageHours < STALENESS_AGE_HOURS) return null;

  return `Last updated ${formatDuration(Math.round(ageHours * 60)) ?? ''} ago`;
}
