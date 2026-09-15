/**
 * The real JWT verifier, driven directly.
 *
 * Every other test in this package injects `fakeVerifier`, which means the
 * thing that actually stands between a stranger and somebody's itinerary — the
 * signature check in `createTokenVerifier` — had no coverage at all. This file
 * exercises it with keys generated in-process: no network, no fixtures, no
 * secrets. The JWKS is served through the `fetchJwks` seam, so the token takes
 * the same path through `jose`'s remote key set that it takes in production.
 *
 * The attacks worth failing are named as such: a token from a foreign issuer,
 * `alg: none`, an HS token when no secret is configured, and the classic
 * algorithm-confusion attempt where the public key is used as an HMAC secret.
 */
import { describe, expect, it } from 'vitest';
import {
  SignJWT,
  base64url,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type CryptoKey,
  type FetchImplementation,
  type JWK,
  type JWTPayload,
} from 'jose';

import {
  CLOCK_TOLERANCE_SECONDS,
  JWKS_TIMEOUT_MS,
  bearerToken,
  createAuthenticate,
  createTokenVerifier,
  requireUser,
  requireUserClient,
  type AuthUser,
} from './auth';
import { UnauthorizedError } from './errors';
import type { Client } from './supabase';

// ------------------------------------------------------------- the world ---

/** Shaped like the real thing, means nothing. No real project is reachable. */
const SUPABASE_URL = 'https://project-ref.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const AUDIENCE = 'authenticated';
const KID = 'fb-test-key-1';

/** Obviously fake, and a valid v4-shaped uuid so the `sub` check passes. */
const USER_ID = '00000000-0000-4000-8000-000000000001';
const USER_EMAIL = 'traveller@example.test';

/**
 * Not a secret: generated for this file, used only here, and never a value the
 * project holds. `SUPABASE_JWT_SECRET` is not read by any test below.
 */
const HS_SECRET = 'hs-secret-for-tests-only-0123456789abcdef';

interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JWK;
}

async function makeKeyPair(): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, publicKey, jwk: { ...jwk, kid: KID, alg: 'ES256', use: 'sig' } };
}

// Generated once: key generation is the slow part, and every test that signs
// with the "wrong" key wants a key that is simply not the served one.
const ours = await makeKeyPair();
const theirs = await makeKeyPair();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A well-formed Supabase access token, signed with whichever key is given. */
async function signEs256(
  key: CryptoKey,
  options: {
    claims?: JWTPayload;
    issuer?: string;
    audience?: string;
    expiresAt?: number;
    kid?: string;
  } = {},
): Promise<string> {
  const claims: JWTPayload = options.claims ?? { sub: USER_ID, email: USER_EMAIL };
  return await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: options.kid ?? KID })
    .setIssuedAt(nowSeconds() - 10)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresAt ?? nowSeconds() + 3600)
    .sign(key);
}

/** The legacy path: HS256 with whatever byte string the caller supplies. */
async function signHs256(
  secret: Uint8Array,
  options: { claims?: JWTPayload; issuer?: string; audience?: string } = {},
): Promise<string> {
  const claims: JWTPayload = options.claims ?? { sub: USER_ID, email: USER_EMAIL };
  return await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(nowSeconds() - 10)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(nowSeconds() + 3600)
    .sign(secret);
}

/** `alg: none` — a header, a payload and an empty signature. */
function unsignedToken(claims: JWTPayload = { sub: USER_ID, email: USER_EMAIL }): string {
  const encode = (value: unknown): string =>
    base64url.encode(new TextEncoder().encode(JSON.stringify(value)));
  const header = encode({ alg: 'none', typ: 'JWT' });
  const payload = encode({
    ...claims,
    iss: ISSUER,
    aud: AUDIENCE,
    iat: nowSeconds() - 10,
    exp: nowSeconds() + 3600,
  });
  return `${header}.${payload}.`;
}

// ---------------------------------------------------------- the JWKS seam ---

interface JwksStub {
  fetchJwks: FetchImplementation;
  /** URLs asked for, in order. Empty means the key set was never consulted. */
  calls: string[];
  /** The abort signal `jose` handed the last fetch — its own request budget. */
  lastSignal: AbortSignal | undefined;
}

/** Serves a key set, or fails, without a socket. */
function jwksStub(
  behaviour:
    | { kind: 'serve'; keys: JWK[] }
    | { kind: 'reject'; error: Error }
    | { kind: 'status'; status: number }
    | { kind: 'hang' },
): JwksStub {
  const stub: JwksStub = { calls: [], lastSignal: undefined, fetchJwks: async () => new Response() };
  stub.fetchJwks = async (url, options) => {
    stub.calls.push(url);
    stub.lastSignal = options.signal;
    if (behaviour.kind === 'reject') throw behaviour.error;
    if (behaviour.kind === 'status') {
      return new Response('nope', { status: behaviour.status });
    }
    if (behaviour.kind === 'hang') {
      // Honour the signal the way a real fetch does: reject when `jose` gives
      // up, never on its own. This is what proves the verifier has a deadline.
      return await new Promise<Response>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(options.signal.reason as Error);
        });
      });
    }
    return new Response(JSON.stringify({ keys: behaviour.keys }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return stub;
}

/** A verifier wired to a stub key set. `jwtSecret` is omitted unless asked for. */
function verifierWith(
  stub: JwksStub,
  options: { jwtSecret?: string } = {},
): ReturnType<typeof createTokenVerifier> {
  return createTokenVerifier({
    supabaseUrl: SUPABASE_URL,
    fetchJwks: stub.fetchJwks,
    ...(options.jwtSecret === undefined ? {} : { jwtSecret: options.jwtSecret }),
  });
}

function servingOurKey(): JwksStub {
  return jwksStub({ kind: 'serve', keys: [ours.jwk] });
}

/** Every rejection this file expects is a 401 with a safe, user-facing message. */
async function expect401(promise: Promise<unknown>): Promise<UnauthorizedError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, 'expected the verifier to reject').toBeInstanceOf(UnauthorizedError);
  const unauthorized = error as UnauthorizedError;
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.code).toBe('UNAUTHORIZED');
  return unauthorized;
}

// ------------------------------------------------------------------ tests ---

describe('createTokenVerifier — the ES256 path', () => {
  it('accepts a token signed by the key the JWKS serves', async () => {
    const jwks = servingOurKey();
    const verify = verifierWith(jwks);

    const user = await verify(await signEs256(ours.privateKey));

    expect(user).toEqual<AuthUser>({ id: USER_ID, email: USER_EMAIL });
    expect(jwks.calls).toEqual([JWKS_URL]);
  });

  it('caches the key set, so a burst of requests costs one fetch', async () => {
    const jwks = servingOurKey();
    const verify = verifierWith(jwks);

    const tokens = await Promise.all([
      signEs256(ours.privateKey),
      signEs256(ours.privateKey),
      signEs256(ours.privateKey),
    ]);
    for (const token of tokens) await verify(token);

    expect(jwks.calls).toHaveLength(1);
  });

  it('reports no email when the token carries none', async () => {
    const verify = verifierWith(servingOurKey());

    const user = await verify(await signEs256(ours.privateKey, { claims: { sub: USER_ID } }));

    expect(user).toEqual<AuthUser>({ id: USER_ID, email: null });
  });

  it('treats an empty email claim as no email', async () => {
    const verify = verifierWith(servingOurKey());

    const user = await verify(
      await signEs256(ours.privateKey, { claims: { sub: USER_ID, email: '' } }),
    );

    expect(user.email).toBeNull();
  });

  it('rejects a token signed by a foreign issuer claiming our kid', async () => {
    const verify = verifierWith(servingOurKey());

    // The attacker signs with their own key but names the kid we publish, so
    // the key set resolves — and the signature is what fails.
    await expect401(verify(await signEs256(theirs.privateKey)));
  });

  it('rejects a token whose kid is not in the key set', async () => {
    const jwks = servingOurKey();
    const verify = verifierWith(jwks);

    await expect401(verify(await signEs256(theirs.privateKey, { kid: 'some-other-key' })));
  });

  it('rejects an `alg: none` token', async () => {
    const jwks = servingOurKey();
    const verify = verifierWith(jwks);

    await expect401(verify(unsignedToken()));
  });

  it('rejects a wrong issuer', async () => {
    const verify = verifierWith(servingOurKey());

    await expect401(
      verify(await signEs256(ours.privateKey, { issuer: 'https://evil.example.test/auth/v1' })),
    );
  });

  it('rejects a wrong audience', async () => {
    const verify = verifierWith(servingOurKey());

    await expect401(verify(await signEs256(ours.privateKey, { audience: 'anon' })));
  });

  it('rejects a token with no `sub`', async () => {
    const verify = verifierWith(servingOurKey());

    const error = await expect401(
      verify(await signEs256(ours.privateKey, { claims: { email: USER_EMAIL } })),
    );

    expect(error.message).toBe('That token has no user on it.');
  });

  it('rejects a `sub` that is not a uuid', async () => {
    const verify = verifierWith(servingOurKey());

    await expect401(
      verify(await signEs256(ours.privateKey, { claims: { sub: 'admin', email: USER_EMAIL } })),
    );
  });
});

describe('createTokenVerifier — expiry', () => {
  it('rejects a token that expired well past the tolerance', async () => {
    const verify = verifierWith(servingOurKey());

    const error = await expect401(
      verify(await signEs256(ours.privateKey, { expiresAt: nowSeconds() - 600 })),
    );

    expect(error.message).toBe('Your session has expired. Sign in again.');
  });

  it('accepts a token inside the clock tolerance', async () => {
    const verify = verifierWith(servingOurKey());

    // Expired a moment ago: the hosts' clocks differ by seconds, not minutes.
    const expiresAt = nowSeconds() - (CLOCK_TOLERANCE_SECONDS - 2);
    const user = await verify(await signEs256(ours.privateKey, { expiresAt }));

    expect(user.id).toBe(USER_ID);
  });

  it('rejects a token that expired just outside the tolerance', async () => {
    const verify = verifierWith(servingOurKey());

    const expiresAt = nowSeconds() - (CLOCK_TOLERANCE_SECONDS + 2);
    await expect401(verify(await signEs256(ours.privateKey, { expiresAt })));
  });
});

describe('createTokenVerifier — the HS256 fallback', () => {
  const secretBytes = new TextEncoder().encode(HS_SECRET);

  it('rejects an HS256 token when no secret is configured, without touching the JWKS', async () => {
    const jwks = servingOurKey();
    const verify = verifierWith(jwks);

    await expect401(verify(await signHs256(secretBytes)));

    // The whole point: an HS token is never retried against the public keys.
    expect(jwks.calls).toEqual([]);
  });

  it('accepts an HS256 token signed with the configured secret', async () => {
    const jwks = servingOurKey();
    const verify = verifierWith(jwks, { jwtSecret: HS_SECRET });

    const user = await verify(await signHs256(secretBytes));

    expect(user).toEqual<AuthUser>({ id: USER_ID, email: USER_EMAIL });
    expect(jwks.calls).toEqual([]);
  });

  it('rejects an HS256 token signed with a different secret', async () => {
    const verify = verifierWith(servingOurKey(), { jwtSecret: HS_SECRET });

    await expect401(verify(await signHs256(new TextEncoder().encode(`${HS_SECRET}-not`))));
  });

  it('rejects an HS256 token with a wrong issuer or audience', async () => {
    const verify = verifierWith(servingOurKey(), { jwtSecret: HS_SECRET });

    await expect401(verify(await signHs256(secretBytes, { issuer: 'https://evil.example.test' })));
    await expect401(verify(await signHs256(secretBytes, { audience: 'anon' })));
  });

  it('rejects algorithm confusion: HS256 signed with the ES256 public key', async () => {
    const jwks = servingOurKey();
    const verify = verifierWith(jwks, { jwtSecret: HS_SECRET });

    // The classic attack: take the public key the JWKS publishes and use its
    // bytes as an HMAC secret, hoping the verifier picks its key by `alg`.
    const publicKeyBytes = new TextEncoder().encode(await exportSPKI(ours.publicKey));
    await expect401(verify(await signHs256(publicKeyBytes)));

    expect(jwks.calls).toEqual([]);
  });

  it('rejects that same attack when no secret is configured', async () => {
    const jwks = servingOurKey();
    const verify = verifierWith(jwks);

    const publicKeyBytes = new TextEncoder().encode(await exportSPKI(ours.publicKey));
    await expect401(verify(await signHs256(publicKeyBytes)));

    expect(jwks.calls).toEqual([]);
  });
});

describe('createTokenVerifier — malformed input', () => {
  it.each([
    ['empty', ''],
    ['not a jwt', 'hello'],
    ['two segments', 'aaa.bbb'],
    ['header is not base64url json', '!!!.eyJzdWIiOiJhIn0.sig'],
    ['header is a json array', `${base64url.encode(new TextEncoder().encode('[]'))}.e30.sig`],
  ])('rejects a %s token before any key is consulted', async (_label, token) => {
    const jwks = servingOurKey();
    const verify = verifierWith(jwks);

    const error = await expect401(verify(token));

    expect(error.message).toBe('That is not a valid access token.');
    expect(jwks.calls).toEqual([]);
  });
});

describe('createTokenVerifier — a JWKS endpoint that is not answering', () => {
  it('401s (never 500s) when the fetch rejects', async () => {
    const jwks = jwksStub({ kind: 'reject', error: new TypeError('fetch failed') });
    const verify = verifierWith(jwks);

    const error = await expect401(verify(await signEs256(ours.privateKey)));

    expect(error.status).toBe(401);
    expect(jwks.calls).toEqual([JWKS_URL]);
  });

  it('401s when the endpoint answers with an error status', async () => {
    const jwks = jwksStub({ kind: 'status', status: 503 });
    const verify = verifierWith(jwks);

    await expect401(verify(await signEs256(ours.privateKey)));
  });

  it('401s when the fetch times out', async () => {
    // What an aborted `fetch` actually throws; `jose` turns it into JWKSTimeout.
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const jwks = jwksStub({ kind: 'reject', error: timeout });
    const verify = verifierWith(jwks);

    await expect401(verify(await signEs256(ours.privateKey)));
  });

  it(
    'gives up within its own timeout when the endpoint never answers',
    async () => {
      // Real timers on purpose: `jose` uses `AbortSignal.timeout`, which Node
      // drives from an internal timer that vitest's fake timers do not touch.
      // The cost is one ~5s test; the guarantee is that a dead JWKS endpoint
      // cannot hold a request open indefinitely.
      const jwks = jwksStub({ kind: 'hang' });
      const verify = verifierWith(jwks);

      const startedAt = Date.now();
      await expect401(verify(await signEs256(ours.privateKey)));
      const elapsed = Date.now() - startedAt;

      expect(jwks.lastSignal?.aborted).toBe(true);
      expect(elapsed).toBeLessThan(JWKS_TIMEOUT_MS * 2);
    },
    JWKS_TIMEOUT_MS * 3,
  );
});

describe('createTokenVerifier — what a rejection says', () => {
  it('never puts the token, the secret or a stack trace in the message', async () => {
    const verify = verifierWith(servingOurKey(), { jwtSecret: HS_SECRET });

    const cases = [
      await signHs256(new TextEncoder().encode(`${HS_SECRET}-wrong`)),
      await signEs256(theirs.privateKey),
      unsignedToken(),
      await signEs256(ours.privateKey, { expiresAt: nowSeconds() - 600 }),
      'garbage',
    ];

    for (const candidate of cases) {
      const error = await expect401(verify(candidate));
      const message = error.message;
      expect(message).not.toContain(candidate.slice(0, 16));
      expect(message).not.toContain(HS_SECRET);
      expect(message).not.toMatch(/ at |\.ts:\d|node_modules/);
      // A sentence a signed-out user can act on, not a diagnosis.
      expect(message.length).toBeLessThan(80);
    }
  });

  it('keeps the diagnosis on `detail`, which the error handler logs and never sends', async () => {
    const verify = verifierWith(servingOurKey());

    const error = await expect401(
      verify(await signEs256(ours.privateKey, { expiresAt: nowSeconds() - 600 })),
    );

    expect(error.detail).toContain('JWTExpired');
    expect(error.detail).not.toContain(HS_SECRET);
  });
});

// ------------------------------------------------------------- preHandler ---

describe('bearerToken', () => {
  it('pulls the token out of a well-formed header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it.each([
    ['lower-case scheme', 'bearer abc.def.ghi'],
    ['extra spaces', 'Bearer    abc.def.ghi   '],
  ])('accepts %s', (_label, header) => {
    expect(bearerToken(header)).toBe('abc.def.ghi');
  });

  it.each([
    ['no header', undefined],
    ['blank header', '   '],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['scheme with no token', 'Bearer'],
  ])('401s on %s', (_label, header) => {
    expect(() => bearerToken(header)).toThrow(UnauthorizedError);
  });
});

/** Just enough of a Fastify request for the preHandler. */
function fakeRequest(authorization?: string): {
  headers: { authorization?: string };
  user?: AuthUser;
  supabase?: Client;
} {
  return { headers: authorization === undefined ? {} : { authorization } };
}

describe('createAuthenticate', () => {
  const user: AuthUser = { id: USER_ID, email: USER_EMAIL };

  it('verifies the bearer token and scopes a client to that same token', async () => {
    const seen: string[] = [];
    const client = { marker: 'user-scoped' } as unknown as Client;
    const authenticate = createAuthenticate({
      verifyToken: async (token) => {
        seen.push(token);
        return user;
      },
      createUserClient: (token) => {
        seen.push(`client:${token}`);
        return client;
      },
    });
    const request = fakeRequest('Bearer the-token');

    await authenticate(request as never);

    expect(seen).toEqual(['the-token', 'client:the-token']);
    expect(request.user).toEqual(user);
    expect(request.supabase).toBe(client);
  });

  it('rejects before verifying anything when the header is missing', async () => {
    let verified = false;
    const authenticate = createAuthenticate({
      verifyToken: async () => {
        verified = true;
        return user;
      },
      createUserClient: () => ({}) as unknown as Client,
    });
    const request = fakeRequest();

    await expect401(authenticate(request as never));

    expect(verified).toBe(false);
    expect(request.user).toBeUndefined();
    expect(request.supabase).toBeUndefined();
  });

  it('leaves nothing on the request when the verifier rejects', async () => {
    const jwks = servingOurKey();
    const authenticate = createAuthenticate({
      verifyToken: verifierWith(jwks),
      createUserClient: () => ({}) as unknown as Client,
    });
    const token = await signEs256(theirs.privateKey);
    const request = fakeRequest(`Bearer ${token}`);

    await expect401(authenticate(request as never));

    expect(request.user).toBeUndefined();
    expect(request.supabase).toBeUndefined();
  });

  it('accepts a real ES256 token end to end through the preHandler', async () => {
    const authenticate = createAuthenticate({
      verifyToken: verifierWith(servingOurKey()),
      createUserClient: () => ({}) as unknown as Client,
    });
    const request = fakeRequest(`Bearer ${await signEs256(ours.privateKey)}`);

    await authenticate(request as never);

    expect(request.user).toEqual<AuthUser>({ id: USER_ID, email: USER_EMAIL });
  });
});

describe('requireUser / requireUserClient', () => {
  it('throw rather than serving an unauthenticated request', () => {
    const request = fakeRequest('Bearer whatever');

    expect(() => requireUser(request as never)).toThrow(UnauthorizedError);
    expect(() => requireUserClient(request as never)).toThrow(UnauthorizedError);
  });

  it('return what the preHandler put on the request', () => {
    const client = {} as unknown as Client;
    const request = fakeRequest('Bearer whatever');
    request.user = { id: USER_ID, email: USER_EMAIL };
    request.supabase = client;

    expect(requireUser(request as never)).toEqual({ id: USER_ID, email: USER_EMAIL });
    expect(requireUserClient(request as never)).toBe(client);
  });
});
