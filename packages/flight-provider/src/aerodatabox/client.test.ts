import { describe, expect, it } from 'vitest';

import { ProviderDataError, ProviderError, ProviderRateLimitError } from '../errors';
import { fixtureBody } from '../fixtures';
import { createAeroDataBoxProvider } from './client';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface StubResponse {
  status?: number;
  body?: string | null;
  headers?: Record<string, string>;
}

/**
 * A `fetch` that answers with canned responses and records what it was asked,
 * so the tests can assert the request as well as the parsing.
 */
function stubFetch(responses: StubResponse | StubResponse[]) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const requests: RecordedRequest[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key] = String(value);
    }
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });

    const next = queue.length > 1 ? queue.shift() : queue[0];
    const status = next?.status ?? 200;
    const body = next?.body ?? null;
    return new Response(status === 204 ? null : body, {
      status,
      headers: next?.headers ?? {},
    });
  };

  return { fetchImpl, requests };
}

function providerWith(responses: StubResponse | StubResponse[]) {
  const { fetchImpl, requests } = stubFetch(responses);
  const provider = createAeroDataBoxProvider({ apiKey: 'test-key', fetch: fetchImpl });
  return { provider, requests };
}

describe('createAeroDataBoxProvider', () => {
  it('requires a key', () => {
    expect(() => createAeroDataBoxProvider({ apiKey: '  ' })).toThrow(ProviderError);
  });
});

describe('lookupFlight', () => {
  it('asks for the departure-date role and the normalised number', async () => {
    const { provider, requests } = providerWith({
      body: fixtureBody('flights-number-domestic-single'),
    });

    await provider.lookupFlight('aa 1', '2026-09-15');

    const [request] = requests;
    expect(request?.url).toBe(
      'https://aerodatabox.p.rapidapi.com/flights/number/AA1/2026-09-15' +
        '?dateLocalRole=Departure&withAircraftImage=false&withLocation=false',
    );
    expect(request?.headers['X-RapidAPI-Host']).toBe('aerodatabox.p.rapidapi.com');
    expect(request?.headers['X-RapidAPI-Key']).toBe('test-key');
  });

  it('returns every leg, never just the first (§8.12)', async () => {
    const { provider } = providerWith({ body: fixtureBody('flights-number-multileg') });

    const candidates = await provider.lookupFlight('AS65', '2026-09-15');

    expect(candidates).toHaveLength(5);
    expect(candidates.map((leg) => leg.originIata)).toEqual(['SEA', 'KTN', 'WRG', 'PSG', 'JNU']);
  });

  it('returns an empty array for a flight the provider does not have', async () => {
    // Captured: DL8517 on 2026-09-15 answers 204 with an empty body.
    const { provider } = providerWith({ status: 204 });
    await expect(provider.lookupFlight('DL8517', '2026-09-15')).resolves.toEqual([]);

    const notFound = providerWith({ status: 404, body: '' });
    await expect(notFound.provider.lookupFlight('ZZ9999', '2026-09-15')).resolves.toEqual([]);
  });

  it('raises a rate-limit error on 429, with Retry-After when supplied', async () => {
    const { provider } = providerWith({
      status: 429,
      body: '{"message":"Too many requests"}',
      headers: { 'Retry-After': '30' },
    });

    const error = await provider.lookupFlight('AA1', '2026-09-15').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect((error as ProviderRateLimitError).status).toBe(429);
    expect((error as ProviderRateLimitError).retryAfterSeconds).toBe(30);
  });

  it('raises a provider error carrying the status on any other failure', async () => {
    const { provider } = providerWith({ status: 503, body: 'Service Unavailable' });

    const error = await provider.lookupFlight('AA1', '2026-09-15').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(503);
  });

  it('rejects a bad number or date before spending quota', async () => {
    const { provider, requests } = providerWith({ body: '[]' });

    await expect(provider.lookupFlight('flight one', '2026-09-15')).rejects.toBeInstanceOf(
      ProviderDataError,
    );
    await expect(provider.lookupFlight('AA1', '15/09/2026')).rejects.toBeInstanceOf(
      ProviderDataError,
    );
    expect(requests).toHaveLength(0);
  });

  it('rejects a body that is not the expected shape', async () => {
    const { provider } = providerWith({ body: '{"message":"nope"}' });
    await expect(provider.lookupFlight('AA1', '2026-09-15')).rejects.toBeInstanceOf(
      ProviderDataError,
    );
  });

  it('drops a leg it cannot key rather than failing the whole lookup', async () => {
    const withBadLeg = JSON.stringify([
      ...(JSON.parse(fixtureBody('flights-number-domestic-single')) as unknown[]),
      { number: 'AA 1', departure: { airport: { name: 'Nowhere' } }, arrival: {} },
    ]);
    const { provider } = providerWith({ body: withBadLeg });

    await expect(provider.lookupFlight('AA1', '2026-09-15')).resolves.toHaveLength(1);
  });
});

describe('getAirportFeedHealth', () => {
  it('reports live coverage at a major hub', async () => {
    const { provider, requests } = providerWith({ body: fixtureBody('health-feeds-KJFK') });

    const health = await provider.getAirportFeedHealth('kjfk');

    expect(requests[0]?.url).toBe(
      'https://aerodatabox.p.rapidapi.com/health/services/airports/KJFK/feeds',
    );
    expect(health).toMatchObject({
      icao: 'KJFK',
      schedules: 'OK',
      liveUpdates: 'OK',
      adsb: 'OKPartial',
      hasLiveCoverage: true,
      hasAnyCoverage: true,
      minAvailableLocalDate: '2025-09-09',
      maxAvailableLocalDate: '2027-09-06',
    });
  });

  it('reports schedules-only coverage at a regional airport', async () => {
    const { provider } = providerWith({ body: fixtureBody('health-feeds-PAWG') });

    const health = await provider.getAirportFeedHealth('PAWG');

    expect(health).toMatchObject({
      schedules: 'OK',
      liveUpdates: 'Unavailable',
      adsb: 'Down',
      hasLiveCoverage: false,
      hasAnyCoverage: true,
    });
  });

  it('reports no coverage rather than failing for an unknown airport', async () => {
    const { provider } = providerWith({ status: 204 });

    const health = await provider.getAirportFeedHealth('ZZZZ');

    expect(health.hasAnyCoverage).toBe(false);
    expect(health.hasLiveCoverage).toBe(false);
    expect(health.schedules).toBe('Unknown');
  });

  it('rejects anything that is not an ICAO code', async () => {
    const { provider } = providerWith({ body: '{}' });
    await expect(provider.getAirportFeedHealth('JFK')).rejects.toBeInstanceOf(ProviderDataError);
  });
});

describe('alert and credit wrappers', () => {
  it('creates a webhook subscription keyed by number, with retries', async () => {
    const { provider, requests } = providerWith({
      body: '{"id":"8a1f0c22-1111-4b7a-9d55-2e2b7e4a9c01","isActive":true}',
    });

    const result = await provider.subscribeAlerts('kl 1405', 'https://example.com/hooks/adb');

    expect(result.subscriptionId).toBe('8a1f0c22-1111-4b7a-9d55-2e2b7e4a9c01');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toContain('/subscriptions/webhook/FlightByNumber/KL1405');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      url: 'https://example.com/hooks/adb',
      maxDeliveryRetries: 2,
    });
  });

  it('treats an already-removed subscription as removed', async () => {
    const { provider, requests } = providerWith({ status: 404, body: '' });

    await expect(provider.unsubscribeAlerts('abc-123')).resolves.toBeUndefined();
    expect(requests[0]?.method).toBe('DELETE');
  });

  it('reads the credit balance', async () => {
    const { provider } = providerWith({
      body: '{"creditsRemaining":4200,"lastRefilledUtc":"2026-09-01 00:00Z","lastDeductedUtc":"2026-09-11 12:00Z"}',
    });
    await expect(provider.getCreditBalance()).resolves.toBe(4200);
  });

  it('reads an empty balance response as zero credits', async () => {
    // Observed on the dev plan: HTTP 200 with no body at all (§7.7 fail-safe).
    const { provider } = providerWith({ status: 200, body: '' });
    await expect(provider.getCreditBalance()).resolves.toBe(0);
  });

  it('refills and returns the new balance', async () => {
    const { provider, requests } = providerWith({ body: '{"creditsRemaining":600}' });

    await expect(provider.refillCredits(600)).resolves.toBe(600);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ credits: 600 });
    await expect(provider.refillCredits(0)).rejects.toBeInstanceOf(ProviderDataError);
  });
});
