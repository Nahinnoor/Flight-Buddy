/**
 * The daily archive backstop (§8.9), body for the `archive-backstop` scheduled job.
 *
 * "Landed + 30 minutes" is the normal way a flight retires, and it requires
 * *observing* the arrival. A `scheduled`-tier flight may never report one; a
 * cancelled flight never arrives at all; a feed can simply stop. Without a
 * backstop those rows keep a `next_poll_at` forever and spend provider units on a
 * flight that happened last Tuesday.
 *
 * So: any unarchived flight whose arrival is more than six hours in the past is
 * archived and taken off the ladder, whatever its status says.
 *
 * ## Which arrival
 *
 * `greatest(scheduled, estimated, actual)` — the *latest* arrival instant anyone
 * has claimed. `greatest` ignores NULLs in Postgres, so a row with only a schedule
 * uses that. Taking the latest rather than the most authoritative is deliberate for
 * a backstop: being six hours late to archive is harmless, archiving a flight that
 * is still in the air is not.
 *
 * When no arrival time is known at all, the flight is placed at
 * `scheduled_departure_utc + ARRIVAL_FALLBACK_HOURS` — longer than any scheduled
 * commercial flight — so a row with departure data but no arrival data still
 * retires instead of living forever.
 *
 * A `manual`-tier row with no times whatsoever is left alone: there is nothing to
 * measure from, and archiving on `created_at` would quietly retire a flight
 * somebody entered by hand for next spring. Any other tier with no times at all
 * is a row the provider has stopped describing (§8.8); it retires
 * `NO_TIMES_ARCHIVE_DAYS` after it was created rather than polling daily forever.
 *
 * `flightbuddy_worker` has UPDATE but no DELETE on `flights`, and archiving is a
 * timestamp, not a delete.
 */
import type { Pool } from '../db';
import type { Logger } from '../logger';
import { ENGINE_TYPES } from './types';

/** §8.9. */
export const ARCHIVE_AFTER_ARRIVAL_HOURS = 6;

/** Stand-in arrival for a row that has a departure time and no arrival time at all. */
export const ARRIVAL_FALLBACK_HOURS = 18;

/** Stand-in arrival for a non-`manual` row with no times at all, measured from `created_at`. */
export const NO_TIMES_ARCHIVE_DAYS = 30;

/**
 * `$1` = the cutoff age in hours, `$2` = the no-arrival fallback in hours,
 * `$3` = the no-times fallback in days (never applied to `manual` rows).
 *
 * All three are bound parameters rather than literals so the constants above are
 * the single source of truth and the statement text never varies.
 */
export const ARCHIVE_BACKSTOP_SQL = `update public.flights
   set archived_at = now(),
       next_poll_at = null,
       poll_lease_until = null
 where archived_at is null
   and coalesce(
         greatest(scheduled_arrival_utc, estimated_arrival_utc, actual_arrival_utc),
         scheduled_departure_utc + ($2::double precision * interval '1 hour'),
         case when tracking_tier <> 'manual'
              then created_at + ($3::double precision * interval '1 day')
         end
       ) < now() - ($1::double precision * interval '1 hour')
returning id`;

export interface ArchiveBackstopResult {
  archivedFlightIds: string[];
}

/**
 * Archive every flight that is more than `ARCHIVE_AFTER_ARRIVAL_HOURS` past its
 * latest known arrival.
 *
 * Idempotent: `archived_at is null` means a second run in the same hour finds
 * nothing, which matters because pg-boss can redeliver a scheduled job (§5).
 */
export async function archiveStaleFlights(pool: Pool): Promise<ArchiveBackstopResult> {
  const result = await pool.query<{ id: string }>({
    text: ARCHIVE_BACKSTOP_SQL,
    values: [ARCHIVE_AFTER_ARRIVAL_HOURS, ARRIVAL_FALLBACK_HOURS, NO_TIMES_ARCHIVE_DAYS],
    types: ENGINE_TYPES,
  });

  return { archivedFlightIds: result.rows.map((row) => row.id) };
}

export interface ArchiveBackstopDeps {
  pool: Pool;
  logger: Logger;
}

/**
 * The pg-boss handler `queue.ts` registers for `archive-backstop`.
 *
 * Logs the count and the ids — the ids are the only way to answer "why did my
 * flight disappear" later, and a flight id is not personal data.
 */
export function createArchiveBackstopHandler({ pool, logger }: ArchiveBackstopDeps) {
  return async function handleArchiveBackstop(): Promise<void> {
    const { archivedFlightIds } = await archiveStaleFlights(pool);

    if (archivedFlightIds.length === 0) {
      logger.info({ job: 'archive-backstop', archived: 0 }, 'archive backstop: nothing stale');
      return;
    }

    logger.info(
      {
        job: 'archive-backstop',
        archived: archivedFlightIds.length,
        flightIds: archivedFlightIds,
      },
      'archive backstop archived flights past arrival + 6 h (§8.9)',
    );
  };
}
