/**
 * `credit-check`, the hourly scheduled job (§7.7, ADR 0003 decisions 3 and 4).
 *
 * §7.7 calls this the most critical reliability requirement in the system. The
 * alert credit balance is shared by every subscription on the account; at zero
 * **all** of them pause, platform-wide, and nothing tells us. So once an hour:
 *
 * 1. Read `GET /subscriptions/balance` (free, but a provider request, so it takes a
 *    limiter slot like every other).
 * 2. Decide whether the reading crossed a low-water mark (300, 100, 0).
 * 3. At zero or below, put every subscribed flight back on the polling ladder.
 * 4. Record the reading in `provider_credit_log` (`source = 'balance_check'`).
 * 5. Raise an operator alert for a crossing: logged now, pushed from wave 5.
 *
 * ## Alerts fire once per downward crossing, from data already stored
 *
 * No extra table: `provider_credit_log` is the dedupe state. A mark `T` is
 * **armed** until this job has recorded a `balance_check` reading at or below it,
 * and is **re-armed** by any later reading above it, from any source — a webhook
 * delivery, a `post_refill` row, or this job. A reading at or below an armed mark
 * alerts; the alert names the lowest armed mark it reached. The check is made
 * *before* this run inserts its own row. Consequences, each tested:
 *
 * - A balance sitting at 250 alerts once, not every hour.
 * - 300 → 50 crosses two marks in one step and raises **one** alert naming 100.
 * - A refill re-arms the marks it rose above, so the next fall alerts again.
 * - Equal readings never alert twice.
 * - **First ever run** (the log is empty): every mark is armed. A worker deployed
 *   onto an account already at 40 credits says so on its first run instead of
 *   staying silent until a second reading exists — and at zero, silence is exactly
 *   the failure §8.1 describes. A healthy first reading alerts nothing.
 *
 * Why not simply "the previous row, of any source, was above `T`": webhook
 * deliveries log balances too, but they never alert. A delivery reporting 0
 * logged ten minutes before this job ran would make the job's reading look like
 * no change, and the zero alert would never be raised. Only this job's own
 * readings *disarm* a mark; every source may re-arm one.
 *
 * Rows are ordered by `id` (a `bigserial`, so insertion order) rather than
 * `observed_at`, which is transaction start time and can tie. The statement scans
 * the log, which grows by about 9,000 rows a year plus one per delivery — nothing
 * at beta scale; an index on `(balance)` is the fix if it ever matters.
 *
 * ## The zero-balance failover (§7.7 step 3)
 *
 * The sweep runs on **every** reading at or below zero, not only on the crossing,
 * and before the reading is logged: if the sweep throws, nothing is logged, the
 * mark stays armed, and the next run alerts and sweeps again.
 *
 * It sets `next_poll_at = now()` on unarchived rows holding an
 * `alert_subscription_id`, and only on those — a `live` flight that has not
 * subscribed yet is untouched, because the ladder already polls it. The deployed
 * stack held both at once on 2026-09-16: a subscribed flight on the two-hour backup
 * cadence (the exact row this sweep exists for), and a `live` flight not yet
 * subscribed.
 *
 * **The row keeps its `alert_subscription_id`.** Zero credits *pause* the
 * provider's subscriptions; they resume by themselves when the owner refills.
 * Detaching would make the next `reconcile-subscriptions` delete them (it deletes
 * what no active row claims), and would orphan any delivery that arrives after the
 * refill, because the drain finds a delivery's flights by that id.
 *
 * Keeping the id means the ladder must not read it as "webhooks have this
 * covered" — `ladderIntervalMs` returns the two-hour backup cadence for a
 * subscribed `live` flight. `pollWebhookSettings` below is how that is avoided:
 * while the balance is exhausted the poll pass runs **exactly as if webhooks were
 * off**. The ladder skips the subscribed branch and a subscribed flight is polled
 * on the failover ladder; and, with no receiver URL, `pollAndUpdate` never reaches
 * `shouldSubscribe`, so an unsubscribed `live` flight reaching its window opening during the
 * outage does not open a subscription that could deliver nothing. Closing a
 * subscription at archive, or when a flight stops being subscribable, is
 * independent of that switch and keeps working.
 *
 * ### Idempotency
 *
 * pg-boss can redeliver, and `missed: 'once'` can catch up, so the same hour can
 * run twice. The sweep only touches a row whose `next_poll_at` is null or further
 * out than `FAILOVER_SWEEP_CEILING_MS` — the coarsest band a subscribed flight
 * can be on the failover ladder (hourly, plus jitter). A row already due, or
 * already polled onto the failover ladder, is left alone, so a second run changes
 * nothing, and an outage lasting many hours does not pull every flight forward
 * once an hour. The first run's own `balance_check` row disarms the mark, so the
 * second run raises no alert.
 *
 * The shared state flips to exhausted **before** the sweep, not after it. The poll
 * loop reads the state when it starts a pass, before it claims, so any pass that
 * can claim a row the sweep made due already runs in failover.
 *
 * Two bounded windows remain, and the next zero reading (an hour later) closes
 * both, because each leaves the row beyond the ceiling: a poll that claimed a
 * flight *before* the sweep, because it was already due, and writes the backup
 * cadence when it finishes; and the inbox drain, which keeps its boot-time
 * `webhooksEnabled` and so schedules a delivery drained during the outage onto the
 * backup cadence. No delivery is sent at zero credits, so that needs a delivery
 * queued before the balance ran out.
 *
 * ### Recovery
 *
 * There is no recovery path to build. When a reading comes back above zero the
 * shared `CreditState` clears, the next poll pass runs with webhooks on again, and
 * a subscribed row's next ladder answer is the backup cadence: it is back on
 * webhooks, with its subscription never having left. `shouldSubscribe` returns
 * `false` for a row that already holds an id, so recovery makes no provider call; a
 * row that lost its subscription meanwhile re-subscribes on its next poll through
 * the existing window-opening path. The state only flips on this job's next reading, so a
 * refill is noticed within the hour — until then flights simply poll more often.
 *
 * `CreditState` is in memory, shared by this job and the loop in one process.
 * `main.ts` seeds it at boot from the latest `provider_credit_log` row, so a deploy
 * in the middle of an outage does not quietly put subscribed flights back on the
 * backup cadence.
 *
 * ## Operator alerts: the wave 4 / wave 5 seam
 *
 * §7.7 step 4 and PHASE2_PLAN §8.4 route operator alerts to the owner's phone as
 * an Expo push addressed by `OPERATOR_USER_ID`. That pipeline is wave 5. Wave 4
 * builds the detection: the job returns a typed `OperatorAlert` and hands it to
 * `onOperatorAlert` when one is supplied. **Wave 5 is the consumer** — it supplies
 * `onOperatorAlert` from `main.ts`, and owns the copy and the transport. Until
 * then the log line *is* the alert (ADR 0003 decision 4: Render's logs and failure
 * emails are the interim channel): `warn` for 300 and 100, `error` for zero.
 *
 * ## Webhooks off means hands off
 *
 * As with `reconcile.ts`: with `WEBHOOK_URL` unset the job does nothing. A worker
 * run locally against the shared database would otherwise log its own readings,
 * and the deployed worker would see a crossing as already observed and stay silent.
 *
 * Logs carry balances, thresholds, counts and flight ids. Never the operator's
 * user id, never a URL. `flightbuddy_worker` has UPDATE on `flights` and no DELETE
 * anywhere; nothing here deletes.
 */
import type { FlightDataProvider } from '@flightbuddy/flight-provider';

import type { Pool } from '../db';
import type { Logger } from '../logger';
import { JITTER_FRACTION, LADDER_INTERVALS } from './ladder';
import {
  CREDIT_LOG_SOURCES,
  insertCreditLog,
  isLoggableBalance,
  readLatestCreditBalance,
} from './repository';
import { ENGINE_TYPES } from './types';

/** ADR 0003 decision 3, highest first. `0` means "at or below zero". */
export const CREDIT_THRESHOLDS = [300, 100, 0] as const;

export type CreditThreshold = (typeof CREDIT_THRESHOLDS)[number];

/**
 * The furthest a subscribed flight's next poll can be while it is on the failover
 * ladder: the hourly band (24–6 h, the coarsest a subscribed flight inside T-24 h
 * can be in) at its maximum positive jitter.
 */
export const FAILOVER_SWEEP_CEILING_MS = Math.ceil(LADDER_INTERVALS.HOURLY * (1 + JITTER_FRACTION));

/**
 * For each mark in `$1`, whether it is already disarmed: a `balance_check` row at
 * or below it exists after the newest row (of any source) above it.
 */
export const DISARMED_THRESHOLDS_SQL = `select t.mark
  from unnest($1::int[]) as t(mark)
 where exists (
         select 1
           from public.provider_credit_log c
          where c.source = any($2::text[])
            and c.balance <= t.mark
            and c.id > coalesce(
                  (select max(a.id) from public.provider_credit_log a where a.balance > t.mark),
                  0)
       )`;

/**
 * §7.7 step 3. `$1` = `FAILOVER_SWEEP_CEILING_MS`. Subscribed rows only; the id is
 * kept (see the module note).
 */
export const FAILOVER_SUBSCRIBED_FLIGHTS_SQL = `update public.flights
   set next_poll_at = now()
 where archived_at is null
   and alert_subscription_id is not null
   and (next_poll_at is null
        or next_poll_at > now() + ($1::double precision * interval '1 millisecond'))
returning id`;

// --- the shared credit state ------------------------------------------------

/**
 * Whether the alert balance is exhausted, shared between this job and the worker
 * loop. Written by `credit-check`, seeded by `main.ts` at boot.
 */
export interface CreditState {
  exhausted(): boolean;
  /** Record a balance reading. `null` (nothing known) leaves the state unchanged. */
  observe(balance: number | null): void;
}

/** @param initialBalance The latest logged balance, or `null` when none is known (treated as healthy). */
export function createCreditState(initialBalance: number | null = null): CreditState {
  let exhausted = initialBalance !== null && initialBalance <= 0;
  return {
    exhausted: () => exhausted,
    observe(balance) {
      if (balance !== null) exhausted = balance <= 0;
    },
  };
}

/**
 * What the poll pass is allowed to do with webhooks right now.
 *
 * Exhausted credits run the pass as if `WEBHOOK_URL` were unset: subscribed
 * flights take the failover ladder instead of the backup cadence, and nothing
 * opens a subscription against an empty balance.
 */
export function pollWebhookSettings(
  webhookUrl: string | undefined,
  creditState: Pick<CreditState, 'exhausted'>,
): { webhooksEnabled: boolean; webhookUrl?: string } {
  if (webhookUrl === undefined || creditState.exhausted()) return { webhooksEnabled: false };
  return { webhooksEnabled: true, webhookUrl };
}

// --- thresholds --------------------------------------------------------------

/**
 * The lowest armed mark this reading is at or below, or `null` for no alert.
 *
 * @param disarmed Marks this job has already alerted on since they were last
 *   re-armed (`DISARMED_THRESHOLDS_SQL`). Empty on the first ever run.
 */
export function crossedThreshold(
  balance: number,
  disarmed: ReadonlySet<number>,
): CreditThreshold | null {
  let lowest: CreditThreshold | null = null;
  // Highest first, so the last match is the lowest mark reached.
  for (const mark of CREDIT_THRESHOLDS) {
    if (balance <= mark && !disarmed.has(mark)) lowest = mark;
  }
  return lowest;
}

/** Marks already disarmed, read before this run logs its reading. */
export async function readDisarmedThresholds(pool: Pool): Promise<Set<number>> {
  const result = await pool.query<{ mark: number }>({
    text: DISARMED_THRESHOLDS_SQL,
    // The job's own readings disarm a mark: real ones, and a drill's forced zero
    // (otherwise a drill would re-alert every hour it ran).
    values: [[...CREDIT_THRESHOLDS], [CREDIT_LOG_SOURCES.BALANCE_CHECK, CREDIT_LOG_SOURCES.DRILL]],
    types: ENGINE_TYPES,
  });
  return new Set(result.rows.map((row) => Number(row.mark)));
}

// --- the job -------------------------------------------------------------------

/**
 * One operator alert, shaped for wave 5 to route without reshaping.
 *
 * Numbers, ids and a kind — no copy. Wave 5 turns it into a push to
 * `recipientUserId` and chooses the words.
 */
export interface OperatorAlert {
  kind: 'credit_low' | 'credit_exhausted';
  /** `error` for exhaustion, `warn` otherwise. Also the log level used today. */
  severity: 'warn' | 'error';
  /** The lowest mark crossed. */
  threshold: CreditThreshold;
  balance: number;
  /** The latest logged reading before this one, of any source; `null` on the first ever. */
  previousBalance: number | null;
  /** Flights this run put back on the polling ladder. Empty for `credit_low`. */
  failedOverFlightIds: string[];
  /** `OPERATOR_USER_ID`, or `null` when unset. Never logged. */
  recipientUserId: string | null;
  /** ISO-8601 UTC. */
  observedAt: string;
}

export interface CreditCheckDeps {
  pool: Pool;
  provider: FlightDataProvider;
  rateLimiter: { acquire(): Promise<void> };
  logger: Logger;
  /** `WEBHOOK_URL` is set. Off: the job is a no-op (see the module note). */
  webhooksEnabled: boolean;
  /** Shared with the worker loop; this job writes it. */
  creditState: CreditState;
  /** `OPERATOR_USER_ID`. Carried on the alert for wave 5, never logged. */
  operatorUserId?: string | undefined;
  /**
   * Wave 5's transport. Absent in wave 4, where the log line is the alert. A
   * failure is logged and swallowed: the reading is already stored and the log
   * line already written, and a retry would find the mark disarmed.
   */
  onOperatorAlert?: (alert: OperatorAlert) => Promise<void>;
  /**
   * The credit-failover drill (PHASE2_PLAN criterion 7's manual half). When
   * true, the balance reading is forced to 0 instead of asking the provider, so
   * the real failover can be watched without spending the real balance.
   * Everything downstream is unchanged: the sweep, the credit state, the
   * operator alert. Recorded as source `drill`. Set only through
   * `CREDIT_DRILL_ZERO=1`, and logged at error on every run while on.
   */
  drillZero?: boolean;
  now?: () => Date;
}

export interface CreditCheckResult {
  skipped: boolean;
  balance: number | null;
  previousBalance: number | null;
  /** Whether this reading was written to `provider_credit_log`. */
  logged: boolean;
  /** Flights put back on the polling ladder by this run. */
  failedOverFlightIds: string[];
  alert: OperatorAlert | null;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * One credit check. A provider failure ends the run quietly (logged at `error`)
 * and changes no state — acting on a balance we could not read would be acting on
 * nothing. A database failure throws, and pg-boss records the job as failed.
 */
export async function runCreditCheck(deps: CreditCheckDeps): Promise<CreditCheckResult> {
  const result: CreditCheckResult = {
    skipped: false,
    balance: null,
    previousBalance: null,
    logged: false,
    failedOverFlightIds: [],
    alert: null,
  };
  const { logger } = deps;

  if (!deps.webhooksEnabled) {
    logger.info({ job: 'credit-check' }, 'webhooks disabled; credit check skipped');
    return { ...result, skipped: true };
  }

  let balance: number;
  try {
    if (deps.drillZero === true) {
      // Loud on purpose: a drill left on would keep every subscribed flight on
      // the polling ladder and keep alerting the owner.
      logger.error(
        { job: 'credit-check', creditDrill: true },
        'CREDIT DRILL ACTIVE: balance reading forced to 0 (CREDIT_DRILL_ZERO); the provider was not asked',
      );
      balance = 0;
    } else {
      await deps.rateLimiter.acquire();
      balance = await deps.provider.getCreditBalance();
    }
  } catch (error) {
    // `error`, not `warn`: an unreadable balance hides exactly the outage this job
    // exists to catch, and it recurring every hour should be loud.
    logger.error(
      { job: 'credit-check', errorName: nameOf(error) },
      'could not read the alert credit balance; credit check skipped this hour',
    );
    return { ...result, skipped: true };
  }
  result.balance = balance;

  // First, before any query. The poll loop runs concurrently with this job and
  // reads the state when it starts a pass, before it claims. Flipping it *after*
  // the sweep left a gap: a pass starting between the sweep's commit and the flip
  // would claim the rows just made due with webhooks still on, and write the
  // two-hour backup cadence straight back onto the flights the sweep protects.
  // Nothing below depends on the state, so a throwing sweep loses nothing: the
  // state is already right, and no reading is logged, so the next run re-alerts.
  deps.creditState.observe(balance);

  // Both before this run's own row exists.
  const previous = await readLatestCreditBalance(deps.pool);
  result.previousBalance = previous;
  const crossed = crossedThreshold(balance, await readDisarmedThresholds(deps.pool));

  if (balance <= 0) {
    const swept = await deps.pool.query<{ id: string }>({
      text: FAILOVER_SUBSCRIBED_FLIGHTS_SQL,
      values: [FAILOVER_SWEEP_CEILING_MS],
      types: ENGINE_TYPES,
    });
    result.failedOverFlightIds = swept.rows.map((row) => row.id);
  }

  if (isLoggableBalance(balance)) {
    await insertCreditLog(
      deps.pool,
      balance,
      deps.drillZero === true ? CREDIT_LOG_SOURCES.DRILL : CREDIT_LOG_SOURCES.BALANCE_CHECK,
    );
    result.logged = true;
  } else {
    // A number the int column cannot hold is a provider bug; do not let it
    // disarm or re-arm a mark.
    logger.warn({ job: 'credit-check' }, 'credit balance is not a loggable integer; not recorded');
  }

  const now = (deps.now ?? (() => new Date()))();

  if (crossed !== null) {
    const exhausted = crossed === 0;
    const alert: OperatorAlert = {
      kind: exhausted ? 'credit_exhausted' : 'credit_low',
      severity: exhausted ? 'error' : 'warn',
      threshold: crossed,
      balance,
      previousBalance: previous,
      failedOverFlightIds: result.failedOverFlightIds,
      recipientUserId: deps.operatorUserId ?? null,
      observedAt: now.toISOString(),
    };
    result.alert = alert;

    // Explicit fields, never the alert object: it carries the operator's user id.
    const fields = {
      job: 'credit-check',
      operatorAlert: alert.kind,
      threshold: alert.threshold,
      balance: alert.balance,
      previousBalance: alert.previousBalance,
      failedOver: alert.failedOverFlightIds.length,
      flightIds: alert.failedOverFlightIds,
      operatorConfigured: alert.recipientUserId !== null,
    };
    if (exhausted) {
      logger.error(
        fields,
        'OPERATOR ALERT: alert credits exhausted; every subscription is paused, subscribed flights are back on the polling ladder (§7.7)',
      );
    } else {
      logger.warn(
        fields,
        `OPERATOR ALERT: alert credits at or below ${crossed}; refill by hand (ADR 0003)`,
      );
    }

    if (deps.onOperatorAlert !== undefined) {
      try {
        await deps.onOperatorAlert(alert);
      } catch (error) {
        logger.error(
          { job: 'credit-check', operatorAlert: alert.kind, errorName: nameOf(error) },
          'operator alert could not be delivered; the log line above stands in for it',
        );
      }
    }
  } else if (result.failedOverFlightIds.length > 0) {
    // Still at zero, and a row had drifted back off the failover ladder (a poll
    // that was in flight during the last sweep). Worth a line; not a new alert.
    logger.warn(
      {
        job: 'credit-check',
        balance,
        failedOver: result.failedOverFlightIds.length,
        flightIds: result.failedOverFlightIds,
      },
      'alert credits still exhausted; subscribed flights put back on the polling ladder',
    );
  }

  logger.info(
    {
      job: 'credit-check',
      balance,
      previousBalance: previous,
      exhausted: deps.creditState.exhausted(),
      failedOver: result.failedOverFlightIds.length,
    },
    'credit balance checked',
  );
  return result;
}

/** The pg-boss handler `main.ts` registers for `credit-check`. */
export function createCreditCheckHandler(deps: CreditCheckDeps) {
  return async function handleCreditCheck(): Promise<void> {
    await runCreditCheck(deps);
  };
}
