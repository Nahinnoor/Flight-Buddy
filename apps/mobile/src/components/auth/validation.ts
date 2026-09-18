/**
 * Client-side field validation for the auth screens.
 *
 * This is presentation only: it decides whether to show a red line under a
 * field, nothing more. Supabase is the authority on every one of these rules
 * and re-checks them — a client check is a courtesy to the user, never a
 * control.
 *
 * The email test is deliberately loose. RFC 5322 addresses are far stranger
 * than any regexp people write, and the only test that actually proves an
 * address works is sending mail to it, which is exactly what the confirmation
 * flow does. This rejects typos ("sam@", "sam gmail.com"), not addresses.
 */

/** Matches `x@y.z` with no spaces. Anything past that is the mail server's job. */
const LOOSE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Eight, no composition rules (NIST SP 800-63B shape).
 *
 * **Must match Supabase** (Auth → Providers → Email → Minimum password length),
 * whose default is 6. The two have to agree in the direction that matters:
 * `passwordRules` in `auth-fields.tsx` is built from this number and is what
 * iOS generates a strong password against. If the server demanded *more* than
 * this, iOS could offer — and save to the keychain — a password the server
 * then rejects.
 */
export const MIN_PASSWORD_LENGTH = 8;

export type FieldErrors = Record<string, string | undefined>;

export function validateName(value: string): string | undefined {
  if (value.trim() === '') return 'Enter the name your travel group will see.';
  return undefined;
}

export function validateEmail(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'Enter your email address.';
  if (!LOOSE_EMAIL.test(trimmed)) return 'That does not look like an email address.';
  return undefined;
}

/** Signing in: any non-empty value. Length rules here would leak nothing, but
 * they would also block a legacy password that predates the rule. */
export function validateCurrentPassword(value: string): string | undefined {
  if (value === '') return 'Enter your password.';
  return undefined;
}

export function validateNewPassword(value: string): string | undefined {
  if (value === '') return 'Choose a password.';
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return undefined;
}

/** True when nothing in the map is set. */
export function isClean(errors: FieldErrors): boolean {
  return Object.values(errors).every((message) => message === undefined);
}
