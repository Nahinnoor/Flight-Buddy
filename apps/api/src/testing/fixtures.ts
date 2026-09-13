/**
 * Test support: a provider built on the captured AeroDataBox responses in
 * `docs/api-samples/`.
 *
 * §12.1 rations real provider calls to 20 per agent and §12.2 says to build
 * against the saved responses thereafter, so no test in this package touches
 * the network. The fake is the *real* `createAeroDataBoxProvider` with an
 * injected `fetch`, not a hand-written stub: that way these tests exercise the
 * same parsing, codeshare resolution and tracking-tier logic the server runs,
 * and a change in the provider package shows up here instead of passing
 * silently against a stub that agreed with the old shape.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAeroDataBoxProvider,
  type FlightDataProvider,
} from '@flightbuddy/flight-provider';

const SAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/api-samples');

/** The raw body of a captured response, exactly as the provider sent it. */
export function fixtureBody(name: string): string {
  return readFileSync(resolve(SAMPLES_DIR, `${name}.json`), 'utf8');
}

export interface FixtureProviderOptions {
  /** Status to answer flight lookups with. 200 unless a test wants a failure. */
  status?: number;
  /** `Retry-After`, for the 429 path. */
  retryAfterSeconds?: number;
}

export interface FixtureProvider {
  provider: FlightDataProvider;
  /** Every URL the provider asked for, in order. */
  asked: string[];
}

/**
 * A provider that serves `<flightsFixture>.json` for flight lookups and the
 * captured feed-health responses for airport health.
 */
export function fixtureProvider(
  flightsFixture: string,
  options: FixtureProviderOptions = {},
): FixtureProvider {
  const asked: string[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    asked.push(url);

    const feeds = /\/health\/services\/airports\/([A-Z0-9]{4})\/feeds/.exec(url);
    if (feeds !== null) {
      // KJFK is the live-coverage capture; everything else gets the regional
      // one, whose live feed is unavailable and ADS-B down.
      const fixture = feeds[1] === 'KJFK' ? 'health-feeds-KJFK' : 'health-feeds-PAWG';
      return new Response(fixtureBody(fixture), { status: 200 });
    }

    const status = options.status ?? 200;
    if (status === 204) return new Response(null, { status: 204 });
    if (status === 429) {
      const headers =
        options.retryAfterSeconds === undefined
          ? undefined
          : { 'Retry-After': String(options.retryAfterSeconds) };
      return new Response('{"message":"Too many requests"}', { status, ...(headers ? { headers } : {}) });
    }
    return new Response(fixtureBody(flightsFixture), { status });
  };

  return {
    provider: createAeroDataBoxProvider({ apiKey: 'test-key', fetch: fetchImpl }),
    asked,
  };
}
