/**
 * One pass of the worker loop (§7.5).
 *
 * ```ts
 * const due = await claimDueFlights(25);   // lease, commit, THEN poll
 * for (const f of due) {
 *   await rateLimiter.acquire();           // 1 req/s
 *   await pollAndUpdate(f);
 * }
 * ```
 *
 * **Sequential on purpose.** The limiter already paces the pass at one call per
 * second, so running the batch concurrently would buy nothing but 25 promises
 * queued behind the same bucket, a harder failure mode to read in the logs, and 25
 * simultaneous connection checkouts from a pool of three.
 *
 * **Nothing is released.** A poll that finishes writes its own `next_poll_at` and
 * clears the lease; a poll that dies leaves a lease that expires two minutes later
 * (§8.7). There is no cleanup path to get wrong on a Render restart.
 *
 * The pass logs counts plus the claimed flight ids, and nothing else: no provider
 * bodies, no users, no numbers anyone typed (§5).
 */
import { claimDueFlights, DEFAULT_LEASE_MS } from './lease';
import { pollAndUpdate, type PollDependencies, type PollOutcome } from './poll';

export interface PollPassOptions extends PollDependencies {
  batchSize: number;
  leaseMs?: number;
}

export interface PollPassSummary {
  claimed: number;
  updated: number;
  failed: number;
  archived: number;
  events: number;
  outcomes: PollOutcome[];
}

/**
 * Claim a batch and poll it.
 *
 * A single flight's failure is already folded into its `PollOutcome`, so the only
 * thing that throws out of here is a database that will not answer — which the
 * loop logs before sleeping and trying again.
 */
export async function runPollPass(options: PollPassOptions): Promise<PollPassSummary> {
  const { batchSize, leaseMs = DEFAULT_LEASE_MS, ...deps } = options;

  const due = await claimDueFlights(deps.pool, batchSize, leaseMs);

  const summary: PollPassSummary = {
    claimed: due.length,
    updated: 0,
    failed: 0,
    archived: 0,
    events: 0,
    outcomes: [],
  };

  if (due.length === 0) {
    deps.logger.debug({ claimed: 0 }, 'poll pass: nothing due');
    return summary;
  }

  for (const flight of due) {
    const outcome = await pollAndUpdate(flight, deps);
    summary.outcomes.push(outcome);

    if (outcome.kind === 'updated') {
      summary.updated += 1;
      summary.events += outcome.events.length;
      if (outcome.archived) summary.archived += 1;
    } else {
      summary.failed += 1;
    }
  }

  deps.logger.info(
    {
      claimed: summary.claimed,
      updated: summary.updated,
      failed: summary.failed,
      archived: summary.archived,
      events: summary.events,
      // Ids are the only identifiers that ever reach a log line (§5, §10).
      flightIds: due.map((flight) => flight.id),
    },
    'poll pass complete',
  );

  return summary;
}
