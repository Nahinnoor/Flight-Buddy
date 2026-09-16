/**
 * One helper that builds the real app with every edge faked.
 *
 * Tests drive it through `app.inject()`, so they exercise routing, the CORS and
 * request-id hooks, the auth `preHandler` and the error handler — the whole
 * pipeline — without a socket, a network call or a database.
 */
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app';
import type { AuthUser, TokenVerifier } from '../auth';
import { parseConfig, type Config } from '../config';
import { UnauthorizedError } from '../errors';
import type { Client } from '../supabase';
import { FakeDatabase, type FakeCall } from './fakeSupabase';
import { fixtureProvider, type FixtureProviderOptions } from './fixtures';

/** The signed-in user every test acts as. */
export const TEST_USER: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
};

/** The only token the fake verifier accepts. */
export const TEST_TOKEN = 'valid-test-token';

export const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` } as const;

/** No real values: these are shaped like the real thing and mean nothing. */
export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return parseConfig({
    SUPABASE_URL: 'https://project-ref.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    RAPIDAPI_KEY: 'test-rapidapi-key',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

/** Accepts `TEST_TOKEN` and nothing else. Everything else is a 401. */
export function fakeVerifier(user: AuthUser = TEST_USER): TokenVerifier {
  return async (token: string): Promise<AuthUser> => {
    if (token !== TEST_TOKEN) {
      throw new UnauthorizedError('Your session is not valid. Sign in again.', {
        detail: 'fake verifier rejected the token',
      });
    }
    return user;
  };
}

export interface TestAppOptions {
  /** Fixture name served for flight lookups. */
  fixture?: string;
  /** Passed through to the fixture provider (status, Retry-After). */
  provider?: FixtureProviderOptions;
  /** Fixed clock, so "tomorrow" in a free-text query is deterministic. */
  now?: Date;
  user?: AuthUser;
  db?: FakeDatabase;
  /** Extra environment for `testConfig`, e.g. a generated `WEBHOOK_TOKEN`. */
  env?: Partial<NodeJS.ProcessEnv>;
  /** A moving clock. Wins over `now`; the webhook rate limiter reads it. */
  clock?: () => Date;
  /** Turn the logger on at `trace` and collect every line into `logs`. */
  captureLogs?: boolean;
}

export interface TestApp {
  app: FastifyInstance;
  db: FakeDatabase;
  /** Tables the *user-scoped* client touched. Must never include `flights`. */
  userCalls: FakeCall[];
  /**
   * Tables the service-role client touched. Only `flights` (via ingestFlight)
   * and `webhook_inbox` (the receiver's insert) belong here.
   */
  serviceCalls: FakeCall[];
  /** Log lines, when `captureLogs` was set. Empty otherwise. */
  logs: string[];
  /** Provider URLs asked for, in order. */
  asked: string[];
  userClient: Client;
}

export function buildTestApp(options: TestAppOptions = {}): TestApp {
  const db = options.db ?? new FakeDatabase();
  const user = options.user ?? TEST_USER;

  // One user client for the whole test, so its call log spans every request.
  const userSide = db.client();
  const serviceSide = db.client();
  const { provider, asked } = fixtureProvider(
    options.fixture ?? 'flights-number-domestic-single',
    options.provider ?? {},
  );

  const logs: string[] = [];
  const capture = options.captureLogs === true;

  const app = buildApp({
    config: testConfig({ ...(capture ? { LOG_LEVEL: 'trace' } : {}), ...options.env }),
    logger: capture,
    ...(capture ? { logStream: { write: (line: string) => void logs.push(line) } } : {}),
    provider,
    serviceClient: serviceSide.client,
    createUserClient: () => userSide.client,
    verifyToken: fakeVerifier(user),
    now: options.clock ?? (() => options.now ?? new Date('2026-09-12T00:00:00.000Z')),
  });

  return {
    app,
    logs,
    db,
    userCalls: userSide.calls,
    serviceCalls: serviceSide.calls,
    asked,
    userClient: userSide.client,
  };
}
