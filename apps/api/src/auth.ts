/**
 * Supabase JWT verification (§10: verify the JWT on every request).
 *
 * **Asymmetric by default.** This project's `/auth/v1/.well-known/jwks.json`
 * publishes an ES256 key, so tokens are verified against the public JWKS and
 * the API never needs to hold a signing secret. `jose`'s `createRemoteJWKSet`
 * caches the key set and refuses to refetch more often than `cooldownDuration`,
 * so a burst of requests costs one network call, not one per request.
 *
 * **HS256 is a fallback, not an alternative.** Older Supabase projects sign
 * with the shared `SUPABASE_JWT_SECRET`. The verifier picks its key material
 * from the token's own `alg` header, and an HS token with no secret configured
 * is rejected — an unverifiable token is never accepted, whatever it claims.
 *
 * Both paths enforce the same three things: the signature, `aud` =
 * `authenticated`, and expiry (`jose` checks `exp`/`nbf` itself).
 */
import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';

import { UnauthorizedError } from './errors';
import type { Client, UserClientFactory } from './supabase';

/** Supabase stamps this on every access token issued to a signed-in user. */
const AUDIENCE = 'authenticated';
/** Leeway on `exp`/`nbf`: host and Supabase clocks drift by seconds, not minutes. */
const CLOCK_TOLERANCE_SECONDS = 5;

/** Long enough that a burst of adds costs one fetch; short enough to rotate. */
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const JWKS_COOLDOWN_MS = 30 * 1000;
const JWKS_TIMEOUT_MS = 5_000;

/** The caller, as the rest of the API sees them. */
export interface AuthUser {
  /** `auth.users.id` — the `sub` claim, and `profiles.id`. */
  id: string;
  email: string | null;
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

export interface TokenVerifierOptions {
  /** `https://<ref>.supabase.co`. The issuer is this plus `/auth/v1`. */
  supabaseUrl: string;
  /** Legacy HS256 secret. Only consulted for tokens whose `alg` is `HS*`. */
  jwtSecret?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A user-facing reason, chosen so it never describes our own configuration. */
function reasonFor(error: unknown): { message: string; detail: string } {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (error instanceof joseErrors.JWTExpired) {
    return { message: 'Your session has expired. Sign in again.', detail };
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return { message: 'That token is not valid for this API.', detail };
  }
  return { message: 'Your session is not valid. Sign in again.', detail };
}

/**
 * Build a verifier bound to one Supabase project.
 *
 * Call this once per process: the returned function closes over the cached
 * JWKS, and a verifier per request would defeat the cache.
 */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const issuer = `${options.supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    timeoutDuration: JWKS_TIMEOUT_MS,
  });
  const secret =
    options.jwtSecret === undefined ? null : new TextEncoder().encode(options.jwtSecret);

  return async function verifyToken(token: string): Promise<AuthUser> {
    let algorithm: string;
    try {
      algorithm = decodeProtectedHeader(token).alg ?? '';
    } catch (cause) {
      throw new UnauthorizedError('That is not a valid access token.', {
        detail: 'token header is not decodable',
        cause,
      });
    }

    let claims: Record<string, unknown>;
    try {
      if (algorithm.startsWith('HS')) {
        if (secret === null) {
          throw new UnauthorizedError('Your session is not valid. Sign in again.', {
            detail: 'HS-signed token but SUPABASE_JWT_SECRET is not configured',
          });
        }
        const verified = await jwtVerify(token, secret, {
          issuer,
          audience: AUDIENCE,
          algorithms: ['HS256'],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        });
        claims = verified.payload;
      } else {
        const verified = await jwtVerify(token, jwks, {
          issuer,
          audience: AUDIENCE,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        });
        claims = verified.payload;
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      const reason = reasonFor(error);
      throw new UnauthorizedError(reason.message, { detail: reason.detail, cause: error });
    }

    const subject = claims.sub;
    if (typeof subject !== 'string' || !UUID.test(subject)) {
      throw new UnauthorizedError('That token has no user on it.', {
        detail: 'sub claim missing or not a uuid',
      });
    }
    const email = typeof claims.email === 'string' && claims.email !== '' ? claims.email : null;
    return { id: subject, email };
  };
}

/** Pull the bearer token out of an `Authorization` header. */
export function bearerToken(header: string | undefined): string {
  if (header === undefined || header.trim() === '') {
    throw new UnauthorizedError('Sign in and try again.', { detail: 'no Authorization header' });
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (match === null) {
    throw new UnauthorizedError('Sign in and try again.', {
      detail: 'Authorization header is not a bearer token',
    });
  }
  return (match[1] as string).trim();
}

// ------------------------------------------------------- the preHandler ---

/**
 * Everything the authenticated half of the API hangs off one request.
 *
 * `user` is the verified identity. `supabase` is a client bound to that same
 * token, so a handler cannot accidentally read as somebody else: there is no
 * un-scoped client in scope anywhere a route can see (§10).
 */
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    supabase?: Client;
  }
}

export interface AuthenticateDeps {
  verifyToken: TokenVerifier;
  createUserClient: UserClientFactory;
}

/**
 * Build the `preHandler` that guards every `/v1` route.
 *
 * Throws `UnauthorizedError` (401) for a missing, malformed, unverifiable or
 * expired token. It never falls through to an anonymous request: a route that
 * registers this hook is authenticated or it does not run.
 */
export function createAuthenticate(deps: AuthenticateDeps) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const token = bearerToken(request.headers.authorization);
    const user = await deps.verifyToken(token);
    request.user = user;
    request.supabase = deps.createUserClient(token);
  };
}

/**
 * The verified caller. Throws rather than returning `undefined` so a route that
 * forgot the `preHandler` fails loudly instead of serving somebody's data.
 */
export function requireUser(request: FastifyRequest): AuthUser {
  if (request.user === undefined) {
    throw new UnauthorizedError('Sign in and try again.', {
      detail: 'route ran without the authenticate preHandler',
    });
  }
  return request.user;
}

/** The caller's own RLS-scoped Supabase client. Same contract as `requireUser`. */
export function requireUserClient(request: FastifyRequest): Client {
  if (request.supabase === undefined) {
    throw new UnauthorizedError('Sign in and try again.', {
      detail: 'route ran without the authenticate preHandler',
    });
  }
  return request.supabase;
}
