/**
 * The two Supabase clients this API uses, and the line between them (§10).
 *
 * **User-scoped (anon key + the caller's bearer token).** Everything a user
 * owns — `profiles`, `travelers`, `trips`, `trip_segments` — is read and
 * written through this one, so RLS is the thing that decides what the request
 * may touch, not a hand-written `where` clause a future edit could drop. It is
 * built per request because the token is per request.
 *
 * **Service-role (bypasses RLS).** Exactly two callers: `ingestFlight`, the
 * only writer of `flights` (ADR 0001, §12.7), and the webhook receiver's single
 * insert into `webhook_inbox` (`routes/webhooks.ts`; that table has RLS on and
 * no policies, so no other key can write it). It is a process singleton
 * because creating a client per request would leak sockets for no benefit.
 *
 * Neither key is ever logged. `createClient` keeps them inside the returned
 * client and nothing here stringifies it.
 */
import type { Database } from '@flightbuddy/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Config } from './config';

export type Client = SupabaseClient<Database>;

/** Builds a user-scoped client from one access token. */
export type UserClientFactory = (accessToken: string) => Client;

/**
 * No session handling at all: this is a stateless server, the token arrives on
 * every request, and a client that tried to persist or refresh a session would
 * be writing to a storage layer that does not exist here.
 */
const STATELESS_AUTH = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

/**
 * A client that acts *as the caller*: anon key for the API contract, the
 * caller's own JWT for identity, so every statement runs under RLS with
 * `auth.uid()` set to them.
 */
export function createUserClientFactory(config: Config): UserClientFactory {
  return (accessToken: string): Client =>
    createClient<Database>(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: STATELESS_AUTH,
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
}

/**
 * A client that bypasses RLS. Hand it only to `ingestFlight` and the webhook
 * inbox insert; anything else that needs it should be questioned first (§12.7).
 */
export function createServiceClient(config: Config): Client {
  return createClient<Database>(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: STATELESS_AUTH,
  });
}

// ------------------------------------------------------------ error shapes ---

/** The subset of PostgREST's error object this API reacts to. */
export interface PostgrestErrorLike {
  message: string;
  code?: string | undefined;
  details?: string | undefined;
  hint?: string | undefined;
}

/** `unique_violation`. Both "ensure" paths below race on this and recover. */
export const UNIQUE_VIOLATION = '23505';

/** True when Postgres refused a write because the row already exists. */
export function isUniqueViolation(error: PostgrestErrorLike | null): boolean {
  return error !== null && error.code === UNIQUE_VIOLATION;
}
