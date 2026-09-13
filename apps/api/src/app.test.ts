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
