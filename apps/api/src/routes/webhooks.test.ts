/**
 * The AeroDataBox receiver (ADR 0003). Every rejection path is asserted to
 * write nothing; the log tests assert the token, the path and the payload never
 * reach a log line. Tokens are generated per run — nothing here is a real
 * secret.
 */
import { createHash, randomBytes } from 'node:crypto';

import { apiErrorSchema } from '@flightbuddy/shared';
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../config';
import { REDACTED_WEBHOOK_URL } from '../logging';
import { touchedFlights } from '../testing/fakeSupabase';
import { buildTestApp, testConfig, type TestAppOptions } from '../testing/app';
import {
  MAX_LOGGED_ISSUES,
  MAX_LOGGED_KEYS,
  REDACTED_SUBSCRIBER,
  JSON_TYPE_NAMES,
  WEBHOOK_BODY_LIMIT_BYTES,
  WEBHOOK_MAX_FLIGHTS,
  WEBHOOK_RATE_LIMIT,
  describeRejection,
  issuePath,
  jsonTypeOf,
  safeKey,
  tokenMatches,
} from './webhooks';

/** 43 URL-safe characters, fresh each call. */
function fakeToken(): string {
  return randomBytes(32).toString('base64url');
}

const SUBSCRIPTION_ID = '5f0c2a1e-8b7d-4c3a-9e2f-1a2b3c4d5e6f';
/** Planted in provider free text; must never appear in a response or a log. */
const PAYLOAD_MARKER = 'PAYLOAD-MARKER-7c1d9e';

function flightItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 'DL 1748',
    status: 'Expected',
    codeshareStatus: 'IsOperator',
    isCargo: false,
    lastUpdatedUtc: '2026-09-18 12:00Z',
    departure: {
      airport: { icao: 'KBOS', iata: 'BOS', timeZone: 'America/New_York' },
      scheduledTime: { utc: '2026-09-18 13:10Z', local: '2026-09-18 09:10-04:00' },
      terminal: 'A',
      gate: 'A12',
    },
    arrival: {
      airport: { icao: 'KDTW', iata: 'DTW', timeZone: 'America/Detroit' },
      scheduledTime: { utc: '2026-09-18 15:18Z', local: '2026-09-18 11:18-04:00' },
    },
    notificationSummary: PAYLOAD_MARKER,
    notificationRemark: null,
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flights: [flightItem()],
    subscription: {
      id: SUBSCRIPTION_ID,
      isActive: true,
      createdOnUtc: '2026-09-17 12:00Z',
      subject: { type: 'FlightByNumber', id: 'DL 1748' },
      subscriber: { type: 'WebHook', id: 'placeholder' },
    },
    balance: {
      creditsRemaining: 42,
      lastRefilledUtc: '2026-09-15 00:00Z',
      lastDeductedUtc: '2026-09-18 12:00Z',
    },
    ...overrides,
  };
}

function webhookApp(options: TestAppOptions & { token?: string } = {}) {
  const token = options.token ?? fakeToken();
  const testApp = buildTestApp({ ...options, env: { WEBHOOK_TOKEN: token, ...options.env } });
  return { ...testApp, token, url: `/webhooks/aerodatabox/${token}` };
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** Response headers that legitimately differ between two otherwise identical answers. */
function stableHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const { 'x-request-id': _id, date: _date, ...rest } = headers;
  return rest;
}

// ----------------------------------------------------------- proxy keys ---

describe("rate-limit key behind Render's proxy", () => {
  // `trustProxy` trusts exactly one hop (app.ts), so `request.ip` is the entry
  // Render itself appended — the rightmost X-Forwarded-For value. Anything an
  // attacker prepends is ignored, and two callers behind the same proxy get
  // their own buckets. Off by one here would turn the limit into one shared
  // bucket (ADR 0004 decision 3).
  const forwarded = (chain: string) => ({ ...JSON_HEADERS, 'x-forwarded-for': chain });

  it('keys on the address the proxy appended, not on one the caller prepends', async () => {
    const { app, url } = webhookApp();
    const body = envelope();

    // Same real caller (203.0.113.7), different forged prefixes each time.
    for (let i = 0; i < WEBHOOK_RATE_LIMIT.limit; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url,
        payload: body,
        headers: forwarded(`10.0.0.${i}, 203.0.113.7`),
      });
      expect(response.statusCode).toBe(200);
    }

    // The bucket is full for that caller however the chain is dressed up.
    const blocked = await app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: forwarded('198.51.100.9, 203.0.113.7'),
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('gives two callers behind the same proxy their own buckets', async () => {
    const { app, url } = webhookApp();
    const body = envelope();

    for (let i = 0; i < WEBHOOK_RATE_LIMIT.limit; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url,
        payload: body,
        headers: forwarded('203.0.113.7'),
      });
      expect(response.statusCode).toBe(200);
    }

    const other = await app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: forwarded('203.0.113.8'),
    });
    expect(other.statusCode).toBe(200);
  });
});

// ------------------------------------------------------------- accepted ---

describe('POST /webhooks/aerodatabox/:token — accepted', () => {
  it('answers 200 accepted and writes exactly one inbox row', async () => {
    const { app, db, url, token, serviceCalls, userCalls, asked } = webhookApp();
    const body = envelope();

    const response = await app.inject({ method: 'POST', url, payload: body });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'accepted' });

    const rows = db.rows('webhook_inbox');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subscription_id).toBe(SUBSCRIPTION_ID);
    // The parsed envelope, unknown item fields included: the worker re-parses.
    // `subscription.subscriber` is replaced: the provider echoes our delivery
    // target there, and that URL ends in WEBHOOK_TOKEN.
    const expected = JSON.parse(JSON.stringify(body)) as {
      subscription: { subscriber: unknown };
    };
    expected.subscription.subscriber = REDACTED_SUBSCRIBER;
    expect(rows[0]?.payload).toEqual(expected);
    expect(JSON.stringify(rows[0]?.payload)).not.toContain(token);

    // Only the service client, only the inbox, and never `flights` (§12.7).
    expect(serviceCalls).toEqual([{ table: 'webhook_inbox', op: 'insert' }]);
    expect(touchedFlights(serviceCalls)).toBe(false);
    expect(userCalls).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('accepts a charset parameter and a delivery with no balance', async () => {
    const { app, db, url } = webhookApp();
    const { balance: _balance, ...withoutBalance } = envelope();

    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify(withoutBalance),
    });

    expect(response.statusCode).toBe(200);
    expect(db.rows('webhook_inbox')).toHaveLength(1);
  });

  it('accepts an unknown top-level key and does not store it', async () => {
    const { app, db, url, logs } = webhookApp({ captureLogs: true });
    const planted = 'UNMODELLED-KEY-MARKER-3b8f';

    const response = await app.inject({
      method: 'POST',
      url,
      payload: envelope({ injected: planted, [planted]: { nested: planted } }),
    });

    expect(response.statusCode).toBe(200);
    const rows = db.rows('webhook_inbox');
    expect(rows).toHaveLength(1);
    const payload = rows[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['balance', 'flights', 'subscription']);
    expect(JSON.stringify(payload)).not.toContain(planted);
    expect(logs.join('')).not.toContain(planted);
  });

  it('stores only the allow-listed balance fields', async () => {
    const { app, db, url, token, logs } = webhookApp({ captureLogs: true });
    const planted = 'UNMODELLED-BALANCE-MARKER-51c7';

    const response = await app.inject({
      method: 'POST',
      url,
      payload: envelope({
        balance: {
          creditsRemaining: 42,
          lastRefilledUtc: '2026-09-15 00:00Z',
          lastDeductedUtc: '2026-09-18 12:00Z',
          notices: planted,
          callbackUrl: `https://api.example.invalid/webhooks/aerodatabox/${token}`,
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    const payload = db.rows('webhook_inbox')[0]?.payload as Record<string, unknown>;
    expect(payload.balance).toEqual({
      creditsRemaining: 42,
      lastRefilledUtc: '2026-09-15 00:00Z',
      lastDeductedUtc: '2026-09-18 12:00Z',
    });
    const stored = JSON.stringify(payload);
    expect(stored).not.toContain(planted);
    expect(stored).not.toContain(token);
    expect(logs.join('')).not.toContain(planted);
  });

  it('stores a null balance as null', async () => {
    const { app, db, url } = webhookApp();
    const response = await app.inject({ method: 'POST', url, payload: envelope({ balance: null }) });
    expect(response.statusCode).toBe(200);
    const payload = db.rows('webhook_inbox')[0]?.payload as Record<string, unknown>;
    expect(payload.balance).toBeNull();
  });

  it('accepts the real delivery shape: the three envelope fields and a non-string status', async () => {
    // What every real delivery was rejected over before 2026-09-18: `id`,
    // `timestampUtc` and `deliveryAttempt` at the top level, and a `status` that
    // is not a string (an integer, as captured; the worker decides what it means).
    const { app, db, url, token, logs } = webhookApp({ captureLogs: true });
    const planted = 'UNMODELLED-KEY-MARKER-9e41';
    const body = envelope({
      id: '0d6f3b1c-7a2e-4f55-9b1d-6c8e2a4f7b30',
      timestampUtc: '2026-09-17 09:41Z',
      deliveryAttempt: 0,
      flights: [flightItem({ status: 2, codeshareStatus: 1 })],
      somethingNew: planted,
    });

    const response = await app.inject({ method: 'POST', url, payload: body });

    expect(response.statusCode).toBe(200);
    const rows = db.rows('webhook_inbox');
    expect(rows).toHaveLength(1);
    const payload = rows[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      id: '0d6f3b1c-7a2e-4f55-9b1d-6c8e2a4f7b30',
      timestampUtc: '2026-09-17 09:41Z',
      deliveryAttempt: 0,
      subscription: { id: SUBSCRIPTION_ID, subscriber: REDACTED_SUBSCRIBER },
    });
    // The item is stored whole, status and all, for the worker's strict parse.
    expect((payload.flights as Record<string, unknown>[])[0]).toMatchObject({
      status: 2,
      codeshareStatus: 1,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'balance',
      'deliveryAttempt',
      'flights',
      'id',
      'subscription',
      'timestampUtc',
    ]);
    const stored = JSON.stringify(payload);
    expect(stored).not.toContain(planted);
    expect(stored).not.toContain(token);
    expect(logs.join('')).not.toContain(planted);
  });

  it('drops a wrongly typed envelope field instead of refusing the delivery, and names only its type', async () => {
    const { app, db, url, logs } = webhookApp({ captureLogs: true });

    const response = await app.inject({
      method: 'POST',
      url,
      payload: envelope({
        id: 987654321,
        timestampUtc: PAYLOAD_MARKER.repeat(10),
        deliveryAttempt: '1',
      }),
    });

    expect(response.statusCode).toBe(200);
    const payload = db.rows('webhook_inbox')[0]?.payload as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('id');
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('timestampUtc');
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('deliveryAttempt');

    const accepted = logs
      .map((line) => JSON.parse(line) as { msg?: string; dropped?: string[] })
      .find((line) => line.msg === 'webhook accepted');
    expect(accepted?.dropped).toEqual([
      'id (received number)',
      'timestampUtc (received string)',
      'deliveryAttempt (received string)',
    ]);
    const text = logs.join('');
    expect(text).not.toContain('987654321');
    expect(text).not.toContain(PAYLOAD_MARKER);
  });

  it('needs no Authorization header — the token is the credential', async () => {
    const { app, url } = webhookApp();

    const response = await app.inject({ method: 'POST', url, payload: envelope() });

    expect(response.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- token ---

describe('POST /webhooks/aerodatabox/:token — wrong token', () => {
  it('404s exactly like an unknown route and writes nothing', async () => {
    const wrong = fakeToken();
    const withRoute = webhookApp();
    const withoutRoute = buildTestApp();
    const request = {
      method: 'POST' as const,
      url: `/webhooks/aerodatabox/${wrong}`,
      payload: envelope(),
    };

    const rejected = await withRoute.app.inject(request);
    const unknown = await withoutRoute.app.inject(request);

    expect(rejected.statusCode).toBe(404);
    expect(rejected.statusCode).toBe(unknown.statusCode);
    expect(rejected.body).toBe(unknown.body);
    expect(stableHeaders(rejected.headers)).toEqual(stableHeaders(unknown.headers));
    expect(apiErrorSchema.parse(rejected.json()).error.code).toBe('NOT_FOUND');

    expect(withRoute.db.rows('webhook_inbox')).toEqual([]);
    expect(withRoute.serviceCalls).toEqual([]);
  });

  it.each([
    ['one character', 'x'],
    ['one character short', 'SHORT'],
    ['much longer than the secret', 'L'.repeat(90)],
    ['the right token plus a suffix', null],
  ])('404s a token that is %s, and writes nothing', async (_label, candidate) => {
    const { app, db, token, serviceCalls } = webhookApp();
    const guess = candidate ?? `${token}x`;

    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/aerodatabox/${guess}`,
      payload: envelope(),
    });

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    expect(db.rows('webhook_inbox')).toEqual([]);
    expect(serviceCalls).toEqual([]);
  });

  it('404s the right token on any other method', async () => {
    const { app, url } = webhookApp();

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);
  });
});

describe('tokenMatches', () => {
  const token = fakeToken();
  const digest = createHash('sha256').update(token, 'utf8').digest();

  it('matches only the exact token', () => {
    expect(tokenMatches(digest, token)).toBe(true);
    expect(tokenMatches(digest, token.toUpperCase())).toBe(token === token.toUpperCase());
  });

  // Hashing first makes every comparison 32 bytes vs 32 bytes, so a length
  // mismatch cannot return early — or throw, as a raw `timingSafeEqual` on
  // different-length buffers would.
  it.each([
    ['empty', ''],
    ['shorter', 'abc'],
    ['longer', `${'z'.repeat(200)}`],
    ['not a string', undefined],
  ])('returns false for a %s candidate without throwing', (_label, candidate) => {
    expect(() => tokenMatches(digest, candidate)).not.toThrow();
    expect(tokenMatches(digest, candidate)).toBe(false);
  });
});

// ---------------------------------------------------------- not enabled ---

describe('without WEBHOOK_TOKEN', () => {
  it('does not register the route at all', async () => {
    const { app, db, serviceCalls } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/aerodatabox/${fakeToken()}`,
      payload: envelope(),
    });

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    expect(db.rows('webhook_inbox')).toEqual([]);
    expect(serviceCalls).toEqual([]);
  });

  it('treats an empty WEBHOOK_TOKEN (a copied .env.example) as unset', async () => {
    expect(testConfig({ WEBHOOK_TOKEN: '' }).WEBHOOK_TOKEN).toBeUndefined();

    const { app } = buildTestApp({ env: { WEBHOOK_TOKEN: '' } });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/aerodatabox/',
      payload: envelope(),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('WEBHOOK_TOKEN validation', () => {
  it.each([
    ['too short', 'a'.repeat(31)],
    ['too long for the router', 'a'.repeat(101)],
    ['not URL-safe', `${'a'.repeat(40)}/+=`],
    ['padded with a space', ` ${'a'.repeat(40)}`],
  ])('refuses a token that is %s, naming the variable but never the value', (_label, value) => {
    let thrown: unknown;
    try {
      testConfig({ WEBHOOK_TOKEN: value });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as Error).message;
    expect(message).toContain('WEBHOOK_TOKEN');
    expect(message).not.toContain(value);
  });

  it('accepts a generated base64url token', () => {
    const token = fakeToken();
    expect(testConfig({ WEBHOOK_TOKEN: token }).WEBHOOK_TOKEN).toBe(token);
  });
});

// ----------------------------------------------------------- bad bodies ---

describe('POST /webhooks/aerodatabox/:token — bodies it refuses', () => {
  const tooManyFlights = envelope({
    flights: Array.from({ length: WEBHOOK_MAX_FLIGHTS + 1 }, () => flightItem()),
  });
  const { id: _id, ...subscriptionWithoutId } = envelope().subscription as Record<string, unknown>;
  const { lastUpdatedUtc: _updated, ...itemWithoutUpdated } = flightItem();
  const { status: _status, ...itemWithoutStatus } = flightItem();

  const cases: Array<[string, { payload: string; contentType?: string }, number, string]> = [
    [
      'malformed JSON',
      { payload: `{"flights":[{"notificationSummary":"${PAYLOAD_MARKER}"` },
      400,
      'VALIDATION_ERROR',
    ],
    ['an empty body', { payload: '' }, 400, 'VALIDATION_ERROR'],
    ['a JSON array', { payload: '[]' }, 400, 'VALIDATION_ERROR'],
    ['a JSON string', { payload: `"${PAYLOAD_MARKER}"` }, 400, 'VALIDATION_ERROR'],
    [
      'a missing subscription.id',
      { payload: JSON.stringify(envelope({ subscription: subscriptionWithoutId })) },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'a subscription.id that is not a uuid',
      { payload: JSON.stringify(envelope({ subscription: { id: PAYLOAD_MARKER } })) },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'a flight without status',
      { payload: JSON.stringify(envelope({ flights: [itemWithoutStatus] })) },
      400,
      'VALIDATION_ERROR',
    ],
    ['too many flights', { payload: JSON.stringify(tooManyFlights) }, 400, 'VALIDATION_ERROR'],
    [
      'a flight without lastUpdatedUtc',
      { payload: JSON.stringify(envelope({ flights: [itemWithoutUpdated] })) },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'flights that is not an array',
      { payload: JSON.stringify(envelope({ flights: PAYLOAD_MARKER })) },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'a prototype-poisoning key',
      { payload: `{"__proto__":{"polluted":"${PAYLOAD_MARKER}"},"flights":[]}` },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'a text/plain body',
      { payload: JSON.stringify(envelope()), contentType: 'text/plain' },
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    ],
  ];

  it.each(cases)('refuses %s and writes nothing', async (_label, body, status, code) => {
    const { app, db, url, serviceCalls } = webhookApp();

    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': body.contentType ?? 'application/json' },
      payload: body.payload,
    });

    expect(response.statusCode).toBe(status);
    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.code).toBe(code);
    expect(Object.keys(response.json() as object)).toEqual(['error']);
    // Generic: nothing from the body, and none of Fastify's own codes.
    expect(response.body).not.toContain(PAYLOAD_MARKER);
    expect(response.body).not.toMatch(/FST_ERR|Unexpected token|JSON at position/);

    expect(db.rows('webhook_inbox')).toEqual([]);
    expect(serviceCalls).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('413s a body over 256 KB and writes nothing', async () => {
    const { app, db, url, serviceCalls } = webhookApp();
    const payload = JSON.stringify(
      envelope({
        flights: [flightItem({ notificationRemark: 'x'.repeat(WEBHOOK_BODY_LIMIT_BYTES) })],
      }),
    );

    const response = await app.inject({ method: 'POST', url, headers: JSON_HEADERS, payload });

    expect(response.statusCode).toBe(413);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(db.rows('webhook_inbox')).toEqual([]);
    expect(serviceCalls).toEqual([]);
  });

  it('accepts a body just under the cap', async () => {
    const { app, db, url } = webhookApp();
    const base = JSON.stringify(envelope({ flights: [flightItem({ notificationRemark: '' })] }));
    const padding = WEBHOOK_BODY_LIMIT_BYTES - Buffer.byteLength(base);
    const payload = JSON.stringify(
      envelope({ flights: [flightItem({ notificationRemark: 'x'.repeat(padding) })] }),
    );
    expect(Buffer.byteLength(payload)).toBe(WEBHOOK_BODY_LIMIT_BYTES);

    const response = await app.inject({ method: 'POST', url, headers: JSON_HEADERS, payload });

    expect(response.statusCode).toBe(200);
    expect(db.rows('webhook_inbox')).toHaveLength(1);
  });
});

// ----------------------------------------------------------- rate limit ---

describe('POST /webhooks/aerodatabox/:token — rate limit', () => {
  function movingClock() {
    let nowMs = Date.parse('2026-09-15T12:00:00.000Z');
    return {
      clock: () => new Date(nowMs),
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('429s past the per-IP threshold, writes nothing for it, and resets after the window', async () => {
    const time = movingClock();
    const { app, db, url } = webhookApp({ clock: time.clock });
    const { limit, windowMs } = WEBHOOK_RATE_LIMIT;

    for (let index = 0; index < limit; index += 1) {
      const ok = await app.inject({ method: 'POST', url, payload: envelope() });
      expect(ok.statusCode).toBe(200);
    }

    const limited = await app.inject({ method: 'POST', url, payload: envelope() });
    expect(limited.statusCode).toBe(429);
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe(String(windowMs / 1000));
    expect(db.rows('webhook_inbox')).toHaveLength(limit);

    // Another address is unaffected.
    const elsewhere = await app.inject({
      method: 'POST',
      url,
      remoteAddress: '203.0.113.7',
      payload: envelope(),
    });
    expect(elsewhere.statusCode).toBe(200);

    time.advance(windowMs);
    const afterWindow = await app.inject({ method: 'POST', url, payload: envelope() });
    expect(afterWindow.statusCode).toBe(200);
    expect(db.rows('webhook_inbox')).toHaveLength(limit + 2);
  });

  it('does not let wrong-token guesses spend the budget real deliveries need', async () => {
    const time = movingClock();
    const { app, url } = webhookApp({ clock: time.clock });

    for (let index = 0; index <= WEBHOOK_RATE_LIMIT.limit; index += 1) {
      const guess = await app.inject({
        method: 'POST',
        url: `/webhooks/aerodatabox/${fakeToken()}`,
        payload: envelope(),
      });
      expect(guess.statusCode).toBe(404);
    }

    const real = await app.inject({ method: 'POST', url, payload: envelope() });
    expect(real.statusCode).toBe(200);
  });
});

// --------------------------------------------------------- insert fails ---

describe('POST /webhooks/aerodatabox/:token — inbox insert fails', () => {
  it('503s so the provider retries, and says nothing about why', async () => {
    const { app, db, url } = webhookApp();
    db.failNextWrite('webhook_inbox', {
      code: '42P01',
      message: 'relation "public.webhook_inbox" does not exist',
    });

    const response = await app.inject({ method: 'POST', url, payload: envelope() });

    expect(response.statusCode).toBe(503);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body).not.toMatch(/relation|42P01|webhook_inbox/);
    expect(db.rows('webhook_inbox')).toEqual([]);
  });
});

// ----------------------------------------------------------------- logs ---

describe('POST /webhooks/aerodatabox/:token — logging', () => {
  it('never logs the token, the path or the payload, on any path', async () => {
    const wrong = fakeToken();
    const { app, db, url, token, logs } = webhookApp({ captureLogs: true });

    // Accepted.
    expect((await app.inject({ method: 'POST', url, payload: envelope() })).statusCode).toBe(200);
    // Wrong token.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/webhooks/aerodatabox/${wrong}`,
          payload: envelope(),
        })
      ).statusCode,
    ).toBe(404);
    // Unparseable, and parseable but invalid, both carrying the marker.
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: JSON_HEADERS,
          payload: `{"flights":"${PAYLOAD_MARKER}`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url, payload: envelope({ flights: PAYLOAD_MARKER }) }))
        .statusCode,
    ).toBe(400);
    // Too large.
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: JSON_HEADERS,
          payload: `{"x":"${PAYLOAD_MARKER}${'x'.repeat(WEBHOOK_BODY_LIMIT_BYTES)}"}`,
        })
      ).statusCode,
    ).toBe(413);
    // Insert failure.
    db.failNextWrite('webhook_inbox', { code: '42P01', message: `boom ${PAYLOAD_MARKER}` });
    expect((await app.inject({ method: 'POST', url, payload: envelope() })).statusCode).toBe(503);

    const text = logs.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(text).not.toContain(token);
    expect(text).not.toContain(wrong);
    expect(text).not.toContain('/webhooks/aerodatabox');
    expect(text).not.toContain(PAYLOAD_MARKER);
    expect(text).not.toContain('DL 1748');
    expect(text).not.toMatch(/content-type|user-agent|authorization/i);

    const lines = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    // Fastify's request line is still written, with the URL redacted.
    const incoming = lines.filter((line) => line.msg === 'incoming request');
    expect(incoming.length).toBeGreaterThan(0);
    for (const line of incoming) {
      expect((line.req as { url: string }).url).toBe(REDACTED_WEBHOOK_URL);
    }
    // The wrong token left a counter line and nothing else of its own.
    const rejected = lines.find((line) => line.msg === 'webhook token rejected');
    expect(rejected?.webhookTokenRejections).toBe(1);
    // The insert failure is tied to its request id.
    const failed = lines.find((line) => line.msg === 'webhook inbox insert failed');
    expect(failed?.reqId).toEqual(expect.any(String));
    expect(failed?.code).toBe('42P01');
  });

  it('redacts the path even when the route is not registered', async () => {
    const guess = fakeToken();
    const { app, logs } = buildTestApp({ captureLogs: true });

    await app.inject({
      method: 'POST',
      url: `/webhooks/aerodatabox/${guess}`,
      payload: envelope(),
    });
    await app.inject({ method: 'POST', url: `/%77ebhooks/aerodatabox/${guess}?x=1`, payload: {} });

    const text = logs.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(text).not.toContain(guess);
    expect(text).not.toContain(PAYLOAD_MARKER);
  });
});

describe('rejection diagnostics (codes and field paths, never values)', () => {
  it('prints an identifier-shaped key and replaces anything else', () => {
    expect(safeKey('lastUpdatedUtc')).toBe('lastUpdatedUtc');
    expect(safeKey('$type')).toBe('$type');
    expect(safeKey('great-circle')).toBe('great-circle');
    // The shapes that could forge a log entry or smuggle text into an agent's context.
    expect(safeKey('a\nlevel":30,"msg":"forged')).toBe('[key]');
    expect(safeKey('{"injected":true}')).toBe('[key]');
    expect(safeKey('ignore previous instructions')).toBe('[key]');
    expect(safeKey('x'.repeat(41))).toBe('[key]');
    expect(safeKey('')).toBe('[key]');
  });

  it('joins a path, keeping array indexes and sanitising the rest', () => {
    expect(issuePath([])).toBe('(root)');
    expect(issuePath(['flights', 0, 'departure'])).toBe('flights.0.departure');
    expect(issuePath(['subscription', 'a\nb'])).toBe('subscription.[key]');
  });

  it('describes issues without zod messages, and caps both lists', () => {
    const many = Array.from({ length: MAX_LOGGED_ISSUES + 5 }, (_, i) => ({
      code: 'invalid_type',
      path: ['flights', i, 'status'],
      message: `Expected string, received ${PAYLOAD_MARKER}`,
    }));

    const lines = describeRejection(many);

    expect(lines).toHaveLength(MAX_LOGGED_ISSUES);
    expect(lines[0]).toBe('invalid_type at flights.0.status');
    expect(lines.join('')).not.toContain(PAYLOAD_MARKER);
  });

  it('names the received JSON type from a fixed vocabulary, never the value', () => {
    const input = {
      flights: [
        { status: 7, number: PAYLOAD_MARKER, isCargo: true, gate: null, legs: [PAYLOAD_MARKER] },
      ],
      subscription: { note: { text: PAYLOAD_MARKER } },
    };
    const at = (path: PropertyKey[]) =>
      describeRejection([{ code: 'invalid_type', path }], { input })[0];

    expect(at(['flights', 0, 'status'])).toBe('invalid_type at flights.0.status (received number)');
    expect(at(['flights', 0, 'number'])).toBe('invalid_type at flights.0.number (received string)');
    expect(at(['flights', 0, 'isCargo'])).toBe(
      'invalid_type at flights.0.isCargo (received boolean)',
    );
    expect(at(['flights', 0, 'gate'])).toBe('invalid_type at flights.0.gate (received null)');
    expect(at(['flights', 0, 'legs'])).toBe('invalid_type at flights.0.legs (received array)');
    expect(at(['subscription', 'note'])).toBe(
      'invalid_type at subscription.note (received object)',
    );
    expect(at(['flights', 0, 'missing'])).toBe(
      'invalid_type at flights.0.missing (received undefined)',
    );
    // Out of range, a string index on an array, an inherited key: never resolved.
    expect(at(['flights', 5, 'status'])).toContain('(received undefined)');
    expect(at(['flights', 'length'])).toContain('(received undefined)');
    expect(at(['__proto__'])).toBe('invalid_type at __proto__ (received undefined)');
    expect(at(['subscription', 'toString'])).toContain('(received undefined)');

    // Only invalid_type carries it, and nothing but the seven words ever appears.
    expect(describeRejection([{ code: 'too_big', path: ['flights'] }], { input })).toEqual([
      'too_big at flights',
    ]);
    const all = [
      ['flights', 0, 'status'],
      ['flights', 0, 'number'],
      ['flights', 0, 'legs', 0],
      ['subscription', 'note', 'text'],
    ].map((path) => describeRejection([{ code: 'invalid_type', path }], { input })[0] ?? '');
    for (const line of all) {
      expect(line).not.toContain(PAYLOAD_MARKER);
      expect(JSON_TYPE_NAMES).toContain(/\(received (\w+)\)$/.exec(line)?.[1]);
    }
  });

  it('maps every JSON value to one of the seven type names', () => {
    const values: unknown[] = ['', 0, -1.5, true, null, [], {}, undefined];
    expect(values.map(jsonTypeOf)).toEqual([
      'string',
      'number',
      'number',
      'boolean',
      'null',
      'array',
      'object',
      'undefined',
    ]);
  });

  it('logs the received type of a real rejection, and still no value', async () => {
    const { app, url, logs } = webhookApp({ captureLogs: true });

    await app.inject({
      method: 'POST',
      url,
      payload: envelope({ subscription: { id: SUBSCRIPTION_ID }, flights: [{ number: 7, note: PAYLOAD_MARKER }] }),
    });

    const rejected = logs
      .map((line) => JSON.parse(line) as { msg?: string; rejected?: string[] })
      .find((line) => line.msg === 'webhook body rejected');

    expect(rejected?.rejected).toEqual([
      'invalid_type at flights.0.number (received number)',
      'invalid_type at flights.0.status (received undefined)',
      'invalid_type at flights.0.departure (received undefined)',
      'invalid_type at flights.0.arrival (received undefined)',
      'invalid_type at flights.0.lastUpdatedUtc (received undefined)',
    ]);
    expect(logs.join('')).not.toContain(PAYLOAD_MARKER);
  });

  it('lists unrecognized keys, sanitised and capped', () => {
    const keys = Array.from({ length: MAX_LOGGED_KEYS + 3 }, (_, i) => `extra${i}`);

    const [line] = describeRejection([
      { code: 'unrecognized_keys', path: [], keys: [...keys, 'a\nforged'] },
    ]);

    expect(line?.startsWith('unrecognized_keys at (root): extra0,')).toBe(true);
    expect(line?.split(': ')[1]?.split(',')).toHaveLength(MAX_LOGGED_KEYS);
    expect(line).not.toContain('\n');
  });

  it('logs the failing paths of a real rejection, and still no values', async () => {
    const { app, url, logs, token } = webhookApp({ captureLogs: true });

    const response = await app.inject({
      method: 'POST',
      url,
      payload: envelope({ flights: PAYLOAD_MARKER }),
    });

    expect(response.statusCode).toBe(400);
    // The caller is told nothing beyond the generic envelope.
    expect(JSON.parse(response.body)).not.toMatchObject({ error: { details: expect.anything() } });

    const rejected = logs
      .map((line) => JSON.parse(line) as { msg?: string; rejected?: string[] })
      .find((line) => line.msg === 'webhook body rejected');

    // The JSON type found there, never the value.
    expect(rejected?.rejected).toEqual(['invalid_type at flights (received string)']);
    const text = logs.join('');
    expect(text).not.toContain(PAYLOAD_MARKER);
    expect(text).not.toContain(token);
  });

  it('names the field when a flight item is malformed', async () => {
    const { app, url, logs } = webhookApp({ captureLogs: true });
    const { lastUpdatedUtc: _dropped, ...itemWithoutUpdated } = flightItem();

    await app.inject({ method: 'POST', url, payload: envelope({ flights: [itemWithoutUpdated] }) });

    const rejected = logs
      .map((line) => JSON.parse(line) as { msg?: string; rejected?: string[] })
      .find((line) => line.msg === 'webhook body rejected');

    expect(rejected?.rejected).toEqual(['invalid_type at flights.0.lastUpdatedUtc (received undefined)']);
  });
});
