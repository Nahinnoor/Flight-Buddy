/**
 * Airport-local time helpers.
 *
 * Timezone bugs are the single largest bug source in flight software (§8.4):
 * everything is stored UTC and displayed airport-local with a zone label, and
 * the server's own local time is never used for anything.
 *
 * `Intl` only — no moment, no luxon, no date-fns-tz. Works on Node 22 and on
 * React Native 0.86 / Hermes, which ships full ICU. Every formatter pins
 * `calendar: 'gregory'` and `numberingSystem: 'latn'` so a device locale with a
 * non-Gregorian calendar or non-Latin digits cannot change the output.
 */

export type DateInput = string | number | Date;

const MS_PER_MINUTE = 60_000;

/** Locales tried, in order, when resolving a short zone label. See `zoneAbbreviation`. */
const ZONE_LABEL_LOCALES = ['en-US', 'en-GB'] as const;

/** Matches labels that are really just offsets: "GMT+1", "UTC-05:00". */
const OFFSET_LABEL = /^(?:GMT|UTC)[+-]/;

function toDate(value: DateInput): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid date: ${String(value)}`);
  }
  return date;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const found = parts.find((p) => p.type === type);
  if (found === undefined) {
    throw new Error(`Intl.DateTimeFormat produced no "${type}" part`);
  }
  return found.value;
}

/** True if the runtime's ICU recognises `timeZone` as an IANA zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Short zone label for an instant in a zone: "EDT", "BST", "GMT", "GMT+5:30".
 *
 * `en-US` knows the North American abbreviations but renders European zones as
 * offsets, so a second locale is tried before falling back to the offset form.
 */
export function zoneAbbreviation(utcIso: DateInput, ianaTz: string): string {
  const date = toDate(utcIso);
  let fallback: string | undefined;

  for (const locale of ZONE_LABEL_LOCALES) {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: ianaTz,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hour: 'numeric',
      timeZoneName: 'short',
    }).formatToParts(date);
    const label = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (label !== undefined && !OFFSET_LABEL.test(label)) return label;
    fallback ??= label;
  }

  return fallback ?? 'UTC';
}

/**
 * A UTC instant as wall-clock time at an airport, with its zone label.
 *
 * `formatAirportLocal('2026-07-15T19:45:00Z', 'America/New_York')` → `3:45 PM EDT`
 *
 * The string is assembled from parts rather than returned raw from `format()`,
 * because ICU ≥ 72 separates the day period with U+202F (narrow no-break
 * space). Plain spaces keep the output stable across ICU and platform versions.
 */
export function formatAirportLocal(utcIso: DateInput, ianaTz: string): string {
  const date = toDate(utcIso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTz,
    calendar: 'gregory',
    numberingSystem: 'latn',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);

  const hour = part(parts, 'hour');
  const minute = part(parts, 'minute');
  const dayPeriod = part(parts, 'dayPeriod')
    .toUpperCase()
    .replace(/[\s\u00a0\u202f]/g, '');

  return `${hour}:${minute} ${dayPeriod} ${zoneAbbreviation(date, ianaTz)}`;
}

/**
 * The calendar date at an airport for a UTC instant, as `YYYY-MM-DD`.
 *
 * This is what `flights.departure_date_local` holds and what AeroDataBox keys
 * on (§6.3): 23:50 out of JFK is one date locally and the next date in UTC.
 */
export function localDateAtAirport(utcIso: DateInput, ianaTz: string): string {
  const date = toDate(utcIso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTz,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = part(parts, 'year').padStart(4, '0');
  const month = part(parts, 'month').padStart(2, '0');
  const day = part(parts, 'day').padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Whole minutes from `a` to `b`, rounded to the nearest minute. Negative if `b`
 * precedes `a`. Both instants are absolute, so DST transitions between them are
 * irrelevant — that is the point of storing UTC.
 */
export function durationMinutes(a: DateInput, b: DateInput): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / MS_PER_MINUTE);
}

/**
 * How late a flight is running, in whole minutes. Positive = late, negative =
 * early, `null` when either side is unknown (provider fields are nullable).
 *
 * A delay over 30 minutes is a notifying event (§9), so callers compare against
 * a threshold rather than truthiness — a 0 and a `null` mean different things.
 */
export function delayMinutes(
  scheduled: DateInput | null | undefined,
  estimated: DateInput | null | undefined,
): number | null {
  if (scheduled === null || scheduled === undefined) return null;
  if (estimated === null || estimated === undefined) return null;
  return durationMinutes(scheduled, estimated);
}
