import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger';
import {
  ARCHIVE_AFTER_ARRIVAL_HOURS,
  ARCHIVE_BACKSTOP_SQL,
  ARRIVAL_FALLBACK_HOURS,
  NO_TIMES_ARCHIVE_DAYS,
  archiveStaleFlights,
  createArchiveBackstopHandler,
} from './archiveBackstop';
import { createFakePool } from './fakePool';

const logger = createLogger({ level: 'silent' });

describe('ARCHIVE_BACKSTOP_SQL', () => {
  it('detaches any alert subscription; reconcile deletes it at the provider (wave 3)', () => {
    expect(ARCHIVE_BACKSTOP_SQL).toContain('alert_subscription_id = null');
    expect(ARCHIVE_BACKSTOP_SQL).toContain('alert_subscribed_at = null');
  });

  it('archives rather than deletes: the worker role has no DELETE', () => {
    expect(ARCHIVE_BACKSTOP_SQL).toContain('update public.flights');
    expect(ARCHIVE_BACKSTOP_SQL).toContain('archived_at = now()');
    expect(ARCHIVE_BACKSTOP_SQL.toLowerCase()).not.toContain('delete');
  });

  it('takes the flight off the ladder and drops any lease', () => {
    expect(ARCHIVE_BACKSTOP_SQL).toContain('next_poll_at = null');
    expect(ARCHIVE_BACKSTOP_SQL).toContain('poll_lease_until = null');
  });

  it('is idempotent: it only touches rows that are not archived yet', () => {
    expect(ARCHIVE_BACKSTOP_SQL).toContain('archived_at is null');
  });

  it('measures from the latest known arrival, with a departure-based fallback', () => {
    expect(ARCHIVE_BACKSTOP_SQL).toContain(
      'greatest(scheduled_arrival_utc, estimated_arrival_utc, actual_arrival_utc)',
    );
    expect(ARCHIVE_BACKSTOP_SQL).toContain('scheduled_departure_utc + ($2::double precision');
    expect(ARCHIVE_BACKSTOP_SQL).toContain('now() - ($1::double precision');
  });

  it('binds every threshold instead of inlining it', () => {
    // A literal here would let the constants and the statement drift apart. The
    // only literals are interval units and the tier name.
    expect(ARCHIVE_BACKSTOP_SQL).not.toContain('6 hours');
    expect(ARCHIVE_BACKSTOP_SQL).not.toContain('30 days');
    const literals = ARCHIVE_BACKSTOP_SQL.match(/'[^']*'/g) ?? [];
    expect(new Set(literals)).toEqual(new Set(["'1 hour'", "'1 day'", "'manual'"]));
    expect(ARCHIVE_BACKSTOP_SQL).not.toContain(';');
  });

  it('leaves a manual row with no times alone, but retires any other tier by created_at', () => {
    // For a `manual` row every coalesce arm is NULL, and `NULL < …` is never true,
    // so a hand-entered flight is never archived by accident. Any other tier with
    // no times is a row the provider stopped describing (§8.8): it falls back to
    // created_at + NO_TIMES_ARCHIVE_DAYS instead of polling daily forever.
    expect(ARCHIVE_BACKSTOP_SQL).toContain('coalesce(');
    expect(ARCHIVE_BACKSTOP_SQL).toContain("case when tracking_tier <> 'manual'");
    expect(ARCHIVE_BACKSTOP_SQL).toContain('created_at + ($3::double precision');
    expect(NO_TIMES_ARCHIVE_DAYS).toBe(30);
  });
});

describe('archiveStaleFlights', () => {
  it('binds the three thresholds from the constants', async () => {
    const fake = createFakePool();
    fake.queue([{ id: 'flight-1' }, { id: 'flight-2' }]);

    const result = await archiveStaleFlights(fake.pool);

    expect(result.archivedFlightIds).toEqual(['flight-1', 'flight-2']);
    expect(fake.statements[0]?.text).toBe(ARCHIVE_BACKSTOP_SQL);
    expect(fake.statements[0]?.values).toEqual([
      ARCHIVE_AFTER_ARRIVAL_HOURS,
      ARRIVAL_FALLBACK_HOURS,
      NO_TIMES_ARCHIVE_DAYS,
    ]);
    expect(ARCHIVE_AFTER_ARRIVAL_HOURS).toBe(6);
  });

  it('reports an empty run', async () => {
    const fake = createFakePool();
    await expect(archiveStaleFlights(fake.pool)).resolves.toEqual({ archivedFlightIds: [] });
  });
});

describe('createArchiveBackstopHandler', () => {
  it('runs the statement once per job batch', async () => {
    const fake = createFakePool();
    fake.queue([{ id: 'flight-1' }]);

    await createArchiveBackstopHandler({ pool: fake.pool, logger })();

    expect(fake.statements).toHaveLength(1);
  });

  it('is a no-op when nothing is stale, so a redelivery is harmless', async () => {
    const fake = createFakePool();
    const handler = createArchiveBackstopHandler({ pool: fake.pool, logger });

    await handler();
    await handler();

    expect(fake.statements).toHaveLength(2);
    expect(fake.statements[0]?.text).toBe(fake.statements[1]?.text);
  });

  it('lets a database failure surface, so pg-boss retries the job', async () => {
    const fake = createFakePool();
    fake.failNext(new Error('connection terminated'));

    await expect(createArchiveBackstopHandler({ pool: fake.pool, logger })()).rejects.toThrow(
      'connection terminated',
    );
  });
});
