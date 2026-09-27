/**
 * What the Profile tab says about you, as pure functions: the passport totals,
 * the frequent-flyer level, the "flying with friends" insights and the words
 * on each flight-log row. No React, no Supabase, no clock and no zone of its
 * own — `now` and the device's `timeZone` are always parameters — so every
 * rule below is pinned down by `profile-stats.test.ts`.
 *
 * ## Definitions
 *
 * - **Flight taken**: one of your own segments whose flight is not
 *   `cancelled`, and either has status `landed` or an arrival (actual, else
 *   estimated, else scheduled) before `now`. A diversion counts. A flight on
 *   two of your own trips counts once (deduplicated by flight id).
 * - **Flights / airports / countries / miles** are lifetime totals over
 *   flights taken. Airports: distinct origin and destination IATA codes.
 *   Countries: distinct non-null country codes. Miles: the sum of
 *   `distance_km` × 0.621371, rounded once at the end. A flight with no
 *   distance or country (older rows, `manual` tier) still counts as a flight
 *   and its airports; it just adds no miles or countries.
 * - **Home base**: the most frequent origin among flights taken; a tie goes to
 *   the one flown from most recently; no flights, no home base.
 * - **Levels**: by lifetime miles — 1 Boarding 0, 2 Taxi 1,000, 3 Takeoff
 *   5,000, 4 Climb 15,000, 5 Cruising Altitude 30,000, 6 Jet Stream 50,000,
 *   7 Stratosphere 75,000, 8 Orbit 100,000.
 *
 * Flying with friends is **this year** only, and **actual landings** only:
 *
 * - **This year**: the arrival leg's `departure_date_local` (a calendar date
 *   at the origin airport) falls in the current year *on this device*. Never a
 *   UTC-derived date (§8.4): a 23:30 departure on 31 December is last year's
 *   flight even though it is already 1 January in UTC.
 * - **Arrival leg** of a member's trip: the first segment, by sequence number,
 *   whose destination is the group's `destination_iata`; with no destination
 *   set, or no segment going there, the trip's last segment. Its landing time
 *   is `actual_arrival_utc` only — no actual arrival, not landed.
 * - **Group trip**: a group where you and at least one other member both have
 *   a landed arrival leg this year. **Buddies**: the distinct other travellers
 *   who landed on those trips, unclaimed travellers included.
 * - **Most in sync**: the buddy with the most group trips on which you both
 *   landed at the same airport within 20 minutes of each other; a tie goes to
 *   the smaller total gap, then the name. Nobody → hidden.
 * - **Welcome committee**: group trips on which your landing was strictly the
 *   earliest among the members who landed. Zero → hidden.
 * - **Longest wait**: the largest gap between your landing and a buddy landing
 *   *later at the same airport*, counting only gaps of 5 minutes to 12 hours.
 *   None → hidden.
 *
 * Display names are other people's typing. They are only trimmed and split
 * here, and always rendered as plain text.
 *
 * Relative imports only: vitest runs this file without the app's `@/` alias.
 */
import { localDateAtAirport, type FlightStatus } from '@flightbuddy/shared';

import { flightNumbers, formatDuration, formatLocalDateShort } from './flight-display';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const KM_TO_MILES = 0.621371;
/** Landing this close together (either order) is "in sync". */
export const SYNC_WINDOW_MS = 20 * MINUTE_MS;
/** A shorter wait is noise; a longer one is a different day, not a wait. */
export const WAIT_MIN_MS = 5 * MINUTE_MS;
export const WAIT_MAX_MS = 12 * HOUR_MS;
/** Flight-log pill: this early or more reads as "early". */
const EARLY_MS = 5 * MINUTE_MS;
/** Flight-log pill: up to this late still reads as "On time". */
const ON_TIME_MS = 15 * MINUTE_MS;
/** The machine-readable lines are this many characters, like a real passport. */
export const MRZ_LENGTH = 44;

// ---------------------------------------------------------------- input ---

/** The columns of a `flights` row these stats read. A full row satisfies it. */
export interface StatsFlight {
  id: string;
  status: FlightStatus;
  operating_carrier_iata: string;
  operating_flight_number: string;
  departure_date_local: string;
  origin_iata: string;
  destination_iata: string;
  origin_tz: string;
  scheduled_departure_utc: string | null;
  estimated_departure_utc: string | null;
  actual_departure_utc: string | null;
  scheduled_arrival_utc: string | null;
  estimated_arrival_utc: string | null;
  actual_arrival_utc: string | null;
  distance_km: number | null;
  origin_country_code: string | null;
  destination_country_code: string | null;
}

/** One of your own legs. A `SegmentView` satisfies it. */
export interface OwnSegment {
  segmentId: string;
  sequenceNumber: number;
  marketingCarrierIata: string | null;
  marketingFlightNumber: string | null;
  flight: StatsFlight;
}

// ---------------------------------------------------------- own flights ---

function instant(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function isFlightTaken(flight: StatsFlight, now: Date): boolean {
  if (flight.status === 'cancelled') return false;
  if (flight.status === 'landed') return true;
  const arrival = instant(
    flight.actual_arrival_utc ?? flight.estimated_arrival_utc ?? flight.scheduled_arrival_utc,
  );
  return arrival !== null && arrival < now.getTime();
}

/**
 * When a flight happened, for "most recent first": its departure (actual,
 * estimated, scheduled), else its arrival, else noon on its local date.
 */
function whenFlown(flight: StatsFlight): number {
  const departure = instant(
    flight.actual_departure_utc ?? flight.estimated_departure_utc ?? flight.scheduled_departure_utc,
  );
  if (departure !== null) return departure;
  const arrival = instant(
    flight.actual_arrival_utc ?? flight.estimated_arrival_utc ?? flight.scheduled_arrival_utc,
  );
  if (arrival !== null) return arrival;
  return instant(`${flight.departure_date_local}T12:00:00.000Z`) ?? 0;
}

/** Every flight taken, once each, most recent first. */
export function flightsTaken<T extends OwnSegment>(segments: readonly T[], now: Date): T[] {
  const seen = new Set<string>();
  const taken: T[] = [];
  for (const segment of segments) {
    if (seen.has(segment.flight.id) || !isFlightTaken(segment.flight, now)) continue;
    seen.add(segment.flight.id);
    taken.push(segment);
  }
  return taken.sort((a, b) => {
    const byTime = whenFlown(b.flight) - whenFlown(a.flight);
    return byTime !== 0 ? byTime : b.sequenceNumber - a.sequenceNumber;
  });
}

/** Most frequent origin; a tie goes to the one flown from most recently. */
export function homeBase(taken: readonly OwnSegment[]): string | null {
  const byOrigin = new Map<string, { count: number; latest: number }>();
  for (const { flight } of taken) {
    const entry = byOrigin.get(flight.origin_iata) ?? { count: 0, latest: -Infinity };
    entry.count += 1;
    entry.latest = Math.max(entry.latest, whenFlown(flight));
    byOrigin.set(flight.origin_iata, entry);
  }
  let best: { iata: string; count: number; latest: number } | null = null;
  for (const [iata, entry] of byOrigin) {
    if (
      best === null ||
      entry.count > best.count ||
      (entry.count === best.count && entry.latest > best.latest)
    ) {
      best = { iata, ...entry };
    }
  }
  return best?.iata ?? null;
}

// --------------------------------------------------------------- levels ---

export interface Level {
  index: number;
  name: string;
  minMiles: number;
}

export const LEVELS: readonly Level[] = [
  { index: 1, name: 'Boarding', minMiles: 0 },
  { index: 2, name: 'Taxi', minMiles: 1_000 },
  { index: 3, name: 'Takeoff', minMiles: 5_000 },
  { index: 4, name: 'Climb', minMiles: 15_000 },
  { index: 5, name: 'Cruising Altitude', minMiles: 30_000 },
  { index: 6, name: 'Jet Stream', minMiles: 50_000 },
  { index: 7, name: 'Stratosphere', minMiles: 75_000 },
  { index: 8, name: 'Orbit', minMiles: 100_000 },
];

export interface LevelProgress {
  index: number;
  name: string;
  /** `null` at the top level. */
  nextName: string | null;
  milesToNext: number | null;
  /** 0–1 of the way from this level to the next; 1 at the top. */
  progress: number;
}

export function levelFor(miles: number): LevelProgress {
  const safe = Number.isFinite(miles) && miles > 0 ? miles : 0;
  let current = LEVELS[0] as Level;
  for (const level of LEVELS) if (safe >= level.minMiles) current = level;
  const next = LEVELS[current.index] ?? null;
  if (next === null) {
    return { index: current.index, name: current.name, nextName: null, milesToNext: null, progress: 1 };
  }
  return {
    index: current.index,
    name: current.name,
    nextName: next.name,
    milesToNext: next.minMiles - safe,
    progress: (safe - current.minMiles) / (next.minMiles - current.minMiles),
  };
}

// ----------------------------------------------------------- the totals ---

export interface ProfileStats<T extends OwnSegment = OwnSegment> {
  /** Every flight taken, once each, most recent first. */
  taken: T[];
  flights: number;
  airports: number;
  countries: number;
  miles: number;
  homeBase: string | null;
  level: LevelProgress;
}

export function buildProfileStats<T extends OwnSegment>(
  segments: readonly T[],
  now: Date,
): ProfileStats<T> {
  const taken = flightsTaken(segments, now);
  const airports = new Set<string>();
  const countries = new Set<string>();
  let km = 0;
  for (const { flight } of taken) {
    airports.add(flight.origin_iata);
    airports.add(flight.destination_iata);
    for (const code of [flight.origin_country_code, flight.destination_country_code]) {
      const clean = code?.trim().toUpperCase() ?? '';
      if (clean !== '') countries.add(clean);
    }
    if (flight.distance_km !== null && Number.isFinite(flight.distance_km)) km += flight.distance_km;
  }
  const miles = Math.round(km * KM_TO_MILES);
  return {
    taken,
    flights: taken.length,
    airports: airports.size,
    countries: countries.size,
    miles,
    homeBase: homeBase(taken),
    level: levelFor(miles),
  };
}

// ------------------------------------------------------------ formatting ---

const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `7,190`. */
export function formatNumber(value: number): string {
  return GROUPED.format(value);
}

/** `9,876` below ten thousand, then `42.8k`, `100k`, `1.2M`. */
export function formatCompact(value: number): string {
  if (value < 10_000) return formatNumber(value);
  const trim = (text: string) => text.replace(/\.0$/, '');
  const thousands = trim((value / 1_000).toFixed(1));
  if (Number(thousands) < 1_000) return `${thousands}k`;
  return `${trim((value / 1_000_000).toFixed(1))}M`;
}

/** `1h 40m`, `45m`, `2h`. */
export function formatGap(minutes: number): string {
  return formatDuration(Math.max(0, Math.round(minutes))) ?? '0m';
}

/** `Mar 2025`, in the device's zone. */
export function formatMemberSince(iso: string, timeZone: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function words(displayName: string): string[] {
  return displayName.trim().split(/\s+/u).filter((word) => word !== '');
}

/** The first word of a display name. */
export function firstName(displayName: string): string {
  return words(displayName)[0] ?? 'Someone';
}

/**
 * Up to two initials: first and last word. By code point, not UTF-16 unit, so
 * an emoji or an astral-plane letter is not cut in half.
 */
export function initialsOf(displayName: string): string {
  const parts = words(displayName);
  const first = parts[0];
  if (first === undefined) return '?';
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const letter = (word: string) => (Array.from(word)[0] ?? '').toUpperCase();
  return `${letter(first)}${last === undefined ? '' : letter(last)}`;
}

/**
 * A-Z only; everything else (spaces, digits, punctuation, letters outside
 * A-Z) becomes `<`, the MRZ filler. Accents are dropped first, so "José"
 * reads JOSE rather than JOS<.
 */
function mrzText(text: string): string {
  const plain = typeof text.normalize === 'function' ? text.normalize('NFD').replace(/\p{M}/gu, '') : text;
  return plain.toUpperCase().replace(/[^A-Z]/g, '<');
}

function mrzLine(text: string): string {
  return text.slice(0, MRZ_LENGTH).padEnd(MRZ_LENGTH, '<');
}

/**
 * The passport's two machine-readable lines, a joke rather than a document:
 * `P<FBY` + surname `<<` given names (the last word is taken as the surname,
 * as a real MRZ orders them), then the totals.
 */
export function mrzLines(
  displayName: string,
  stats: { flights: number; airports: number; countries: number; miles: number; level: number },
): [string, string] {
  const parts = words(displayName).map(mrzText);
  const surname = parts.length > 1 ? parts[parts.length - 1] : (parts[0] ?? '');
  const given = parts.length > 1 ? parts.slice(0, -1).join('<') : '';
  const name = given === '' ? surname : `${surname}<<${given}`;
  return [
    mrzLine(`P<FBY${name}`),
    mrzLine(
      `${stats.flights}FLT<${stats.airports}APT<${stats.countries}CTY<${stats.miles}MI<LVL${stats.level}`,
    ),
  ];
}

// ------------------------------------------------------------ flight log ---

export type PillTone = 'neutral' | 'positive' | 'warning' | 'critical';

/** How a landed flight turned out, for the flight-log pill. */
export function flightOutcome(flight: StatsFlight): { label: string; tone: PillTone } {
  if (flight.status === 'cancelled') return { label: 'Cancelled', tone: 'critical' };
  if (flight.status === 'diverted') return { label: 'Diverted', tone: 'warning' };
  const actual = instant(flight.actual_arrival_utc);
  const scheduled = instant(flight.scheduled_arrival_utc);
  if (actual === null || scheduled === null) return { label: 'Landed', tone: 'neutral' };
  const late = actual - scheduled;
  if (late <= -EARLY_MS) return { label: `${formatGap(-late / MINUTE_MS)} early`, tone: 'positive' };
  if (late <= ON_TIME_MS) return { label: 'On time', tone: 'positive' };
  return { label: `Delayed ${formatGap(late / MINUTE_MS)}`, tone: 'warning' };
}

/** Actual gate-to-gate when both ends are known, else scheduled. */
export function flightDurationMinutes(flight: StatsFlight): number | null {
  const pairs: [string | null, string | null][] = [
    [flight.actual_departure_utc, flight.actual_arrival_utc],
    [flight.scheduled_departure_utc, flight.scheduled_arrival_utc],
  ];
  for (const [from, to] of pairs) {
    const start = instant(from);
    const end = instant(to);
    if (start !== null && end !== null && end > start) return Math.round((end - start) / MINUTE_MS);
  }
  return null;
}

export interface FlightLogEntry {
  key: string;
  route: string;
  /** `Sep 7 · XY 123 · 5h 20m`. */
  meta: string;
  pill: { label: string; tone: PillTone };
  accessibilityLabel: string;
}

/**
 * One flight-log row. The date is the departure's calendar date at the origin
 * airport (§8.4); the number is the one the user typed, falling back to the
 * operating number (§7.2). No airline name: we do not store one.
 */
export function flightLogEntry(segment: OwnSegment): FlightLogEntry {
  const { flight } = segment;
  const departure =
    flight.actual_departure_utc ?? flight.estimated_departure_utc ?? flight.scheduled_departure_utc;
  let dateLocal = flight.departure_date_local;
  if (departure !== null) {
    try {
      dateLocal = localDateAtAirport(departure, flight.origin_tz);
    } catch {
      // An unreadable zone on the row: the stored origin-local date stands.
    }
  }
  const date = formatLocalDateShort(dateLocal);
  const number = flightNumbers({
    marketingCarrierIata: segment.marketingCarrierIata,
    marketingFlightNumber: segment.marketingFlightNumber,
    operatingCarrierIata: flight.operating_carrier_iata,
    operatingFlightNumber: flight.operating_flight_number,
  }).primary;
  const duration = formatDuration(flightDurationMinutes(flight));
  const route = `${flight.origin_iata} → ${flight.destination_iata}`;
  const meta = [date, number, duration].filter((part) => part !== null).join(' · ');
  const pill = flightOutcome(flight);
  return {
    key: segment.segmentId,
    route,
    meta,
    pill,
    accessibilityLabel: `${flight.origin_iata} to ${flight.destination_iata}, ${meta}. ${pill.label}.`,
  };
}

// ------------------------------------------------------- flying with friends ---

export interface GroupTripLeg {
  sequenceNumber: number;
  destinationIata: string;
  /** Calendar date at the leg's origin (`flights.departure_date_local`). */
  departureDateLocal: string;
  actualArrivalUtc: string | null;
}

export interface GroupMemberTrip {
  travelerId: string;
  /** This traveller is the signed-in user. */
  isSelf: boolean;
  displayName: string;
  /** Every leg of the trip linked to the membership; empty with no trip. */
  legs: GroupTripLeg[];
}

/** One group you are an active member of, with every active member's trip. */
export interface GroupTripInput {
  groupId: string;
  destinationIata: string | null;
  members: GroupMemberTrip[];
}

export interface Landing {
  airport: string;
  atMs: number;
}

/** See "Arrival leg" in the file comment. */
export function arrivalLeg(
  legs: readonly GroupTripLeg[],
  destinationIata: string | null,
): GroupTripLeg | null {
  const ordered = [...legs].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const destination = destinationIata?.trim().toUpperCase() ?? '';
  if (destination !== '') {
    const match = ordered.find((leg) => leg.destinationIata.toUpperCase() === destination);
    if (match !== undefined) return match;
  }
  return ordered[ordered.length - 1] ?? null;
}

/** This member's landing on this group's trip, if it happened this year. */
export function landingThisYear(
  member: GroupMemberTrip,
  destinationIata: string | null,
  year: string,
): Landing | null {
  const leg = arrivalLeg(member.legs, destinationIata);
  if (leg === null || !leg.departureDateLocal.startsWith(`${year}-`)) return null;
  const atMs = instant(leg.actualArrivalUtc);
  if (atMs === null) return null;
  return { airport: leg.destinationIata.toUpperCase(), atMs };
}

export interface Buddy {
  travelerId: string;
  displayName: string;
  firstName: string;
  initials: string;
  /** Group trips this year you both landed on. */
  sharedTrips: number;
}

export interface FriendsStats {
  groupTrips: number;
  /** Most shared trips first, then by name. */
  buddies: Buddy[];
  mostInSync: { firstName: string; times: number } | null;
  welcomeCommittee: { first: number; total: number } | null;
  longestWait: { minutes: number; airport: string; firstName: string } | null;
}

/** The current calendar year on this device, as `YYYY`. */
export function currentYear(now: Date, timeZone: string): string {
  return localDateAtAirport(now, timeZone).slice(0, 4);
}

export function buildFriendsStats(
  groups: readonly GroupTripInput[],
  now: Date,
  timeZone: string,
): FriendsStats {
  const year = currentYear(now, timeZone);
  const buddies = new Map<string, Buddy>();
  const sync = new Map<string, { times: number; totalGapMs: number }>();
  let groupTrips = 0;
  let firstToLand = 0;
  let longest: { gapMs: number; airport: string; firstName: string } | null = null;

  for (const group of groups) {
    const self = group.members.find((member) => member.isSelf);
    if (self === undefined) continue;
    const mine = landingThisYear(self, group.destinationIata, year);
    if (mine === null) continue;

    // One entry per traveller: a person listed twice in a group is one buddy.
    const others = new Map<string, { member: GroupMemberTrip; landing: Landing }>();
    for (const member of group.members) {
      if (member.isSelf || others.has(member.travelerId)) continue;
      const landing = landingThisYear(member, group.destinationIata, year);
      if (landing !== null) others.set(member.travelerId, { member, landing });
    }
    if (others.size === 0) continue;

    groupTrips += 1;
    if ([...others.values()].every(({ landing }) => mine.atMs < landing.atMs)) firstToLand += 1;

    for (const { member, landing } of others.values()) {
      const buddy = buddies.get(member.travelerId) ?? {
        travelerId: member.travelerId,
        displayName: member.displayName,
        firstName: firstName(member.displayName),
        initials: initialsOf(member.displayName),
        sharedTrips: 0,
      };
      buddy.sharedTrips += 1;
      buddies.set(member.travelerId, buddy);

      if (landing.airport !== mine.airport) continue;
      const gapMs = landing.atMs - mine.atMs;

      if (Math.abs(gapMs) <= SYNC_WINDOW_MS) {
        const entry = sync.get(member.travelerId) ?? { times: 0, totalGapMs: 0 };
        entry.times += 1;
        entry.totalGapMs += Math.abs(gapMs);
        sync.set(member.travelerId, entry);
      }
      if (gapMs >= WAIT_MIN_MS && gapMs <= WAIT_MAX_MS && (longest === null || gapMs > longest.gapMs)) {
        longest = { gapMs, airport: landing.airport, firstName: buddy.firstName };
      }
    }
  }

  let inSync: { buddy: Buddy; times: number; totalGapMs: number } | null = null;
  for (const [travelerId, entry] of sync) {
    const buddy = buddies.get(travelerId);
    if (buddy === undefined) continue;
    if (
      inSync === null ||
      entry.times > inSync.times ||
      (entry.times === inSync.times && entry.totalGapMs < inSync.totalGapMs) ||
      (entry.times === inSync.times &&
        entry.totalGapMs === inSync.totalGapMs &&
        buddy.displayName.localeCompare(inSync.buddy.displayName) < 0)
    ) {
      inSync = { buddy, ...entry };
    }
  }

  return {
    groupTrips,
    buddies: [...buddies.values()].sort(
      (a, b) => b.sharedTrips - a.sharedTrips || a.displayName.localeCompare(b.displayName),
    ),
    mostInSync: inSync === null ? null : { firstName: inSync.buddy.firstName, times: inSync.times },
    welcomeCommittee: firstToLand === 0 ? null : { first: firstToLand, total: groupTrips },
    longestWait:
      longest === null
        ? null
        : {
            minutes: Math.round(longest.gapMs / MINUTE_MS),
            airport: longest.airport,
            firstName: longest.firstName,
          },
  };
}

/** `1 buddy`, `9 buddies`; `1 group trip`, `3 group trips`; `1 time`, `3 times`. */
export function plural(count: number, one: string, many: string): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** The three insight lines, already worded. Each is `null` when hidden. */
export function friendsInsights(stats: FriendsStats): {
  mostInSync: { title: string; detail: string } | null;
  welcomeCommittee: { title: string; detail: string } | null;
  longestWait: { title: string; detail: string } | null;
} {
  const { mostInSync, welcomeCommittee, longestWait } = stats;
  return {
    mostInSync:
      mostInSync === null
        ? null
        : {
            title: `Most in sync: ${mostInSync.firstName}`,
            detail: `You landed within 20 minutes of each other ${plural(mostInSync.times, 'time', 'times')}`,
          },
    welcomeCommittee:
      welcomeCommittee === null
        ? null
        : {
            title: 'Welcome committee',
            detail: `First to land on ${formatNumber(welcomeCommittee.first)} of ${plural(
              welcomeCommittee.total,
              'group trip',
              'group trips',
            )}`,
          },
    longestWait:
      longestWait === null
        ? null
        : {
            title: 'Longest wait',
            detail: `${formatGap(longestWait.minutes)} at ${longestWait.airport} until ${longestWait.firstName} landed`,
          },
  };
}
