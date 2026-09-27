/**
 * Expo push tokens: recognise one, and fingerprint one.
 *
 * A push token is a bearer credential for someone's lock screen (§10, the owner's
 * pre-commit rule): it is never logged, never put in an error message, and never
 * copied into another table. `notification_deliveries.push_token_sha256` holds
 * this fingerprint instead, which is enough for the receipt job to ask "is the
 * token that failed still the one on the profile?" in SQL
 * (`encode(sha256(convert_to(expo_push_token, 'UTF8')), 'hex')`), and useless to
 * anyone who reads it.
 */
import { createHash } from 'node:crypto';

/**
 * `ExponentPushToken[…]` (what `getExpoPushTokenAsync` returns today) or the
 * newer `ExpoPushToken[…]`. The inner part is URL-safe; the bound is generous.
 */
const EXPO_PUSH_TOKEN = /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$/;

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && EXPO_PUSH_TOKEN.test(value);
}

/** Lower-case hex SHA-256 of the token's UTF-8 bytes, matching the SQL above. */
export function pushTokenSha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
