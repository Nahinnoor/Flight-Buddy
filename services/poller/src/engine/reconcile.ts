/**
 * `reconcile-subscriptions`, the hourly scheduled job (ADR 0003 decision 8).
 *
 * Subscriptions **never expire** in the 2026 alert API, so anything the lifecycle
 * leaves behind bills credits forever. Once an hour this job compares the
 * provider's list with the flight rows and repairs both directions:
 *
 * 1. A provider subscription that no active, unarchived flight row claims is
 *    deleted — a failed unsubscribe at archive, a row archived by the backstop, a
 *    subscribe whose id never made it into the database.
 * 2. An active row whose subscription the provider no longer has (or reports
 *    inactive) is detached and put back on the ladder (`next_poll_at = now()`), so
 *    it is polled at once and, past its window opening, re-subscribes on that poll.
 *
 * ## The grace window
 *
 * Subscribing is two steps — create at the provider, then store the id — and so is
 * this job — list, then read the rows. Anything younger than `RECONCILE_GRACE_MS`
 * on either side is left alone, so a subscribe racing this job is never mistaken
 * for an orphan (deleted) or a loss (detached).
 *
 * ## Webhooks off means hands off
 *
 * With `WEBHOOK_URL` unset the job does nothing at all. A worker run locally
 * without the variable, against the same database and account as the deployed
 * one, must not delete the deployed worker's subscriptions.
 *
 * Every provider call takes a limiter slot. Logs carry subscription and flight
 * ids only.
 */
import type { FlightDataProvider } from '@flightbuddy/flight-provider';

import type { Pool } from '../db';
import type { Logger } from '../logger';
import { ENGINE_TYPES, type FlightRow } from './types';

/** Long enough to cover one subscribe (create + store) and one reconcile (list + read). */
export const RECONCILE_GRACE_MS = 10 * 60_000;

export const ACTIVE_SUBSCRIPTIONS_SQL = `select id, alert_subscription_id, alert_subscribed_at
  from public.flights
 where archived_at is null
   and alert_subscription_id is not null`;

/** Back onto the ladder, now. Only if the row still holds the id we judged. */
export const DETACH_SUBSCRIPTION_SQL = `update public.flights
   set alert_subscription_id = null,
       alert_subscribed_at = null,
       next_poll_at = now()
 where id = $1
   and alert_subscription_id = $2
   and archived_at is null
returning id`;

export interface ReconcileDeps {
  pool: Pool;
  provider: FlightDataProvider;
  rateLimiter: { acquire(): Promise<void> };
  logger: Logger;
  /** `WEBHOOK_URL` is set. Off: the job is a no-op (see the module note). */
  webhooksEnabled: boolean;
  now?: () => Date;
  graceMs?: number;
}

export interface ReconcileResult {
  skipped: boolean;
  listed: number;
  /** Provider subscription ids deleted. */
  deleted: string[];
  /** Provider subscription ids whose delete failed; next hour tries again. */
  failedDeletes: string[];
  /** Flight ids put back on the ladder. */
  detached: string[];
}

type ClaimRow = Pick<FlightRow, 'id' | 'alert_subscription_id' | 'alert_subscribed_at'>;

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * One reconcile run. A provider failure on the list ends the run quietly (logged);
 * acting on a list we could not read would be acting on nothing. A database
 * failure throws, and pg-boss records the job as failed.
 */
export async function reconcileSubscriptions(deps: ReconcileDeps): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    skipped: false,
    listed: 0,
    deleted: [],
    failedDeletes: [],
    detached: [],
  };

  if (!deps.webhooksEnabled) {
    deps.logger.info({ job: 'reconcile-subscriptions' }, 'webhooks disabled; reconcile skipped');
    return { ...result, skipped: true };
  }

  const now = (deps.now ?? (() => new Date()))();
  const cutoff = now.getTime() - (deps.graceMs ?? RECONCILE_GRACE_MS);
  const isYoung = (iso: string | null): boolean => {
    if (iso === null) return false;
    const at = Date.parse(iso);
    return !Number.isNaN(at) && at > cutoff;
  };

  let subscriptions;
  try {
    await deps.rateLimiter.acquire();
    subscriptions = await deps.provider.listSubscriptions();
  } catch (error) {
    deps.logger.warn(
      { job: 'reconcile-subscriptions', errorName: nameOf(error) },
      'could not list provider subscriptions; reconcile skipped this hour',
    );
    return { ...result, skipped: true };
  }
  result.listed = subscriptions.length;

  const claims = await deps.pool.query<ClaimRow>({
    text: ACTIVE_SUBSCRIPTIONS_SQL,
    types: ENGINE_TYPES,
  });
  const claimed = new Set(
    claims.rows.flatMap((row) =>
      row.alert_subscription_id === null ? [] : [row.alert_subscription_id.toLowerCase()],
    ),
  );
  // An inactive subscription delivers nothing; for our purposes it is gone.
  const delivering = new Set(
    subscriptions.filter((sub) => sub.isActive).map((sub) => sub.subscriptionId.toLowerCase()),
  );

  // 1. Provider side: delete what nothing claims, and what no longer delivers.
  for (const sub of subscriptions) {
    const orphan = !claimed.has(sub.subscriptionId.toLowerCase());
    if (!orphan && sub.isActive) continue;
    if (isYoung(sub.createdAtUtc)) continue;

    try {
      await deps.rateLimiter.acquire();
      await deps.provider.unsubscribeAlerts(sub.subscriptionId);
      result.deleted.push(sub.subscriptionId);
    } catch (error) {
      result.failedDeletes.push(sub.subscriptionId);
      deps.logger.warn(
        {
          job: 'reconcile-subscriptions',
          subscriptionId: sub.subscriptionId,
          errorName: nameOf(error),
        },
        'could not delete an orphaned subscription; next run retries',
      );
    }
  }

  // 2. Our side: rows whose subscription is not delivering go back on the ladder.
  for (const row of claims.rows) {
    if (row.alert_subscription_id === null) continue;
    if (delivering.has(row.alert_subscription_id.toLowerCase())) continue;
    if (isYoung(row.alert_subscribed_at)) continue;

    const detached = await deps.pool.query<{ id: string }>({
      text: DETACH_SUBSCRIPTION_SQL,
      values: [row.id, row.alert_subscription_id],
      types: ENGINE_TYPES,
    });
    if (detached.rows.length > 0) result.detached.push(row.id);
  }

  deps.logger.info(
    {
      job: 'reconcile-subscriptions',
      listed: result.listed,
      claimed: claimed.size,
      deleted: result.deleted,
      failedDeletes: result.failedDeletes,
      detachedFlightIds: result.detached,
    },
    'subscriptions reconciled',
  );
  return result;
}

/** The pg-boss handler `main.ts` registers for `reconcile-subscriptions`. */
export function createReconcileHandler(deps: ReconcileDeps) {
  return async function handleReconcileSubscriptions(): Promise<void> {
    await reconcileSubscriptions(deps);
  };
}
