/**
 * `webhook-ingest`: drain `public.webhook_inbox` into `flights` (§7.6, ADR 0003).
 *
 * The API's receiver validates each AeroDataBox delivery, writes it to
 * `webhook_inbox` and answers 200 at once (§7.6: never process inline). This file
 * is the other half: the worker's only consumer of that table.
 *
 * ```
 * claim the oldest unprocessed row  (for update skip locked, one row per transaction)
 *   → re-validate the envelope        (parseAlertDelivery — defence in depth)
 *   → rows holding that subscription  (none → processed, "unknown subscription")
 *   → match each item to its row      (operating number + origin IATA + origin-local date; never [0])
 *   → lease the flight row            (the same lease the poll claim uses)
 *   → detectChanges(current, webhook, source 'webhook')
 *   → gate_change / cancelled?  verification poll; the POLLED leg is what is
 *     ingested and diffed (ADR 0003 decision 1: if the poll disagrees, trust it)
 *   → ingestFlight (rule 7) → flight_events → next_poll_at from the ladder
 *   → balance → provider_credit_log ('webhook_payload')
 *   → mark the inbox row processed
 * ```
 *
 * ## How it is scheduled
 *
 * `main.ts` runs one drain at the start of every worker pass, before the poll
 * pass, in the same loop. The inbox already *is* a durable queue with retry
 * bookkeeping (`attempts`, `last_error`, `processed_at`), so wrapping it in a
 * pg-boss job would add a second queue with its own retry semantics in front of
 * the first. Running it in the loop keeps every provider call on the one
 * process-wide rate limiter without concurrency between the two paths, and bounds
 * latency at one `POLL_INTERVAL_MS` plus the previous pass.
 *
 * ## Why poll and webhook never double-notify (criterion 8)
 *
 * Both paths diff against the stored last-known value and write the fresh value
 * back, so whichever runs second sees no change. That only holds if they never
 * process one flight *at the same time*, so the drain takes the flight's
 * `poll_lease_until` exactly as the poll claim does, and diffs against the row that
 * lease statement returns. A flight a poll is holding is skipped (the inbox row
 * waits for the next pass); a flight the drain is holding is not claimable by a
 * poll. Two workers overlapping during a deploy are covered the same way.
 *
 * ## Why a row lock here, when §7.5 says lease-not-lock
 *
 * `webhook_inbox` has no lease column, and its migration belongs to the API. So a
 * row is claimed with `for update skip locked` inside a short transaction that
 * commits once the row is marked. The lock is on a worker-private inbox row, never
 * on `flights`; the receiver only inserts new rows, so nothing waits on it; and it
 * is held for at most one verification poll. A worker killed mid-row rolls back and
 * the row is claimed again — and re-processing is harmless, because change
 * detection against the stored value yields nothing the second time.
 *
 * ## Data, not instructions
 *
 * The payload is parsed into typed fields and nothing else. The provider's
 * `notificationSummary` / `notificationRemark` never leave `parseAlertDelivery`;
 * logs carry inbox, subscription and flight ids and our own error class names;
 * `last_error` is a class name; every statement is parameterised.
 */
import {
  ProviderDataError,
  ingestFlight,
  lookupCandidates,
  parseAlertDelivery,
  type AlertDelivery,
  type FeedHealthCache,
  type FlightDataProvider,
  type FlightsWriter,
} from '@flightbuddy/flight-provider';
import type { FlightCandidate } from '@flightbuddy/shared';

import { withClient, type Pool, type PoolClient } from '../db';
import type { Logger } from '../logger';
import { detectChanges, type FlightEventType } from './changeDetector';
import { nextPollAt } from './ladder';
import { DEFAULT_LEASE_MS, releaseLease } from './lease';
import { ladderViewOf, operatingDesignator } from './poll';
import { CREDIT_LOG_SOURCES, insertCreditLog, insertFlightEvents, isLoggableBalance } from './repository';
import { ENGINE_TYPES, type FlightRow } from './types';

/** Give up on a row after this many failed attempts (the brief: 5). */
export const INBOX_MAX_ATTEMPTS = 5;

/** Rows handled per drain. Bounds a pass the way `POLL_BATCH_SIZE` bounds polling. */
export const DEFAULT_INBOX_BATCH_SIZE = 25;

/** ADR 0003 decision 1: these, arriving by webhook, are confirmed by a poll first. */
export const VERIFIED_EVENT_TYPES: ReadonlySet<FlightEventType> = new Set<FlightEventType>([
  'gate_change',
  'cancelled',
]);

// --- SQL --------------------------------------------------------------------
// `flightbuddy_worker` holds `select, update (processed_at, attempts, last_error)`
// on webhook_inbox; FOR UPDATE needs UPDATE on at least one column, which it has.

/**
 * Claim one row, oldest first. `$2` are rows this drain already handled, so a row
 * that failed (or was deferred) is not retried again within the same pass.
 */
export const CLAIM_INBOX_ROW_SQL = `select id, subscription_id, payload, attempts
  from public.webhook_inbox
 where processed_at is null
   and attempts < $1
   and not (id = any($2::uuid[]))
 order by received_at, id
 limit 1
 for update skip locked`;

/** Done. `$2` is null, or a fixed reason code (never payload text). */
export const MARK_INBOX_DONE_SQL = `update public.webhook_inbox
   set processed_at = now(),
       attempts = attempts + 1,
       last_error = $2
 where id = $1`;

/** Failed: count it, record the class name, and give up at `$3` attempts. */
export const MARK_INBOX_FAILED_SQL = `update public.webhook_inbox
   set attempts = attempts + 1,
       last_error = $2,
       processed_at = case when attempts + 1 >= $3 then now() else null end
 where id = $1
returning attempts, processed_at`;

/** Active rows holding a subscription, with the fields that identify each leg. */
export const FIND_SUBSCRIBED_FLIGHTS_SQL = `select id, operating_carrier_iata, operating_flight_number,
       departure_date_local, origin_iata
  from public.flights
 where alert_subscription_id = $1
   and archived_at is null`;

/**
 * Take one flight's lease and read it back — the same lease a poll claim takes
 * (lease.ts), so the two paths never process one flight concurrently.
 */
export const LEASE_FLIGHT_FOR_WEBHOOK_SQL = `update public.flights
   set poll_lease_until = now() + ($2::double precision * interval '1 millisecond')
 where id = $1
   and archived_at is null
   and (poll_lease_until is null or poll_lease_until < now())
returning *`;

/** After a delivery was applied: the ladder's answer, and the lease handed back. */
export const WEBHOOK_APPLIED_SQL = `update public.flights
   set next_poll_at = $2,
       poll_lease_until = null
 where id = $1`;

/**
 * §7.6: the balance every delivery carries is free monitoring. The statement and
 * its int4 guard live in `repository.ts`, shared with the hourly `credit-check`;
 * re-exported here so existing imports keep working.
 */
export { INSERT_CREDIT_LOG_SQL } from './repository';

export const CREDIT_LOG_SOURCE = CREDIT_LOG_SOURCES.WEBHOOK_PAYLOAD;

/** Fixed reason codes written to `last_error` for rows that are done but not applied. */
export const INBOX_REASONS = {
  INVALID_PAYLOAD: 'InvalidPayload',
  UNKNOWN_SUBSCRIPTION: 'UnknownSubscription',
} as const;

// --- types ------------------------------------------------------------------

export interface InboxRow {
  id: string;
  subscription_id: string;
  payload: unknown;
  attempts: number;
}

export interface WebhookIngestDeps {
  pool: Pool;
  provider: FlightDataProvider;
  /** Rule 7: flight data is written through `ingestFlight` and this writer only. */
  writer: FlightsWriter;
  rateLimiter: { acquire(): Promise<void> };
  logger: Logger;
  /** Passed to the ladder for `next_poll_at`. Off: a delivered flight goes back on the ladder. */
  webhooksEnabled?: boolean;
  feedHealthCache?: FeedHealthCache;
  now?: () => Date;
  rng?: () => number;
  leaseMs?: number;
  batchSize?: number;
}

export type InboxOutcomeKind =
  | 'processed'
  | 'unknown_subscription'
  | 'invalid'
  /** A matched flight was leased by a poll; the row waits for the next pass. */
  | 'deferred'
  | 'failed'
  /** Failed for the `INBOX_MAX_ATTEMPTS`th time: marked processed, not retried. */
  | 'abandoned';

export interface InboxOutcome {
  inboxId: string;
  kind: InboxOutcomeKind;
  flightIds: string[];
  events: FlightEventType[];
  eventIds: string[];
  /** Verification polls made for this row. */
  verifications: number;
  errorName?: string;
}

export interface DrainSummary {
  claimed: number;
  processed: number;
  unknownSubscription: number;
  invalid: number;
  deferred: number;
  failed: number;
  abandoned: number;
  events: number;
  outcomes: InboxOutcome[];
}

/** The verification poll answered, but not with this flight's leg. */
export class VerificationLegMissingError extends Error {
  constructor() {
    super('The verification poll returned no leg from this origin.');
    this.name = 'VerificationLegMissingError';
  }
}

/** The envelope names a different subscription from the inbox row's column. */
class SubscriptionMismatchError extends ProviderDataError {
  constructor() {
    super('The delivery names a different subscription from its inbox row.');
    this.name = 'SubscriptionMismatchError';
  }
}

// --- helpers ----------------------------------------------------------------

type SubscribedFlight = Pick<
  FlightRow,
  | 'id'
  | 'operating_carrier_iata'
  | 'operating_flight_number'
  | 'departure_date_local'
  | 'origin_iata'
>;

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Pair each delivered leg with the row it describes.
 *
 * A subscription is per operating number with no date (§7.6), so a delivery can
 * describe any leg and any day that number operates. A leg belongs to a row only
 * if its whole canonical key matches — number, origin-local date and origin —
 * which is also what guarantees `ingestFlight`'s upsert lands on that row and no
 * other. Legs for dates nobody tracks are ignored.
 */
export function matchLegs(
  rows: readonly SubscribedFlight[],
  legs: readonly FlightCandidate[],
): { matched: Map<string, FlightCandidate>; ignored: number } {
  const matched = new Map<string, FlightCandidate>();
  let ignored = 0;

  for (const leg of legs) {
    const row = rows.find(
      (candidate) =>
        candidate.operating_carrier_iata.trim() === leg.operatingCarrierIata &&
        candidate.operating_flight_number.trim() === leg.operatingFlightNumber &&
        candidate.departure_date_local === leg.departureDateLocal &&
        candidate.origin_iata.trim() === leg.originIata,
    );
    if (row === undefined) {
      ignored += 1;
    } else {
      // A repeated item for the same leg: the later one in the delivery wins.
      matched.set(row.id, leg);
    }
  }

  return { matched, ignored };
}

interface AppliedLeg {
  flightId: string;
  events: FlightEventType[];
  eventIds: string[];
  verified: boolean;
}

/**
 * ADR 0003 decision 1: one poll, through the limiter, matched on origin.
 * @throws VerificationLegMissingError, or whatever the provider throws.
 */
async function verificationPoll(current: FlightRow, deps: WebhookIngestDeps): Promise<FlightCandidate> {
  await deps.rateLimiter.acquire();
  const legs = await lookupCandidates(
    deps.provider,
    { flightNumber: operatingDesignator(current), dateLocal: current.departure_date_local },
    deps.feedHealthCache === undefined ? {} : { feedHealthCache: deps.feedHealthCache },
  );
  const polled = legs.find((leg) => leg.originIata === current.origin_iata.trim());
  if (polled === undefined) throw new VerificationLegMissingError();
  return polled;
}

/**
 * Apply one delivered leg to its flight, or report `'busy'` if a poll holds it.
 * @throws on a provider or database failure; the lease is handed back first.
 */
async function applyLeg(
  flightId: string,
  leg: FlightCandidate,
  deps: WebhookIngestDeps,
  now: Date,
): Promise<AppliedLeg | 'busy'> {
  const leased = await deps.pool.query<FlightRow>({
    text: LEASE_FLIGHT_FOR_WEBHOOK_SQL,
    values: [flightId, deps.leaseMs ?? DEFAULT_LEASE_MS],
    types: ENGINE_TYPES,
  });
  const current = leased.rows[0];
  // Leased by a poll in progress (or archived since the lookup): try next pass.
  if (current === undefined) return 'busy';

  try {
    // A delivery carries no feed health, so the stored tier stands.
    let fresh: FlightCandidate = { ...leg, trackingTier: current.tracking_tier };
    let events = detectChanges(current, fresh, { source: 'webhook' });
    let verified = false;

    if (events.some((event) => VERIFIED_EVENT_TYPES.has(event.type))) {
      // Unsigned deliveries (ADR 0003): a gate or cancellation is confirmed first,
      // and the poll's answer — not the webhook's — is what is written and diffed.
      fresh = await verificationPoll(current, deps);
      verified = true;
      events = detectChanges(current, fresh, { source: 'webhook' });
    }

    // Rule 7 (§12.7): the only writer of flight data.
    await ingestFlight(fresh, deps.writer, { now: () => now });
    const eventIds = await insertFlightEvents(deps.pool, current.id, events);

    // A subscribed `live` flight stays off the ladder (null); a landed one gets its
    // landed + 30 min poll, which unsubscribes and archives it (§7.6).
    const next = nextPollAt(ladderViewOf(current, fresh), now, deps.rng ?? Math.random, {
      webhooksEnabled: deps.webhooksEnabled ?? false,
    });
    await deps.pool.query({
      text: WEBHOOK_APPLIED_SQL,
      values: [current.id, next],
      types: ENGINE_TYPES,
    });

    return {
      flightId: current.id,
      events: events.map((event) => event.type),
      eventIds,
      verified,
    };
  } catch (error) {
    // Hand the lease back so the next pass (or a poll) is not held off for its
    // full length; if even that fails, it simply expires.
    await releaseLease(deps.pool, current.id).catch(() => undefined);
    throw error;
  }
}

async function markDone(client: PoolClient, inboxId: string, reason: string | null): Promise<void> {
  await client.query({ text: MARK_INBOX_DONE_SQL, values: [inboxId, reason], types: ENGINE_TYPES });
}

function outcome(inboxId: string, kind: InboxOutcomeKind, extra: Partial<InboxOutcome> = {}): InboxOutcome {
  return { inboxId, kind, flightIds: [], events: [], eventIds: [], verifications: 0, ...extra };
}

/**
 * Handle one claimed row. Every write to the inbox row goes through `client`,
 * inside the claiming transaction; flight writes go through the pool.
 */
async function handleRow(
  client: PoolClient,
  row: InboxRow,
  deps: WebhookIngestDeps,
): Promise<InboxOutcome> {
  const { logger } = deps;
  const now = (deps.now ?? (() => new Date()))();

  // 1. Re-validate. A body that fails is permanently bad: closed at once with a
  //    fixed reason code — no provider call, no five retries — and its `payload`
  //    is left untouched (MARK_INBOX_DONE_SQL writes only processed_at, attempts
  //    and last_error), so a delivery off the documented contract stays in the
  //    inbox for inspection. This is where a real delivery whose `status` is not
  //    a string lands until its type is captured and modelled.
  let delivery: AlertDelivery;
  try {
    delivery = parseAlertDelivery(row.payload);
    if (delivery.subscriptionId !== String(row.subscription_id).toLowerCase()) {
      throw new SubscriptionMismatchError();
    }
  } catch (error) {
    if (!(error instanceof ProviderDataError)) throw error;
    await markDone(client, row.id, INBOX_REASONS.INVALID_PAYLOAD);
    logger.warn({ inboxId: row.id, errorName: error.name }, 'webhook delivery failed validation; closed, payload kept');
    return outcome(row.id, 'invalid', { errorName: error.name });
  }

  try {
    // 2. Who holds this subscription?
    const holders = await deps.pool.query<SubscribedFlight>({
      text: FIND_SUBSCRIBED_FLIGHTS_SQL,
      values: [delivery.subscriptionId],
      types: ENGINE_TYPES,
    });

    if (holders.rows.length === 0) {
      await markDone(client, row.id, INBOX_REASONS.UNKNOWN_SUBSCRIPTION);
      logger.info(
        { inboxId: row.id, subscriptionId: delivery.subscriptionId },
        'webhook delivery for an unknown subscription; dropped',
      );
      return outcome(row.id, 'unknown_subscription');
    }

    // 3. Apply each leg to its own row.
    const { matched, ignored } = matchLegs(holders.rows, delivery.legs);
    const applied: AppliedLeg[] = [];

    for (const [flightId, leg] of matched) {
      const result = await applyLeg(flightId, leg, deps, now);
      if (result === 'busy') {
        // No inbox write: the row stays unprocessed and uncounted. Legs already
        // applied are idempotent on the retry — they diff to nothing.
        logger.debug({ inboxId: row.id, flightId }, 'flight leased by a poll; delivery deferred');
        return outcome(row.id, 'deferred', {
          flightIds: applied.map((leg) => leg.flightId),
          events: applied.flatMap((leg) => leg.events),
          eventIds: applied.flatMap((leg) => leg.eventIds),
          verifications: applied.filter((leg) => leg.verified).length,
        });
      }
      applied.push(result);
    }

    // 4. Free balance monitoring (§7.6). Once per delivery, only on success.
    const credits = delivery.creditsRemaining;
    if (credits !== null && isLoggableBalance(credits)) {
      await insertCreditLog(deps.pool, credits, CREDIT_LOG_SOURCE);
    } else if (credits !== null) {
      // The delivery schema already requires an integer, so only an int4 overflow
      // reaches here. Say so, as `credit-check` does; the value itself is not logged.
      logger.warn(
        { inboxId: row.id },
        'delivery credit balance is not a loggable integer; not recorded',
      );
    }

    await markDone(client, row.id, null);

    const result = outcome(row.id, 'processed', {
      flightIds: applied.map((leg) => leg.flightId),
      events: applied.flatMap((leg) => leg.events),
      eventIds: applied.flatMap((leg) => leg.eventIds),
      verifications: applied.filter((leg) => leg.verified).length,
    });
    logger.info(
      {
        inboxId: row.id,
        subscriptionId: delivery.subscriptionId,
        flightIds: result.flightIds,
        events: result.events,
        verifications: result.verifications,
        ignoredLegs: ignored,
        unmappedLegs: delivery.unmappedCount,
      },
      'webhook delivery applied',
    );
    return result;
  } catch (error) {
    // 5. Count it; give up at the cap. Class name only — never a message.
    const errorName = nameOf(error);
    const marked = await client.query<{ attempts: number; processed_at: string | null }>({
      text: MARK_INBOX_FAILED_SQL,
      values: [row.id, errorName, INBOX_MAX_ATTEMPTS],
      types: ENGINE_TYPES,
    });
    const state = marked.rows[0];
    const abandoned = state !== undefined && state.processed_at !== null;

    if (abandoned) {
      logger.error(
        { inboxId: row.id, attempts: state.attempts, errorName },
        `webhook delivery abandoned after ${INBOX_MAX_ATTEMPTS} attempts`,
      );
    } else {
      logger.warn(
        { inboxId: row.id, attempts: state?.attempts, errorName },
        'webhook delivery failed; will retry',
      );
    }
    return outcome(row.id, abandoned ? 'abandoned' : 'failed', { errorName });
  }
}

/**
 * Claim one inbox row on `client`, inside the caller's transaction.
 *
 * Exported for the integration test, which proves two concurrent claimers never
 * get the same row.
 */
export async function claimInboxRow(
  client: PoolClient,
  skipIds: readonly string[] = [],
): Promise<InboxRow | null> {
  const result = await client.query<InboxRow>({
    text: CLAIM_INBOX_ROW_SQL,
    values: [INBOX_MAX_ATTEMPTS, [...skipIds]],
    types: ENGINE_TYPES,
  });
  return result.rows[0] ?? null;
}

async function claimAndHandle(
  client: PoolClient,
  seen: readonly string[],
  deps: WebhookIngestDeps,
): Promise<InboxOutcome | null> {
  await client.query('begin');
  try {
    const row = await claimInboxRow(client, seen);
    const result = row === null ? null : await handleRow(client, row, deps);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

/**
 * Drain up to `batchSize` inbox rows, one transaction per row.
 *
 * @throws only when the inbox itself cannot be read or written (missing table,
 *   missing grant, database down). A bad row is recorded on the row, not thrown.
 */
export async function drainWebhookInbox(deps: WebhookIngestDeps): Promise<DrainSummary> {
  const batchSize = deps.batchSize ?? DEFAULT_INBOX_BATCH_SIZE;
  const seen: string[] = [];
  const summary: DrainSummary = {
    claimed: 0,
    processed: 0,
    unknownSubscription: 0,
    invalid: 0,
    deferred: 0,
    failed: 0,
    abandoned: 0,
    events: 0,
    outcomes: [],
  };

  for (let i = 0; i < batchSize; i += 1) {
    const result = await withClient(deps.pool, (client) => claimAndHandle(client, seen, deps));
    if (result === null) break;

    seen.push(result.inboxId);
    summary.claimed += 1;
    summary.events += result.events.length;
    summary.outcomes.push(result);
    switch (result.kind) {
      case 'processed':
        summary.processed += 1;
        break;
      case 'unknown_subscription':
        summary.unknownSubscription += 1;
        break;
      case 'invalid':
        summary.invalid += 1;
        break;
      case 'deferred':
        summary.deferred += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'abandoned':
        summary.abandoned += 1;
        break;
    }
  }

  if (summary.claimed > 0) {
    deps.logger.info(
      {
        claimed: summary.claimed,
        processed: summary.processed,
        unknownSubscription: summary.unknownSubscription,
        invalid: summary.invalid,
        deferred: summary.deferred,
        failed: summary.failed,
        abandoned: summary.abandoned,
        events: summary.events,
      },
      'webhook inbox drained',
    );
  }
  return summary;
}

/** Postgres SQLSTATEs that mean "the inbox is not there for us yet". */
const INBOX_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  '42P01', // undefined_table: the receiver's migration has not been applied
  '42501', // insufficient_privilege: the grant has not been applied
]);

function sqlStateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export interface InboxDrainer {
  /** One drain. Never throws; `null` when the inbox could not be drained at all. */
  drain(): Promise<DrainSummary | null>;
}

/**
 * The drain as the worker loop runs it: failures are logged, never thrown, so a
 * missing inbox (the API's migration not yet applied) never stops polling.
 *
 * The same failure repeated every pass is logged once at warn/error and then at
 * debug, so a missing table is one line in Render's logs, not 2,880 a day. Logs
 * carry the error class and SQLSTATE only: a `pg` error's message and detail can
 * quote table contents.
 */
export function createInboxDrainer(deps: WebhookIngestDeps): InboxDrainer {
  let lastFailure: string | null = null;

  return {
    async drain(): Promise<DrainSummary | null> {
      try {
        const summary = await drainWebhookInbox(deps);
        if (lastFailure !== null) {
          deps.logger.info('webhook inbox reachable again');
          lastFailure = null;
        }
        return summary;
      } catch (error) {
        const code = sqlStateOf(error);
        const key = code ?? nameOf(error);
        const unavailable = code !== null && INBOX_UNAVAILABLE_CODES.has(code);
        const fields = { errorName: nameOf(error), code };

        if (key === lastFailure) {
          deps.logger.debug(fields, 'webhook inbox drain still failing');
        } else if (unavailable) {
          deps.logger.warn(fields, 'webhook inbox unavailable (migration or grant not applied); drain skipped');
        } else {
          deps.logger.error(fields, 'webhook inbox drain failed');
        }
        lastFailure = key;
        return null;
      }
    },
  };
}
