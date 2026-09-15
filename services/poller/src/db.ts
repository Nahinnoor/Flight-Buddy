/**
 * The worker's Postgres connection.
 *
 * Connects as `flightbuddy_worker` — a restricted role with table- and
 * column-level grants, no DELETE, and ownership of the `pgboss` schema
 * (PHASE2_PLAN §8.7, migration `20260915021807_worker_role`). The worker holds no
 * Supabase REST key, so this is its only route to the data.
 *
 * ## TLS
 *
 * Supabase's session pooler presents a chain rooted at Supabase's **own** CA
 * ("Supabase Root 2021 CA"), which is not in any public trust store. `pg` 8.23
 * treats `sslmode=require` as `verify-full`, so a plain `connectionString` fails
 * the handshake with `self-signed certificate in certificate chain` — and the two
 * usual "fixes" for that, `rejectUnauthorized: false` and
 * `uselibpqcompat=true&sslmode=require`, both mean *encrypted but unauthenticated*:
 * anything that can answer for the pooler's address gets the worker's password.
 *
 * So the CA is bundled instead, in `certs/`, and used as the only trust anchor.
 * That is `verify-full` against a pinned root: the certificate must chain to
 * Supabase's CA **and** match the hostname. The file is a public certificate, not
 * a secret — Supabase publishes it for download — and it is resolved relative to
 * this module, so it does not depend on the working directory Render happens to
 * use.
 *
 * `sslmode=disable` in the URL is honoured, for a local Postgres with no TLS.
 * Nothing here ever sets `rejectUnauthorized: false`.
 *
 * ## Not set here, on purpose
 *
 * **`statement_timeout`.** The role carries one (60 s). Setting it in the client
 * would let a code change quietly widen a limit the database is meant to own.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient, type PoolConfig } from 'pg';

import { type Config } from './config';

/**
 * Supabase's published root CA, verified against the certificate the pooler
 * actually presents (SHA-256 `80:70:25:AD:…:CA:FA`). Public; safe to commit.
 */
export const SUPABASE_ROOT_CA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../certs/supabase-prod-ca-2021.crt',
);

/**
 * The role is capped at 10 connections and one Render worker is the only thing
 * using it, but pg-boss opens its own pool on the same login — so this half is
 * five, leaving five for the queue.
 */
// The role allows 10 connections. Two pools (this one and pg-boss's) of 3 leave
// four spare for a redeploy overlap or a local integration run.
export const MAX_POOL_CONNECTIONS = 3;

/** Shows up in `pg_stat_activity`, which is how you tell the two pools apart. */
export const APPLICATION_NAME = 'flightbuddy-poller';

/** Everything both `pg` and pg-boss need, minus the pool sizing. */
export interface ConnectionSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: { ca: string; rejectUnauthorized: true } | false;
}

/**
 * Split `DATABASE_URL` into fields rather than handing the string to `pg`.
 *
 * `pg` lets a `connectionString` overwrite an explicit `ssl` option, so passing
 * both is the one arrangement in which the pinned CA silently does nothing.
 */
export function connectionSettings(config: Config): ConnectionSettings {
  const url = new URL(config.DATABASE_URL);
  const sslmode = url.searchParams.get('sslmode') ?? 'require';

  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    // The URL form percent-encodes both, so both come back decoded.
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    ssl:
      sslmode === 'disable'
        ? false
        : { ca: readFileSync(SUPABASE_ROOT_CA_PATH, 'utf8'), rejectUnauthorized: true },
  };
}

export function poolConfig(config: Config): PoolConfig {
  return {
    ...connectionSettings(config),
    application_name: APPLICATION_NAME,
    max: MAX_POOL_CONNECTIONS,
    // A pooler that is up but saturated should fail the pass, not wedge it.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  };
}

export function createPool(config: Config): Pool {
  return new Pool(poolConfig(config));
}

/**
 * Run `fn` with a pooled client and always give it back.
 *
 * `pg` leaks a connection for good if `release()` is skipped on a throw, and with
 * `max: 5` that is five bad passes from a worker that can no longer talk to the
 * database at all.
 */
export async function withClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Round-trip to the database. Throws if the pool cannot serve a query. */
export async function ping(pool: Pool): Promise<void> {
  await withClient(pool, async (client) => {
    await client.query('select 1');
  });
}

export type { Pool, PoolClient };
