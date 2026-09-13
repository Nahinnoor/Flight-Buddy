/**
 * The device's own clock and zone.
 *
 * Relative dates ("tomorrow") resolve against the device, never a server
 * (§8.4). `@flightbuddy/shared`'s `parseFlightQuery` takes both as arguments
 * precisely so that this choice is made once, here, and is visible.
 */
import { localDateAtAirport } from '@flightbuddy/shared';

/** The device's IANA zone, or UTC if ICU declines to say. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Today's calendar date on this device, `YYYY-MM-DD`. */
export function todayLocal(now: Date = new Date()): string {
  return localDateAtAirport(now, deviceTimeZone());
}

/** `YYYY-MM-DD` for a `Date` picked in the device's zone (the date picker). */
export function toLocalDateString(date: Date): string {
  return localDateAtAirport(date, deviceTimeZone());
}

/** A `Date` at local noon on `dateLocal` — a safe seed for the date picker. */
export function fromLocalDateString(dateLocal: string): Date {
  const [year, month, day] = dateLocal.split('-').map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) return new Date();
  // Noon, so a zone offset either side of UTC cannot roll the date over.
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}
