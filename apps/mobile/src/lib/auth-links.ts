/**
 * Where Supabase's email links come back into the app, and what the app is
 * willing to accept from them.
 *
 * Pure: no React Native, no Supabase client, so it runs under vitest as-is.
 *
 * ## The redirect URL is a constant, not `Linking.createURL()`
 *
 * `createURL` bakes the Metro host into the URL in a development build
 * (`flightbuddy://192.168.x.y:8081/auth/callback`) and drops it in a release
 * build, so the string differs between dev and production and the owner would
 * have to allowlist a moving target in Supabase. The link has one job — open
 * this app at this route — so it is written out once and allowlisted once.
 *
 * ## Only a PKCE `code` is accepted
 *
 * A Supabase link can carry a session three ways: a PKCE `code`, a
 * `token_hash` for `verifyOtp`, or (implicit flow) the tokens themselves in the
 * fragment. Only the first is bound to this device: exchanging a code needs the
 * verifier this client stored when the flow started. The other two are bearer
 * credentials, and accepting them opens a login-CSRF hole — anyone can mint a
 * magic link *for their own account*, send it to someone, and a tap signs the
 * victim into the attacker's account, where everything the victim then adds
 * (flights, who they travel with) is the attacker's to read. The client is
 * configured for PKCE (`supabase.ts`), so a genuine link from this app never
 * uses the other two forms.
 */

/** The app scheme from `app.json`. */
export const APP_SCHEME = 'flightbuddy';

/**
 * The exact URL Supabase must redirect to after a confirmation or reset link,
 * and the exact entry the owner allowlists under Auth → URL Configuration.
 */
export const AUTH_REDIRECT_URL = `${APP_SCHEME}://auth/callback`;

export type AuthLink =
  /** A PKCE code to exchange. `flowId` is present only if the SDK appended one. */
  | { kind: 'code'; code: string; flowId: string | null }
  /** Supabase redirected with an error (expired, already used, denied). */
  | { kind: 'error'; errorCode: string | null }
  /** Carries a credential form this app refuses (see the header). */
  | { kind: 'rejected' }
  /** Nothing auth-related in it. */
  | { kind: 'empty' };

/**
 * Query and fragment parameters, merged. Supabase puts errors in the fragment
 * on some paths and in the query on others, so both are read. Query wins on a
 * clash, because that is where a PKCE redirect puts its `code`.
 */
export function readLinkParams(url: string): Map<string, string> {
  const params = new Map<string, string>();
  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex + 1);
  const queryIndex = beforeHash.indexOf('?');
  const query = queryIndex === -1 ? '' : beforeHash.slice(queryIndex + 1);

  for (const source of [fragment, query]) {
    for (const [key, value] of splitPairs(source)) params.set(key, value);
  }
  return params;
}

/**
 * `a=1&b=2` → pairs. Written out rather than `URLSearchParams` so the result
 * does not depend on which URL polyfill the JS runtime happens to carry. A
 * malformed escape drops that one pair instead of throwing.
 */
function splitPairs(source: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const part of source.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    try {
      pairs.push([
        decodeURIComponent(rawKey.replace(/\+/g, ' ')),
        decodeURIComponent(rawValue.replace(/\+/g, ' ')),
      ]);
    } catch {
      // Malformed percent-encoding: ignore the pair.
    }
  }
  return pairs;
}

/** Same shape as a Supabase auth code (a UUID today); generous on purpose. */
const PLAUSIBLE_CODE = /^[A-Za-z0-9._~-]{8,512}$/;

/**
 * Supabase's own error codes are short snake_case identifiers (`otp_expired`,
 * `access_denied`). Anything else is not from Supabase and is replaced.
 */
const PLAUSIBLE_ERROR_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * The link's `error_code`, or a fixed placeholder.
 *
 * Anyone can build a `flightbuddy://auth/callback?error_code=…` link, so the
 * value is attacker-chosen, and it is logged. Raw, it could carry a newline
 * that forges a log entry, or text addressed to whoever — or whatever agent —
 * reads the logs. Only an identifier-shaped code passes through.
 */
function safeErrorCode(value: string | undefined): string | null {
  if (value === undefined) return null;
  return PLAUSIBLE_ERROR_CODE.test(value) ? value : 'unrecognized';
}

export function parseAuthLink(url: string): AuthLink {
  const params = readLinkParams(url);

  const error = params.get('error') ?? params.get('error_code');
  if (error !== undefined) {
    return { kind: 'error', errorCode: safeErrorCode(params.get('error_code')) };
  }

  // Bearer forms: refused outright, even alongside a code. A link that mixes
  // the two was not produced by this app's own PKCE flow.
  if (
    params.has('access_token') ||
    params.has('refresh_token') ||
    params.has('token_hash') ||
    params.has('token')
  ) {
    return { kind: 'rejected' };
  }

  const code = params.get('code');
  if (code !== undefined) {
    if (!PLAUSIBLE_CODE.test(code)) return { kind: 'rejected' };
    return { kind: 'code', code, flowId: params.get('sb_flow_id') ?? null };
  }

  return { kind: 'empty' };
}

/**
 * Rebuilds a parseable URL from the router's search params, for the case where
 * the route was reached without a linking URL (the router keeps query params
 * but not the fragment, so only query-borne values survive — which is where a
 * PKCE code is).
 */
export function urlFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single !== 'string') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(single)}`);
  }
  const query = parts.join('&');
  return query === '' ? AUTH_REDIRECT_URL : `${AUTH_REDIRECT_URL}?${query}`;
}

/** Whether a URL is the auth callback at all (scheme + host + path). */
export function isAuthCallbackUrl(url: string): boolean {
  const withoutParams = url.split(/[?#]/, 1)[0] ?? '';
  return withoutParams.replace(/\/+$/, '') === AUTH_REDIRECT_URL;
}
