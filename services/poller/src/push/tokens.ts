/**
 * Expo push tokens: recognise one, and fingerprint one.
 *
 * A push token is a bearer credential for someone's lock screen (§10, the owner's
 * pre-commit rule): it is never logged, never put in an error message, and never
 * copied into another table. `notification_device_sends.token_sha256` (and the
 * delivery's representative `push_token_sha256`) hold this fingerprint instead,
 * which equals `push_tokens.token_sha256` and lets the receipt job invalidate the
 * one device that failed, and is useless to anyone who reads it.
 */
import { createHash } from 'node:crypto';

/**
 * `ExponentPushToken[…]` (what `getExpoPushTokenAsync` returns today) or the
 * newer `ExpoPushToken[…]`. The inner part is URL-safe; the bound is generous.
 */
const EXPO_PUSH_TOKEN = /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$/;

/**
 * True for a well-formed Expo push token. Checked before any token goes into a
 * message, by `push-send` and by the operator push.
 */
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && EXPO_PUSH_TOKEN.test(value);
}

/**
 * Lower-case hex SHA-256 of the token's UTF-8 bytes, the same value as
 * `push_tokens.token_sha256`. Computed from the token actually sent, by
 * `push-send` and the operator push.
 */
export function pushTokenSha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
