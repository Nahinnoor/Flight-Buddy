/**
 * Email and password auth: sign up, sign in, reset, set a new password,
 * resend, and completing an incoming email link.
 *
 * Every function takes the auth client as an argument rather than importing
 * `supabase.ts`, so this file has no React Native in its import graph and the
 * enumeration-safe error mapping — the part of this that must not regress — is
 * tested directly (`email-auth.test.ts`). `auth.ts` binds the real client.
 *
 * ## What leaves this file
 *
 * A result object with either a status or one string from `AuthCopy`. Never a
 * Supabase error, never its message: those sometimes name the account state
 * ("User already registered", "Email not confirmed") and they are the thing
 * the rules in `copy.ts` exist to keep off the screen. Logging is limited to
 * the error `code` and HTTP status — no address, no password, no token, no
 * link `code`, no message text.
 */
import {
  isAuthError,
  isAuthPKCECodeVerifierMissingError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  isAuthWeakPasswordError,
  type Session,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';

import { AuthCopy } from '../components/auth/copy';
import { AUTH_REDIRECT_URL, type AuthLink } from './auth-links';

/** The slice of `supabase.auth` this file uses. A fake satisfies it in tests. */
export type EmailAuthClient = Pick<
  SupabaseClient['auth'],
  | 'signUp'
  | 'signInWithPassword'
  | 'resetPasswordForEmail'
  | 'updateUser'
  | 'resend'
  | 'signOut'
  | 'exchangeCodeForSession'
>;

export type Failure = { status: 'failed'; message: string };

export type SignUpResult = { status: 'check-inbox' } | { status: 'signed-in' } | Failure;
export type SignInResult = { status: 'signed-in' } | { status: 'check-inbox' } | Failure;
export type ResetResult = { status: 'sent' } | Failure;
export type ResendResult = { status: 'sent' } | Failure;
export type UpdatePasswordResult = { status: 'updated' } | Failure;
export type LinkResult =
  | { status: 'signed-in'; purpose: 'recovery' | 'confirmation' }
  | Failure;

// ------------------------------------------------------------ primitives --

/** Normalise before it is sent: iOS autofill and paste both leave spaces. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Supabase error code, if the thing is a Supabase auth error at all. */
function codeOf(error: unknown): string | undefined {
  return isAuthError(error) ? (error.code ?? undefined) : undefined;
}

/**
 * The request never got an HTTP answer. Only this case may say "we could not
 * reach the server", because only here is the outcome independent of the
 * address: the server never saw it.
 */
export function isTransportFailure(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  // auth-js reports a dropped connection as a retryable fetch error with
  // status 0; a plain `TypeError: Network request failed` can also escape.
  if (isAuthError(error)) return error.status === 0;
  return error instanceof TypeError;
}

/** Codes, never messages. See the header. */
function logFailure(operation: string, error: unknown): void {
  const code = codeOf(error) ?? (isTransportFailure(error) ? 'network' : 'unknown');
  const status = isAuthError(error) ? error.status : undefined;
  console.warn(`[auth] ${operation} failed (code=${code}${status !== undefined ? `, status=${status}` : ''})`);
}

/**
 * An email-only account whose address was never confirmed. Such a session
 * must not be treated as signed in, whatever Supabase returned.
 *
 * Scoped to users whose *only* provider is email so that Apple and Google
 * accounts can never trip it: their address is vouched for by the provider,
 * and a false positive here would sign out the only auth that works today.
 */
export function isUnconfirmedEmailUser(user: User | null | undefined): boolean {
  if (user === null || user === undefined) return false;
  const providers = user.app_metadata.providers;
  const emailOnly = Array.isArray(providers)
    ? providers.length > 0 && providers.every((provider) => provider === 'email')
    : user.app_metadata.provider === 'email';
  if (!emailOnly) return false;
  const confirmedAt = user.email_confirmed_at ?? user.confirmed_at;
  return confirmedAt === undefined || confirmedAt === null || confirmedAt === '';
}

export function isUsableSession(session: Session | null): session is Session {
  return session !== null && !isUnconfirmedEmailUser(session.user);
}

/**
 * Drops a session that must not exist. Local scope: it clears this device
 * without a network round-trip, so it cannot fail half-way and leave the
 * session in the keychain.
 */
async function discardSession(client: EmailAuthClient): Promise<void> {
  try {
    await client.signOut({ scope: 'local' });
  } catch (error) {
    logFailure('discard unconfirmed session', error);
  }
}

// ---------------------------------------------------------------- sign up --

/**
 * Rule 3 in `copy.ts`: every path that reached the server and was not a
 * password problem ends at "check your inbox", including an address that is
 * already registered.
 */
export async function signUpWithEmail(
  client: EmailAuthClient,
  input: { name: string; email: string; password: string },
): Promise<SignUpResult> {
  let response: Awaited<ReturnType<EmailAuthClient['signUp']>>;
  try {
    response = await client.signUp({
      email: normaliseEmail(input.email),
      password: input.password,
      options: {
        // Read by `on_auth_user_created` into `profiles.display_name`
        // (supabase/migrations/20260912011737_profiles.sql).
        data: { full_name: input.name.trim() },
        emailRedirectTo: AUTH_REDIRECT_URL,
      },
    });
  } catch (error) {
    const mapped = mapSignUpError(error);
    if (mapped === null) return { status: 'check-inbox' };
    logFailure('sign-up', error);
    return { status: 'failed', message: mapped };
  }

  const { data, error } = response;
  if (error !== null) {
    const mapped = mapSignUpError(error);
    if (mapped === null) return { status: 'check-inbox' };
    logFailure('sign-up', error);
    return { status: 'failed', message: mapped };
  }

  // Confirmation is on: the expected answer is a user and no session. A
  // session here means the project auto-confirms; if the user it belongs to is
  // somehow unconfirmed anyway, it is thrown away rather than used.
  if (data.session !== null) {
    if (isUnconfirmedEmailUser(data.session.user)) {
      await discardSession(client);
      return { status: 'check-inbox' };
    }
    return { status: 'signed-in' };
  }

  // Includes the obfuscated duplicate-address answer (`identities: []`),
  // which deliberately looks the same as a fresh sign-up.
  return { status: 'check-inbox' };
}

/**
 * `null` means "treat as success" — the address already exists, and saying so
 * is the leak. Password-strength failures are safe to show: they depend on
 * what was typed, not on who has an account.
 */
export function mapSignUpError(error: unknown): string | null {
  const code = codeOf(error);
  if (code === 'user_already_exists' || code === 'email_exists') return null;
  if (isAuthWeakPasswordError(error) || code === 'weak_password') return AuthCopy.weakPassword;
  if (code === 'email_address_invalid') return AuthCopy.addressRejected;
  if (isTransportFailure(error)) return AuthCopy.offline;
  return AuthCopy.signUpFailed;
}

// ---------------------------------------------------------------- sign in --

export async function signInWithEmail(
  client: EmailAuthClient,
  input: { email: string; password: string },
): Promise<SignInResult> {
  let response: Awaited<ReturnType<EmailAuthClient['signInWithPassword']>>;
  try {
    response = await client.signInWithPassword({
      email: normaliseEmail(input.email),
      password: input.password,
    });
  } catch (error) {
    logFailure('sign-in', error);
    return { status: 'failed', message: mapSignInError(error) };
  }

  const { data, error } = response;
  if (error !== null) {
    if (codeOf(error) === 'email_not_confirmed') return { status: 'check-inbox' };
    logFailure('sign-in', error);
    return { status: 'failed', message: mapSignInError(error) };
  }

  if (isUnconfirmedEmailUser(data.session?.user ?? data.user)) {
    await discardSession(client);
    return { status: 'check-inbox' };
  }
  return { status: 'signed-in' };
}

/**
 * Rule 1 in `copy.ts`. `email_not_confirmed` never reaches here — the caller
 * routes it to check-inbox, which is safe because Supabase only says it after
 * the password matched.
 */
export function mapSignInError(error: unknown): string {
  const code = codeOf(error);
  if (code === 'over_request_rate_limit') return AuthCopy.tooManyAttempts;
  if (isTransportFailure(error)) return AuthCopy.offline;
  return AuthCopy.signInFailed;
}

// ------------------------------------------------------------ reset / set --

/**
 * Rule 2 in `copy.ts`: anything the server answered, error or not, is shown
 * as "sent". Only a request that never arrived may say otherwise.
 */
export async function requestPasswordReset(
  client: EmailAuthClient,
  email: string,
): Promise<ResetResult> {
  try {
    const { error } = await client.resetPasswordForEmail(normaliseEmail(email), {
      redirectTo: AUTH_REDIRECT_URL,
    });
    if (error !== null) {
      logFailure('reset request', error);
      if (isTransportFailure(error)) return { status: 'failed', message: AuthCopy.resetFailed };
    }
    return { status: 'sent' };
  } catch (error) {
    logFailure('reset request', error);
    if (isTransportFailure(error)) return { status: 'failed', message: AuthCopy.resetFailed };
    return { status: 'sent' };
  }
}

/** Needs the recovery session the reset link created. */
export async function updatePassword(
  client: EmailAuthClient,
  password: string,
): Promise<UpdatePasswordResult> {
  try {
    const { error } = await client.updateUser({ password });
    if (error === null) return { status: 'updated' };
    logFailure('set new password', error);
    return { status: 'failed', message: mapUpdatePasswordError(error) };
  } catch (error) {
    logFailure('set new password', error);
    return { status: 'failed', message: mapUpdatePasswordError(error) };
  }
}

/** Nothing here is about whether an account exists: the caller holds its session. */
export function mapUpdatePasswordError(error: unknown): string {
  const code = codeOf(error);
  if (code === 'same_password') return AuthCopy.samePassword;
  if (isAuthWeakPasswordError(error) || code === 'weak_password') return AuthCopy.weakPassword;
  if (
    isAuthSessionMissingError(error) ||
    code === 'session_not_found' ||
    code === 'session_expired' ||
    code === 'reauthentication_needed'
  ) {
    return AuthCopy.recoveryExpired;
  }
  if (isTransportFailure(error)) return AuthCopy.offline;
  return AuthCopy.setPasswordFailed;
}

// ----------------------------------------------------------------- resend --

export async function resendConfirmation(
  client: EmailAuthClient,
  email: string,
): Promise<ResendResult> {
  try {
    const { error } = await client.resend({
      type: 'signup',
      email: normaliseEmail(email),
      options: { emailRedirectTo: AUTH_REDIRECT_URL },
    });
    if (error === null) return { status: 'sent' };
    logFailure('resend confirmation', error);
    return {
      status: 'failed',
      message: isTransportFailure(error) ? AuthCopy.offline : AuthCopy.resendFailed,
    };
  } catch (error) {
    logFailure('resend confirmation', error);
    return {
      status: 'failed',
      message: isTransportFailure(error) ? AuthCopy.offline : AuthCopy.resendFailed,
    };
  }
}

// ---------------------------------------------------------- incoming link --

/**
 * Turns a parsed link into a session. Whether it was a reset or a
 * confirmation comes from the *stored verifier* (auth-js suffixes a recovery
 * verifier with `/recovery` and returns it as `redirectType`), never from the
 * URL, so a link cannot talk its way onto the set-a-new-password screen.
 */
export async function completeAuthLink(
  client: EmailAuthClient,
  link: AuthLink,
): Promise<LinkResult> {
  if (link.kind === 'error') {
    console.warn(`[auth] link returned an error (code=${link.errorCode ?? 'none'})`);
    return { status: 'failed', message: AuthCopy.linkExpired };
  }
  if (link.kind !== 'code') {
    console.warn(`[auth] link refused (${link.kind})`);
    return { status: 'failed', message: AuthCopy.linkUnrecognised };
  }

  try {
    const { data, error } = await client.exchangeCodeForSession(
      link.code,
      link.flowId !== null ? { flowId: link.flowId } : undefined,
    );
    if (error !== null) {
      logFailure('link exchange', error);
      return { status: 'failed', message: mapLinkError(error) };
    }
    if (isUnconfirmedEmailUser(data.session.user)) {
      await discardSession(client);
      return { status: 'failed', message: AuthCopy.linkExpired };
    }
    return { status: 'signed-in', purpose: redirectTypeOf(data) === 'recovery' ? 'recovery' : 'confirmation' };
  } catch (error) {
    logFailure('link exchange', error);
    return { status: 'failed', message: mapLinkError(error) };
  }
}

/**
 * auth-js 2.116 returns `redirectType` from `exchangeCodeForSession` at
 * runtime (`'recovery'` when the stored verifier was a reset's) but leaves it
 * out of the declared `AuthTokenResponse` type, so it is read defensively.
 * The session provider does not depend on this: it keys recovery off the
 * PASSWORD_RECOVERY event, which auth-js derives from the same verifier.
 */
function redirectTypeOf(data: object): string | null {
  const value = (data as { redirectType?: unknown }).redirectType;
  return typeof value === 'string' ? value : null;
}

export function mapLinkError(error: unknown): string {
  if (isAuthPKCECodeVerifierMissingError(error)) return AuthCopy.linkOtherDevice;
  const code = codeOf(error);
  if (code === 'bad_code_verifier') return AuthCopy.linkOtherDevice;
  if (isTransportFailure(error)) return AuthCopy.offline;
  // flow_state_not_found, flow_state_expired, otp_expired, validation_failed…
  return AuthCopy.linkExpired;
}
