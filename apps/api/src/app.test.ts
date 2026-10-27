/**
 * The pipeline every request goes through: health, auth, the error envelope.
 */
import { apiErrorSchema } from '@flightbuddy/shared';
import { describe, expect, it } from 'vitest';

import { AUTH_HEADERS, buildTestApp } from './testing/app';

describe('GET /healthz', () => {
  it('answers without a token and without touching anything', async () => {
    const { app, asked, userCalls, serviceCalls } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    // A liveness probe that depends on Supabase or the provider turns an
    // upstream blip into a crash loop.
    expect(asked).toEqual([]);
    expect(userCalls).toEqual([]);
    expect(serviceCalls).toEqual([]);
  });

  it('echoes a request id back on every response', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'from-the-load-balancer' },
    });

    expect(response.headers['x-request-id']).toBe('from-the-load-balancer');
  });
});

describe('authentication', () => {
  const protectedRoutes = [
    { method: 'GET' as const, url: '/v1/me' },
    { method: 'POST' as const, url: '/v1/flights/lookup' },
    { method: 'POST' as const, url: '/v1/flights' },
  ];

  it.each(protectedRoutes)('401s $method $url with no Authorization header', async (route) => {
    const { app, userCalls, serviceCalls, asked } = buildTestApp();

    const response = await app.inject({ ...route, payload: {} });

    expect(response.statusCode).toBe(401);
    const body = apiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('UNAUTHORIZED');
    // Rejected before anything downstream was reached.
    expect(userCalls).toEqual([]);
    expect(serviceCalls).toEqual([]);
    expect(asked).toEqual([]);
  });

  it.each([
    ['a token the verifier rejects', { authorization: 'Bearer not-the-test-token' }],
    ['a non-bearer scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['an empty header', { authorization: '' }],
  ])('401s on %s', async (_label, headers) => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/v1/me', headers });

    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('never leaks internals in the error body', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer not-the-test-token' },
    });

    const raw = response.body;
    expect(raw).not.toMatch(/stack|at Object|\.ts:\d+/i);
    expect(raw).not.toContain('test-service-role-key');
    expect(raw).not.toContain('test-rapidapi-key');
    expect(Object.keys(response.json() as object)).toEqual(['error']);
  });
});

/**
 * Authentication runs in `onRequest`, before Fastify parses the body: a caller
 * who is about to be rejected costs no parse, and cannot learn anything from a
 * 400/413/415 that a signed-in caller would get.
 */
describe('authentication runs before the body is parsed', () => {
  // Fastify's default `bodyLimit` (1 MiB); the API does not override it.
  const oversized = JSON.stringify({ query: 'x'.repeat(1024 * 1024) });
  const unreadableBodies = [
    { label: 'malformed JSON', contentType: 'application/json', payload: '{not json', status: 400 },
    {
      label: 'an oversized body',
      contentType: 'application/json',
      payload: oversized,
      status: 413,
    },
    {
      label: 'an unsupported media type',
      contentType: 'application/xml',
      payload: '<a/>',
      status: 415,
    },
  ];
  const postRoutes = ['/v1/flights/lookup', '/v1/flights'];
  const anonymousCases = postRoutes.flatMap((url) =>
    unreadableBodies.flatMap((body) => [
      { ...body, url, caller: 'no token', headers: {} },
      {
        ...body,
        url,
        caller: 'a rejected token',
        headers: { authorization: 'Bearer not-the-test-token' },
      },
    ]),
  );

  it.each(anonymousCases)(
    '401s $url with $caller and $label',
    async ({ url, headers, contentType, payload }) => {
      const { app, userCalls, serviceCalls, asked } = buildTestApp();

      const response = await app.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'content-type': contentType },
        payload,
      });

      expect(response.statusCode).toBe(401);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
      expect(userCalls).toEqual([]);
      expect(serviceCalls).toEqual([]);
      expect(asked).toEqual([]);
    },
  );

  const signedInCases = postRoutes.flatMap((url) =>
    unreadableBodies.map((body) => ({ ...body, url })),
  );

  it.each(signedInCases)(
    'still answers a signed-in caller on $url with $status for $label',
    async ({ url, contentType, payload, status }) => {
      const { app, asked } = buildTestApp();

      const response = await app.inject({
        method: 'POST',
        url,
        headers: { ...AUTH_HEADERS, 'content-type': contentType },
        payload,
      });

      expect(response.statusCode).toBe(status);
      const { error } = apiErrorSchema.parse(response.json());
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).not.toMatch(/FST_ERR/);
      expect(asked).toEqual([]);
    },
  );

  it('still answers a CORS preflight without a token', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/flights',
      headers: {
        origin: 'https://example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBeDefined();
  });

  it('still carries CORS and request-id headers on the 401', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/flights/lookup',
      headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['access-control-allow-origin']).toBeDefined();
    expect(response.headers['x-request-id']).toBeDefined();
  });
});

describe('request bodies the parser rejects', () => {
  it.each([
    ['an empty body', ''],
    ['malformed JSON', '{not json'],
  ])('400s %s as VALIDATION_ERROR, not a Fastify code', async (_label, payload) => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/flights/lookup',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(400);
    const { error } = apiErrorSchema.parse(response.json());
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).not.toMatch(/FST_ERR/);
  });
});

describe('unknown routes', () => {
  it('answers 404 in the shared envelope', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/v1/nope', headers: AUTH_HEADERS });

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });
});
