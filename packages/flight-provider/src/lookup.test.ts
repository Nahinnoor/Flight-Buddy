import { describe, expect, it } from 'vitest';

import { ProviderDataError, ProviderRateLimitError } from './errors';
import { fixtureBody } from './fixtures';
import { createAeroDataBoxProvider } from './aerodatabox/client';
import { lookupCandidates } from './lookup';
import { createFeedHealthCache } from './trackingTier';

/**
 * A `fetch` that serves the captured fixtures by URL: flight lookups from the
 * named flights fixture, feed health from whichever airport was asked for.
 */
function fixtureFetch(flightsFixture: string, options: { status?: number } = {}) {
  const asked: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    asked.push(url);

    const feeds = /\/health\/services\/airports\/([A-Z0-9]{4})\/feeds/.exec(url);
    if (feeds !== null) {
      // KJFK is the live-coverage fixture; everything else uses the regional
      // one, which has live updates unavailable and ADS-B down.
      const fixture = feeds[1] === 'KJFK' ? 'health-feeds-KJFK' : 'health-feeds-PAWG';
      return new Response(fixtureBody(fixture), { status: 200 });
    }

    const status = options.status ?? 200;
    if (status === 204) return new Response(null, { status: 204 });
    return new Response(fixtureBody(flightsFixture), { status });
  };
  return { fetchImpl, asked };
}

function providerFor(flightsFixture: string, options: { status?: number } = {}) {
  const { fetchImpl, asked } = fixtureFetch(flightsFixture, options);
  return {
    provider: createAeroDataBoxProvider({ apiKey: 'test-key', fetch: fetchImpl }),
    asked,
  };
}

/** A fresh cache per test so one test's entries cannot serve another's. */
function freshCache() {
  return { feedHealthCache: createFeedHealthCache() };
}

describe('lookupCandidates', () => {
  it('returns every leg of a multi-leg number', async () => {
    const { provider } = providerFor('flights-number-multileg');

    const candidates = await lookupCandidates(
      provider,
      { flightNumber: 'AS 65', dateLocal: '2026-09-15' },
      freshCache(),
    );

    expect(candidates).toHaveLength(5);
    expect(candidates.map((leg) => leg.destinationIata)).toEqual([
      'KTN',
      'WRG',
      'PSG',
      'JNU',
      'ANC',
    ]);
  });

  it('assigns live tier only where both airports have live feeds', async () => {
    const { provider } = providerFor('flights-number-domestic-single');

    // KJFK → KLAX: the stub serves the regional fixture for KLAX, so this is
    // the mixed case — one live end is not enough (§7.3).
    const [jfkToLax] = await lookupCandidates(
      provider,
      { flightNumber: 'AA1', dateLocal: '2026-09-15' },
      freshCache(),
    );
    expect(jfkToLax?.trackingTier).toBe('scheduled');
  });

  it('assigns live tier when both ends are live', async () => {
    const { fetchImpl } = fixtureFetch('flights-number-domestic-single');
    const liveEverywhere: typeof globalThis.fetch = async (input, init) => {
      const url = String(input).replace(/airports\/[A-Z0-9]{4}\/feeds/, 'airports/KJFK/feeds');
      return fetchImpl(url, init);
    };
    const provider = createAeroDataBoxProvider({ apiKey: 'k', fetch: liveEverywhere });

    const [candidate] = await lookupCandidates(
      provider,
      { flightNumber: 'AA1', dateLocal: '2026-09-15' },
      freshCache(),
    );

    expect(candidate?.trackingTier).toBe('live');
  });

  it('checks each airport once however many legs share it', async () => {
    const { provider, asked } = providerFor('flights-number-multileg');

    await lookupCandidates(
      provider,
      { flightNumber: 'AS65', dateLocal: '2026-09-15' },
      freshCache(),
    );

    const feedRequests = asked.filter((url) => url.includes('/feeds'));
    // Six distinct airports across five legs: SEA KTN WRG PSG JNU ANC.
    expect(feedRequests).toHaveLength(6);
    expect(new Set(feedRequests).size).toBe(6);
  });

  it('returns an empty array when the provider has nothing', async () => {
    const { provider } = providerFor('flights-number-domestic-single', { status: 204 });

    await expect(
      lookupCandidates(provider, { flightNumber: 'DL8517', dateLocal: '2026-09-15' }, freshCache()),
    ).resolves.toEqual([]);
  });

  it.each([
    ['dl 1234', 'DL', '1234'],
    ['DL1234', 'DL', '1234'],
    ['DL 1234', 'DL', '1234'],
    ['b6 1411', 'B6', '1411'],
    ['9w123', '9W', '123'],
  ])('normalises %s before asking the provider', async (typed, carrier, number) => {
    const { provider, asked } = providerFor('flights-number-domestic-single');

    const [candidate] = await lookupCandidates(
      provider,
      { flightNumber: typed, dateLocal: '2026-09-15' },
      freshCache(),
    );

    expect(asked[0]).toContain(`/flights/number/${carrier}${number}/2026-09-15`);
    expect(candidate?.marketingCarrierIata).toBe(carrier);
    expect(candidate?.marketingFlightNumber).toBe(number);
  });

  it('rejects an unusable number or date', async () => {
    const { provider } = providerFor('flights-number-domestic-single');

    await expect(
      lookupCandidates(provider, { flightNumber: 'DELTA', dateLocal: '2026-09-15' }, freshCache()),
    ).rejects.toBeInstanceOf(ProviderDataError);
    await expect(
      lookupCandidates(provider, { flightNumber: 'DL1234', dateLocal: '12 Mar' }, freshCache()),
    ).rejects.toBeInstanceOf(ProviderDataError);
  });

  it('propagates a rate limit instead of swallowing it', async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response('{"message":"Too many requests"}', { status: 429 });
    const provider = createAeroDataBoxProvider({ apiKey: 'k', fetch: fetchImpl });

    await expect(
      lookupCandidates(provider, { flightNumber: 'AA1', dateLocal: '2026-09-15' }, freshCache()),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it('still returns candidates when feed health cannot be read', async () => {
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      if (String(input).includes('/feeds')) return new Response('boom', { status: 500 });
      return new Response(fixtureBody('flights-number-domestic-single'), { status: 200 });
    };
    const provider = createAeroDataBoxProvider({ apiKey: 'k', fetch: fetchImpl });

    const [candidate] = await lookupCandidates(
      provider,
      { flightNumber: 'AA1', dateLocal: '2026-09-15' },
      freshCache(),
    );

    expect(candidate?.originIata).toBe('JFK');
    expect(candidate?.trackingTier).toBe('scheduled');
  });
});

describe('feed health under a rate limit', () => {
  // The bug this covers: two health calls fired together right after the flight
  // call is a three-request burst; the 429 was swallowed, so every flight came
  // back `scheduled` and nothing ever subscribed to alerts — silently.
  const LIVE_REQUEST = { flightNumber: 'B6 1411', dateLocal: '2026-09-11' };

  /** Serves the live-coverage fixture for every airport, failing the first `failures` calls. */
  function healthProvider(failures: number) {
    let inFlight = 0;
    let concurrent = 0;
    let remaining = failures;
    const asked: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      const feeds = /\/health\/services\/airports\/([A-Z0-9]{4})\/feeds/.exec(url);
      if (feeds === null)
        return new Response(fixtureBody('flights-number-live-today'), { status: 200 });

      inFlight += 1;
      concurrent = Math.max(concurrent, inFlight);
      asked.push(feeds[1] as string);
      try {
        if (remaining > 0) {
          remaining -= 1;
          return new Response('{"message":"Too many requests"}', { status: 429 });
        }
        // KJFK's fixture is the one with live coverage on every feed.
        return new Response(fixtureBody('health-feeds-KJFK'), { status: 200 });
      } finally {
        inFlight -= 1;
      }
    };
    return {
      provider: createAeroDataBoxProvider({ apiKey: 'test-key', fetch: fetchImpl }),
      concurrent: () => concurrent,
      asked,
    };
  }

  it('asks one airport at a time, so the lookup cannot rate-limit itself', async () => {
    const h = healthProvider(0);

    await lookupCandidates(h.provider, LIVE_REQUEST, { ...freshCache(), retryDelayMs: 1 });

    expect(h.concurrent()).toBe(1);
  });

  it('retries once, so a busy limiter does not cost the live tier', async () => {
    const h = healthProvider(1);
    const degraded: string[] = [];

    const candidates = await lookupCandidates(h.provider, LIVE_REQUEST, {
      ...freshCache(),
      retryDelayMs: 1,
      onFeedHealthError: (icao) => degraded.push(icao),
    });

    expect(candidates[0]?.trackingTier).toBe('live');
    expect(degraded).toEqual([]);
  });

  it('names the airport when health stays unavailable, and degrades to scheduled', async () => {
    const h = healthProvider(99);
    const degraded: string[] = [];

    const candidates = await lookupCandidates(h.provider, LIVE_REQUEST, {
      ...freshCache(),
      retryDelayMs: 1,
      onFeedHealthError: (icao) => degraded.push(icao),
    });

    expect(candidates[0]?.trackingTier).toBe('scheduled');
    // The airports actually asked about, not just "something failed".
    expect(new Set(degraded)).toEqual(new Set(h.asked));
    expect(degraded.length).toBeGreaterThan(0);
  });
});
