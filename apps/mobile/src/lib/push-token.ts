/**
 * Push-token helpers with no native dependencies, so they are testable.
 *
 * A push token is a bearer credential for someone's lock screen (§10): it is
 * never logged, never shown, never put in an error. Failure *reasons* from
 * registration are reduced here to short fixed codes — a Postgres SQLSTATE, a
 * PostgREST code, or an error class name — because a raw `error.message` from
 * the network layer, the database or a native module is free text that could
 * one day quote the value it choked on.
 *
 * Relative imports only: vitest runs this file without the app's `@/` alias.
 */

/**
 * `ExponentPushToken[…]` (what `getExpoPushTokenAsync` returns today) or the
 * newer `ExpoPushToken[…]`. The same shape the worker and the database accept
 * (services/poller/src/push/tokens.ts, `public.register_push_token`).
 */
const EXPO_PUSH_TOKEN = /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$/;

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && EXPO_PUSH_TOKEN.test(value);
}

/** SQLSTATE (`22023`) or PostgREST (`PGRST202`) codes: fixed vocabularies, no data. */
const SAFE_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;
/** `TypeError`, `AbortError`, `TimeoutError`: a class name, not a message. */
const SAFE_NAME = /^[A-Za-z]{1,40}$/;

/** A PostgREST/RPC error, reduced to its code. The message is never read. */
export function safeRpcFailure(error: { code?: unknown } | null | undefined): string {
  const code = error?.code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? `rpc:${code}` : 'rpc:error';
}

/** Anything thrown, reduced to its class name. The message is never read. */
export function safeThrownFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : null;
  return name !== null && SAFE_NAME.test(name) ? `thrown:${name}` : 'thrown:unknown';
}
