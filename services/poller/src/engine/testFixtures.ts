/**
 * Test support: real AeroDataBox bodies from `docs/api-samples/`, served to a real
 * provider instance through an injected `fetch`.
 *
 * §12.1 rations live provider calls to 20 per agent and §12.2 says to build against
 * the captured responses thereafter, so **no test in this workspace touches the
 * network**. Going through `createAeroDataBoxProvider` rather than hand-writing
 * `FlightCandidate` literals means the engine is tested against the shapes the
 * provider actually produces — including the codeshare resolution and the tier
 * assignment that happen on the way.
 *
 * Not exported from `src/index.ts`: this is for tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAeroDataBoxProvider,
  createFeedHealthCache,
  lookupCandidates,
  type FlightDataProvider,
} from '@flightbuddy/flight-provider';
import type { FlightCandidate } from '@flightbuddy/shared';

/** `services/poller/src/engine` → repo root → `docs/api-samples`. */
const SAMPLES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/api-samples',
);

export function fixtureBody(name: string): string {
  return readFileSync(resolve(SAMPLES_DIR, `${name}.json`), 'utf8');
}

export interface FixtureProviderOptions {
  /** Force a status on the flights endpoint, to exercise the failure paths. */
  flightsStatus?: number;
  /** Throw from `fetch` instead of answering, to exercise the network-failure path. */
  failWith?: Error;
  /**
   * Edit the captured body before serving it, for states no capture happens to
   * contain — a landed flight, a diversion. Still the real shape, with one field
   * moved: hand-writing a body instead would test the test's idea of the provider.
   */
  mutate?: (legs: Record<string, unknown>[]) => Record<string, unknown>[];
}

/**
 * A provider whose flight lookups come from `<flightsFixture>.json` and whose feed
 * health comes from the two captured airport fixtures (KJFK is the live one).
 *
 * `asked` records every URL, which is how the tests assert the poller made exactly
 * one provider call per flight.
 */
export function fixtureProvider(flightsFixture: string, options: FixtureProviderOptions = {}) {
  const asked: string[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    asked.push(url);

    const feeds = /\/health\/services\/airports\/([A-Z0-9]{4})\/feeds/.exec(url);
    if (feeds !== null) {
      const fixture = feeds[1] === 'KJFK' ? 'health-feeds-KJFK' : 'health-feeds-PAWG';
      return new Response(fixtureBody(fixture), { status: 200 });
    }

    if (options.failWith !== undefined) throw options.failWith;

    const status = options.flightsStatus ?? 200;
    if (status === 204) return new Response(null, { status: 204 });

    const body = fixtureBody(flightsFixture);
    if (options.mutate === undefined) return new Response(body, { status });

    const legs = JSON.parse(body) as Record<string, unknown>[];
    return new Response(JSON.stringify(options.mutate(legs)), { status });
  };

  const provider: FlightDataProvider = createAeroDataBoxProvider({
    apiKey: 'test-key',
    fetch: fetchImpl,
  });

  return { provider, asked };
}

/** Every leg of a fixture, as the poller would see it (tier assigned, codeshare resolved). */
export async function fixtureCandidates(
  flightsFixture: string,
  request: { flightNumber: string; dateLocal: string },
): Promise<FlightCandidate[]> {
  const { provider } = fixtureProvider(flightsFixture);
  return lookupCandidates(provider, request, { feedHealthCache: createFeedHealthCache() });
}
