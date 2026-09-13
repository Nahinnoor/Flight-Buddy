/**
 * The free-text parser behind the add-flight field (§3.1).
 *
 * The user types `DL1234 tomorrow` or `DL 1234 12 Mar` and gets back the two
 * things a lookup needs: a normalised designator and a local departure date at
 * the origin (§6.3).
 *
 * Two constraints shape this file:
 *
 * - It runs on Hermes as well as Node (ADR 0002), so it is plain TypeScript
 *   with no Node builtins, no date library, and no regex lookbehind.
 * - "Today" is never the server's today (§8.4). The caller passes the instant
 *   and the zone to resolve relative dates against — the device's own.
 */
import { isValidTimeZone, localDateAtAirport } from './time';

/** A flight designator split into its carrier and number halves. */
export interface ParsedFlightDesignator {
  /** Two-character IATA airline code, uppercase, e.g. `"DL"`, `"B6"`, `"9W"`. */
  carrierIata: string;
  /** Bare number with leading zeros stripped, e.g. `"1234"`. */
  flightNumber: string;
  /** The two joined with no space, e.g. `"DL1234"`. */
  designator: string;
}

/** Either a lookup the provider can run, or a message to show the user. */
export type FlightQueryResult = { flightNumber: string; dateLocal: string } | { error: string };

/**
 * Split a flight designator however it was typed: `"dl 1234"`, `"DL1234"`,
 * `"DL-1234"` and `"DL 01234"` all yield `DL` / `1234`.
 *
 * The carrier is always the first two characters, which is unambiguous because
 * every IATA airline designator is exactly two alphanumerics with at least one
 * letter — `B6`, `9W`, `U2`. That is what makes `B61411` splittable at all.
 *
 * Returns `null` when the text is not a designator.
 */
export function parseFlightDesignator(text: string): ParsedFlightDesignator | null {
  const cleaned = text.toUpperCase().replace(/[\s.\-_/]/g, '');
  const match = /^([A-Z0-9]{2})0*([0-9]{1,4}[A-Z]?)$/.exec(cleaned);
  if (match === null) return null;

  const carrierIata = match[1] as string;
  const flightNumber = match[2] as string;
  // "12 345" is a date and a number, not an airline: a designator has a letter.
  if (!/[A-Z]/.test(carrierIata)) return null;

  return { carrierIata, flightNumber, designator: `${carrierIata}${flightNumber}` };
}

const MONTH_NAMES = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
] as const;

const MS_PER_DAY = 86_400_000;

/**
 * A date typed without a year is taken as the next occurrence, but a date that
 * has only just gone by is far more likely to be a flight the user is still
 * tracking than one a year out — so the roll-forward starts a day back.
 */
const PAST_DATE_GRACE_DAYS = 1;

/** 1-12 for a month name or abbreviation, or `null`. `"Sept"` counts. */
function monthFromName(token: string): number | null {
  if (token.length < 3) return null;
  for (let index = 0; index < MONTH_NAMES.length; index += 1) {
    const name = MONTH_NAMES[index] as string;
    if (name.startsWith(token)) return index + 1;
  }
  return null;
}

/** True when `year-month-day` is a date that exists (rejects 30 February). */
function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function toIsoDate(year: number, month: number, day: number): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Epoch ms at midnight UTC of a `YYYY-MM-DD` string. Calendar maths only. */
function isoToUtcMs(isoDate: string): number {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return Date.UTC(year, month - 1, day);
}

function addDays(isoDate: string, days: number): string {
  const shifted = new Date(isoToUtcMs(isoDate) + days * MS_PER_DAY);
  return toIsoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Two-digit years are this century: `27` is 2027, not 1927. */
function expandYear(raw: string): number {
  const year = Number(raw);
  return raw.length <= 2 ? 2000 + year : year;
}

/**
 * Resolve a month and day with no year to the next occurrence: this year if it
 * is still ahead (or within the grace window), otherwise next year.
 */
function resolveYearless(month: number, day: number, today: string): string | null {
  const thisYear = Number(today.slice(0, 4));
  for (const year of [thisYear, thisYear + 1]) {
    if (!isRealDate(year, month, day)) continue; // 29 February in a common year.
    const candidate = toIsoDate(year, month, day);
    if (isoToUtcMs(candidate) >= isoToUtcMs(today) - PAST_DATE_GRACE_DAYS * MS_PER_DAY) {
      return candidate;
    }
  }
  return null;
}

/** Outcome of reading the date half of a query. */
type DateParse = { dateLocal: string } | { error: string } | null;

function parseDatePart(text: string, today: string): DateParse {
  const value = text.trim();

  if (value === 'TODAY') return { dateLocal: today };
  if (value === 'TOMORROW') return { dateLocal: addDays(today, 1) };
  if (value === 'YESTERDAY') return { dateLocal: addDays(today, -1) };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso !== null) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!isRealDate(year, month, day)) {
      return { error: `"${value}" is not a real date.` };
    }
    return { dateLocal: toIsoDate(year, month, day) };
  }

  // Month-first numeric: 3/12, 03-12, 3/12/2027, 3/12/27.
  const numeric = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(value);
  if (numeric !== null) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    const yearText = numeric[3];
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return { error: `"${value}" is not a real date.` };
    }
    if (yearText !== undefined) {
      const year = expandYear(yearText);
      if (!isRealDate(year, month, day)) return { error: `"${value}" is not a real date.` };
      return { dateLocal: toIsoDate(year, month, day) };
    }
    const resolved = resolveYearless(month, day, today);
    return resolved === null
      ? { error: `"${value}" is not a real date.` }
      : { dateLocal: resolved };
  }

  // Month name either side of the day: "Mar 12", "12 Mar", "March 12 2027".
  const monthFirst = /^([A-Z]{3,9})\.?,?\s+(\d{1,2})(?:ST|ND|RD|TH)?(?:,?\s+(\d{2,4}))?$/.exec(
    value,
  );
  const dayFirst = /^(\d{1,2})(?:ST|ND|RD|TH)?\s+([A-Z]{3,9})\.?,?(?:\s+(\d{2,4}))?$/.exec(value);
  const named = monthFirst ?? dayFirst;
  if (named !== null) {
    const monthToken = (monthFirst !== null ? named[1] : named[2]) as string;
    const dayText = (monthFirst !== null ? named[2] : named[1]) as string;
    const yearText = named[3];
    const month = monthFromName(monthToken);
    if (month === null) return null;

    const day = Number(dayText);
    if (yearText !== undefined) {
      const year = expandYear(yearText);
      if (!isRealDate(year, month, day)) return { error: `"${value}" is not a real date.` };
      return { dateLocal: toIsoDate(year, month, day) };
    }
    const resolved = resolveYearless(month, day, today);
    return resolved === null
      ? { error: `"${value}" is not a real date.` }
      : { dateLocal: resolved };
  }

  return null;
}

/**
 * Parse `"DL1234 Mar 12"` into a flight number and a local departure date.
 *
 * Accepted date forms: `today`, `tomorrow`, `yesterday`, `2026-09-12`, `3/12`,
 * `Mar 12`, `12 Mar`, each optionally with a year. A month and day with no year
 * resolve to the next occurrence.
 *
 * @param text What the user typed.
 * @param now The device's current instant — relative dates resolve against it.
 * @param tz IANA zone the user is in. Defaults to UTC; pass the device's zone.
 */
export function parseFlightQuery(text: string, now: Date, tz = 'UTC'): FlightQueryResult {
  if (!isValidTimeZone(tz)) {
    return { error: `"${tz}" is not a time zone this device knows.` };
  }

  const normalised = text.trim().toUpperCase().replace(/\s+/g, ' ');
  if (normalised === '') {
    return { error: 'Enter a flight number and a date, e.g. "DL1234 tomorrow".' };
  }

  // The designator is the leading token(s); everything after it is the date.
  const head = /^([A-Z0-9]{2})\s?0*(\d{1,4}[A-Z]?)(?![0-9A-Z])/.exec(normalised);
  if (head === null || !/[A-Z]/.test(head[1] as string)) {
    return { error: 'Start with a flight number, e.g. "DL1234 tomorrow".' };
  }
  const flightNumber = `${head[1] as string}${head[2] as string}`;
  const rest = normalised.slice(head[0].length).trim();

  if (rest === '') {
    return { error: `Add a date for ${flightNumber}, e.g. "${flightNumber} tomorrow".` };
  }

  const today = localDateAtAirport(now, tz);
  const parsed = parseDatePart(rest, today);
  if (parsed === null) {
    return {
      error: `Could not read "${rest.toLowerCase()}" as a date. Try "tomorrow", "Mar 12" or "2026-03-12".`,
    };
  }
  if ('error' in parsed) return parsed;

  return { flightNumber, dateLocal: parsed.dateLocal };
}
