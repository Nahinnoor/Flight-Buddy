/**
 * Test support: the one database a `*.integration.test.ts` may touch — the
 * throwaway cluster `supabase/tests/run-local.sh --exec` builds, migrates and
 * deletes.
 *
 * Never the dev or prod project. The deployed worker reads the same database, so
 * every claimable row a test writes there is one it claims too: on 2026-10-29 the
 * live worker claimed six synthetic `ZZ` flights from the lease test within
 * seconds and spent provider units polling each, and the test's "two concurrent
 * claimers" assertion failed because a third was present. So nothing here reads
 * `DATABASE_URL` or `.env`, and `connectThrowawayDb` refuses to open anything
 * unless all of these hold:
 *
 * - `INTEGRATION_THROWAWAY=1`, which only `run-local.sh --exec` sets;
 * - `INTEGRATION_PGHOST` is a local Unix socket or loopback;
 * - `auth.users` is empty (a fresh cluster, not a real project reached through a
 *   tunnel or a local dev database).
 *
 * The integration files share one cluster per run and each checks `auth.users`
 * before it seeds, so `vitest.config.ts` runs them one at a time when
 * `INTEGRATION=1`, and a file that seeds users deletes them before it ends.
 *
 * Not exported from anywhere: this is for tests.
 */
import pg from 'pg';

import type { Pool } from './db';

/** `INTEGRATION=1` asks for the integration files; without it they skip. */
export const integrationRequested = process.env.INTEGRATION === '1';

const RUN_WITH = 'npm run test:integration -w @flightbuddy/poller';

const isLocal = (host: string) =>
  host.startsWith('/') || host === 'localhost' || host === '127.0.0.1' || host === '::1';

/** Superuser `postgres` on the cluster, acting as `flightbuddy_worker` (§10). */
export interface WorkerConnection {
  host: string;
  port: number;
  user: 'postgres';
  database: 'postgres';
  options: string;
}

export interface ThrowawayDb {
  /** Superuser `postgres`: seeds what the worker role may not write. */
  admin: pg.Pool;
  /** `flightbuddy_worker`, with exactly the grants the deployed worker has. */
  worker: Pool;
  /** The worker pool's fields, for a client this module does not build (pg-boss). */
  workerConnection: WorkerConnection;
  end(): Promise<void>;
}

/**
 * Open the throwaway cluster, or throw before connecting to anything else.
 *
 * The role comes from the migrations (`20260915021807_worker_role`, NOLOGIN);
 * the superuser takes it with `-c role=`, so every query runs under its grants.
 */
export async function connectThrowawayDb(): Promise<ThrowawayDb> {
  if (process.env.INTEGRATION_THROWAWAY !== '1') {
    throw new Error(
      `INTEGRATION_THROWAWAY=1 missing: integration tests run only on the throwaway cluster; refusing. Run: ${RUN_WITH}`,
    );
  }
  const host = process.env.INTEGRATION_PGHOST;
  if (host === undefined || !isLocal(host)) {
    throw new Error(
      'INTEGRATION_PGHOST must be a local socket or loopback (throwaway cluster only); refusing',
    );
  }

  // `pg` reads a NaN port as "the default", which could be some other local server.
  const port = Number(process.env.INTEGRATION_PGPORT ?? 5432);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('INTEGRATION_PGPORT must be a port number; refusing');
  }

  const base = { host, port, user: 'postgres' as const, database: 'postgres' as const };
  const workerConnection: WorkerConnection = { ...base, options: '-c role=flightbuddy_worker' };
  const admin = new pg.Pool(base);
  const worker = new pg.Pool(workerConnection) as Pool;
  // An idle client's error (the cluster stopped mid-run) is an 'error' event; with
  // no listener it crashes the run. The next query on the pool fails loudly anyway.
  admin.on('error', () => {});
  worker.on('error', () => {});
  const end = async () => {
    await admin.end();
    await worker.end();
  };

  try {
    const [{ who } = { who: '' }] = (
      await worker.query<{ who: string }>('select current_user as who')
    ).rows;
    if (who !== 'flightbuddy_worker') {
      throw new Error('the worker pool is not running as flightbuddy_worker; refusing');
    }
    const [{ users } = { users: -1 }] = (
      await admin.query<{ users: number }>('select count(*)::int as users from auth.users')
    ).rows;
    if (users !== 0) {
      throw new Error('auth.users is not empty: this is not a fresh throwaway cluster; refusing');
    }
  } catch (error) {
    await end();
    throw error;
  }

  return { admin, worker, workerConnection, end };
}
