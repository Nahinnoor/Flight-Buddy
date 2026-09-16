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

/**
 * An obviously fake receiver URL. The token segment is what must never escape the
 * provider package: not in an error message, an error body, a cause, or a return.
 */
const FAKE_TOKEN = 'FAKE-TEST-TOKEN-not-a-secret-0000';
const FAKE_WEBHOOK_URL = `https://api.example.invalid/webhooks/aerodatabox/${FAKE_TOKEN}`;
const SUB_ID = '8a1f0c22-1111-4b7a-9d55-2e2b7e4a9c01';

/** A `SubscriptionContract` as documented, including the subscriber block we never read. */
function subscriptionContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SUB_ID,
    isActive: true,
    billingType: 'CreditBased',
    createdOnUtc: '2026-09-11 19:00Z',
    expiresOnUtc: null,
    subject: { type: 'FlightByNumber', id: 'KL 1405' },
    subscriber: { type: 'WebHook', id: FAKE_WEBHOOK_URL },
    ...overrides,
  };
}

/** Everything about an error that could reach a log line. */
function everythingIn(error: unknown): string {
  const e = error as Error & { body?: unknown; cause?: unknown };
  return [
    e.message,
    String(e.body),
    String(e.cause),
    JSON.stringify(e, Object.getOwnPropertyNames(e)),
  ].join('\n');
}

describe('subscribeAlerts', () => {
  it('POSTs to FlightByNumber with the url and ONE retry by default (ADR 0003)', async () => {
    const { provider, requests } = providerWith({ body: JSON.stringify(subscriptionContract()) });

    const result = await provider.subscribeAlerts('kl 1405', FAKE_WEBHOOK_URL);

    expect(result.subscriptionId).toBe(SUB_ID);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(
      'https://aerodatabox.p.rapidapi.com/subscriptions/webhook/FlightByNumber/KL1405',
    );
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      url: FAKE_WEBHOOK_URL,
      maxDeliveryRetries: 1,
    });
  });

  it('sends no useCredits parameter: the current spec has none', async () => {
    const { provider, requests } = providerWith({ body: JSON.stringify(subscriptionContract()) });
    await provider.subscribeAlerts('KL1405', FAKE_WEBHOOK_URL);
    expect(requests[0]?.url).not.toContain('?');
    expect(requests[0]?.url).not.toContain('useCredits');
  });

  it('honours an explicit retry count inside 0–2 and refuses anything else', async () => {
    const { provider, requests } = providerWith({ body: JSON.stringify(subscriptionContract()) });

    await provider.subscribeAlerts('KL1405', FAKE_WEBHOOK_URL, { maxDeliveryRetries: 0 });
    await provider.subscribeAlerts('KL1405', FAKE_WEBHOOK_URL, { maxDeliveryRetries: 2 });
    expect(requests.map((r) => JSON.parse(r.body ?? '{}').maxDeliveryRetries)).toEqual([0, 2]);

    for (const bad of [3, -1, 1.5]) {
      await expect(
        provider.subscribeAlerts('KL1405', FAKE_WEBHOOK_URL, { maxDeliveryRetries: bad }),
      ).rejects.toBeInstanceOf(ProviderDataError);
    }
    expect(requests).toHaveLength(2);
  });

  it('refuses a non-http(s) URL without calling the provider or quoting it', async () => {
    const { provider, requests } = providerWith({ body: '{}' });
    const bad = `ftp://example.invalid/${FAKE_TOKEN}`;

    const error = await provider.subscribeAlerts('KL1405', bad).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderDataError);
    expect(everythingIn(error)).not.toContain(FAKE_TOKEN);
    expect(requests).toHaveLength(0);
  });

  it('lower-cases the returned id so it compares equal to a Postgres uuid', async () => {
    const { provider } = providerWith({
      body: JSON.stringify(subscriptionContract({ id: SUB_ID.toUpperCase() })),
    });
    const result = await provider.subscribeAlerts('KL1405', FAKE_WEBHOOK_URL);
    expect(result.subscriptionId).toBe(SUB_ID);
  });

  it('parses the response strictly: a missing or mistyped required field is an error', async () => {
    for (const broken of [
      subscriptionContract({ id: 'not-a-guid' }),
      subscriptionContract({ isActive: 'yes' }),
      { ...subscriptionContract(), subject: undefined },
      { ...subscriptionContract(), createdOnUtc: undefined },
    ]) {
      const { provider } = providerWith({ body: JSON.stringify(broken) });
      await expect(provider.subscribeAlerts('KL1405', FAKE_WEBHOOK_URL)).rejects.toBeInstanceOf(
        ProviderDataError,
      );
    }
  });

  describe('never leaks the webhook URL or its token', () => {
    const echo = JSON.stringify({ message: `url ${FAKE_WEBHOOK_URL} is not reachable` });
    const cases: [string, StubResponse][] = [
      ['a 400 that echoes the url', { status: 400, body: echo }],
      ['a 500 that echoes the url', { status: 500, body: echo }],
      ['a 429 that echoes the url', { status: 429, body: echo }],
      ['unparseable JSON containing the url', { status: 200, body: `{${FAKE_WEBHOOK_URL}` }],
      [
        'a wrong shape that still carries the subscriber block',
        { status: 200, body: JSON.stringify(subscriptionContract({ isActive: null })) },
      ],
    ];

    for (const [label, response] of cases) {
      it(`on ${label}`, async () => {
        const { provider } = providerWith(response);
        const error = await provider
          .subscribeAlerts('KL1405', FAKE_WEBHOOK_URL)
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ProviderError);
        expect(everythingIn(error)).not.toContain(FAKE_TOKEN);
        expect((error as ProviderError).body).toBeUndefined();
      });
    }

    it('on a network failure', async () => {
      const provider = createAeroDataBoxProvider({
        apiKey: 'test-key',
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      });
      const error = await provider
        .subscribeAlerts('KL1405', FAKE_WEBHOOK_URL)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect(everythingIn(error)).not.toContain(FAKE_TOKEN);
    });

    it('on success: the subscriber block is not in the result', async () => {
      const { provider } = providerWith({ body: JSON.stringify(subscriptionContract()) });
      const result = await provider.subscribeAlerts('KL1405', FAKE_WEBHOOK_URL);
      expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    });
  });
});

describe('unsubscribeAlerts', () => {
  it('DELETEs /subscriptions/webhook/{id}', async () => {
    const { provider, requests } = providerWith({ status: 200, body: '' });

    await expect(provider.unsubscribeAlerts(SUB_ID)).resolves.toBeUndefined();
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url).toBe(
      `https://aerodatabox.p.rapidapi.com/subscriptions/webhook/${SUB_ID}`,
    );
  });

  it('treats an already-removed subscription (404) as removed', async () => {
    const { provider, requests } = providerWith({ status: 404, body: '' });

    await expect(provider.unsubscribeAlerts(SUB_ID)).resolves.toBeUndefined();
    expect(requests[0]?.method).toBe('DELETE');
  });

  it('throws on any other failure, without the body', async () => {
    const { provider } = providerWith({
      status: 500,
      body: JSON.stringify({ subscriber: FAKE_WEBHOOK_URL }),
    });
    const error = await provider.unsubscribeAlerts(SUB_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(everythingIn(error)).not.toContain(FAKE_TOKEN);
  });

  it('refuses a non-GUID id before calling the provider', async () => {
    const { provider, requests } = providerWith({ status: 200, body: '' });
    for (const bad of ['abc-123', '../balance', '']) {
      await expect(provider.unsubscribeAlerts(bad)).rejects.toBeInstanceOf(ProviderDataError);
    }
    expect(requests).toHaveLength(0);
  });
});

describe('listSubscriptions', () => {
  it('reads 204 with an empty body as no subscriptions (observed 2026-09-14)', async () => {
    const { provider, requests } = providerWith({ status: 204 });

    await expect(provider.listSubscriptions()).resolves.toEqual([]);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe('https://aerodatabox.p.rapidapi.com/subscriptions/webhook');
  });

  it('reads a 200 with an empty body as no subscriptions', async () => {
    const { provider } = providerWith({ status: 200, body: '' });
    await expect(provider.listSubscriptions()).resolves.toEqual([]);
  });

  it('maps each subscription to ids and state, and drops the subscriber URL', async () => {
    const second = '0b9e7a44-2222-4c3d-8e66-3f3c8f5b0d12';
    const { provider } = providerWith({
      body: JSON.stringify([
        subscriptionContract(),
        subscriptionContract({
          id: second.toUpperCase(),
          isActive: false,
          subject: { type: 'FlightByNumber', id: 'B6 1411' },
        }),
      ]),
    });

    const list = await provider.listSubscriptions();

    expect(list).toEqual([
      {
        subscriptionId: SUB_ID,
        isActive: true,
        createdAtUtc: '2026-09-11T19:00:00.000Z',
        flightNumber: 'KL 1405',
      },
      {
        subscriptionId: second,
        isActive: false,
        createdAtUtc: '2026-09-11T19:00:00.000Z',
        flightNumber: 'B6 1411',
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(FAKE_TOKEN);
  });

  it('fails the whole list when one element is malformed (reconcile acts on absences)', async () => {
    const { provider } = providerWith({
      body: JSON.stringify([subscriptionContract(), subscriptionContract({ id: 7 })]),
    });
    const error = await provider.listSubscriptions().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderDataError);
    expect(everythingIn(error)).not.toContain(FAKE_TOKEN);
  });

  it('throws on a failed response without keeping its body', async () => {
    const { provider } = providerWith({
      status: 502,
      body: JSON.stringify([subscriptionContract()]),
    });
    const error = await provider.listSubscriptions().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).body).toBeUndefined();
    expect(everythingIn(error)).not.toContain(FAKE_TOKEN);
  });
});

describe('credit wrappers', () => {
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

describe('empty body on a failed response is a failure, not "no data"', () => {
  // Review fix: a gateway 502/503/504 often arrives with an empty body. That
  // must surface as ProviderError, never as "flight not found", "no coverage"
  // (which the feed cache would keep for 24 h) or "0 credits" (§7.7).
  for (const status of [502, 503, 504]) {
    it(`lookupFlight throws on ${status} with an empty body`, async () => {
      const { provider } = providerWith({ status, body: '' });
      const error = await provider.lookupFlight('AA1', '2026-09-15').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(status);
    });

    it(`getAirportFeedHealth throws on ${status} with an empty body`, async () => {
      const { provider } = providerWith({ status, body: '' });
      await expect(provider.getAirportFeedHealth('KJFK')).rejects.toBeInstanceOf(ProviderError);
    });

    it(`getCreditBalance throws on ${status} with an empty body`, async () => {
      const { provider } = providerWith({ status, body: '' });
      await expect(provider.getCreditBalance()).rejects.toBeInstanceOf(ProviderError);
    });
  }

  it('rejects a calendar-invalid date before spending quota', async () => {
    const { provider, requests } = providerWith({ body: '[]' });
    for (const bad of ['2026-02-30', '2026-13-01', '2026-04-31']) {
      await expect(provider.lookupFlight('AA1', bad)).rejects.toBeInstanceOf(ProviderDataError);
    }
    expect(requests).toHaveLength(0);
  });
});
