/**
 * What `buildApp` needs, as data.
 *
 * Every outside edge of this service — the flight data provider, the two
 * Supabase clients, JWT verification and the clock — arrives here rather than
 * being constructed inside a route. That is what makes the whole app testable
 * with `app.inject()` and no network: the tests build the same app the server
 * builds and swap the edges for fakes fed from `docs/api-samples/` (§12.2).
 */
import type { FlightDataProvider } from '@flightbuddy/flight-provider';

import type { TokenVerifier } from './auth';
import type { Config } from './config';
import type { Client, UserClientFactory } from './supabase';

export interface AppDeps {
  config: Config;
  /** AeroDataBox in production; a fixture-backed fake in tests. */
  provider: FlightDataProvider;
  /** Service-role. Handed to `ingestFlight` and to nothing else (§12.7). */
  serviceClient: Client;
  /** Builds the per-request, RLS-scoped client from the caller's token. */
  createUserClient: UserClientFactory;
  verifyToken: TokenVerifier;
  /** Injected so "tomorrow" in a free-text query is deterministic in tests. */
  now: () => Date;
}
