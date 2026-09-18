import {
  AuthApiError,
  AuthPKCECodeVerifierMissingError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
  type Session,
  type User,
} from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthCopy } from '../components/auth/copy';
import { AUTH_REDIRECT_URL } from './auth-links';
import {
  completeAuthLink,
  isUnconfirmedEmailUser,
  isUsableSession,
  mapLinkError,
  mapSignInError,
  mapSignUpError,
  mapUpdatePasswordError,
  requestPasswordReset,
  resendConfirmation,
  signInWithEmail,
  signUpWithEmail,
  updatePassword,
  type EmailAuthClient,
} from './email-auth';

// ------------------------------------------------------------- fixtures --

function user(overrides: Partial<User> = {}, providers: string[] = ['email']): User {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    created_at: '2026-09-18T00:00:00Z',
    email: 'traveller@example.com',
    app_metadata: { provider: providers[0], providers },
    user_metadata: {},
    email_confirmed_at: '2026-09-18T00:05:00Z',
    ...overrides,
  } as User;
}

function session(u: User): Session {
  return {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
    token_type: 'bearer',
    user: u,
  } as Session;
}

const apiError = (code: string, status = 400) => new AuthApiError('server says something revealing', status, code);

/** Every client method, as a spy that fails the test if called unexpectedly. */
function fakeClient(overrides: Partial<Record<keyof EmailAuthClient, unknown>> = {}) {
  const unexpected = (name: string) =>
    vi.fn(() => {
      throw new Error(`unexpected call to ${name}`);
    });
  return {
    signUp: unexpected('signUp'),
    signInWithPassword: unexpected('signInWithPassword'),
    resetPasswordForEmail: unexpected('resetPasswordForEmail'),
    updateUser: unexpected('updateUser'),
    resend: unexpected('resend'),
    signOut: vi.fn(async () => ({ error: null })),
    exchangeCodeForSession: unexpected('exchangeCodeForSession'),
    ...overrides,
  } as unknown as EmailAuthClient & Record<keyof EmailAuthClient, ReturnType<typeof vi.fn>>;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

/** Nothing sensitive may reach a log line, whatever went wrong. */
function expectLogsClean(...secrets: string[]) {
  const logged = warn.mock.calls.flat().map(String).join('\n');
  for (const secret of [...secrets, 'server says something revealing']) {
    expect(logged).not.toContain(secret);
  }
}

// ----------------------------------------------- enumeration-safe mapping --

describe('sign-in error mapping (rule 1: one message)', () => {
  it.each(['invalid_credentials', 'user_not_found', 'validation_failed', 'user_banned', 'unexpected_failure'])(
    'maps %s to the single neutral message',
    (code) => {
      expect(mapSignInError(apiError(code))).toBe(AuthCopy.signInFailed);
    },
  );

  it('gives a wrong password and an unknown address identical copy', () => {
    expect(mapSignInError(apiError('invalid_credentials'))).toBe(
      mapSignInError(apiError('user_not_found')),
    );
  });

  it('may say "too many attempts" — the limit is per IP, not per account', () => {
    expect(mapSignInError(apiError('over_request_rate_limit', 429))).toBe(AuthCopy.tooManyAttempts);
  });

  it('may say "offline" only when no response came back', () => {
    expect(mapSignInError(new AuthRetryableFetchError('Failed to fetch', 0))).toBe(AuthCopy.offline);
    expect(mapSignInError(new TypeError('Network request failed'))).toBe(AuthCopy.offline);
  });

  it('never returns the server message', () => {
    expect(mapSignInError(apiError('anything'))).not.toContain('revealing');
  });
});

describe('sign-up error mapping (rule 3: an existing address looks like success)', () => {
  it.each(['user_already_exists', 'email_exists'])('treats %s as success', (code) => {
    expect(mapSignUpError(apiError(code, 422))).toBeNull();
  });

  it('may talk about the password — it depends on what was typed, not on who exists', () => {
    expect(mapSignUpError(new AuthWeakPasswordError('weak', 422, ['length']))).toBe(AuthCopy.weakPassword);
    expect(mapSignUpError(apiError('weak_password', 422))).toBe(AuthCopy.weakPassword);
  });

  it('may say an address cannot receive mail — that is about the string, not the account', () => {
    expect(mapSignUpError(apiError('email_address_invalid'))).toBe(AuthCopy.addressRejected);
  });

  it.each(['over_email_send_rate_limit', 'email_address_not_authorized', 'signup_disabled', 'unexpected_failure'])(
    'maps %s to the neutral failure',
    (code) => {
      expect(mapSignUpError(apiError(code))).toBe(AuthCopy.signUpFailed);
    },
  );
});

describe('set-new-password error mapping', () => {
  it('explains a reused password', () => {
    expect(mapUpdatePasswordError(apiError('same_password', 422))).toBe(AuthCopy.samePassword);
  });

  it('explains an expired recovery session', () => {
    expect(mapUpdatePasswordError(new AuthSessionMissingError())).toBe(AuthCopy.recoveryExpired);
    expect(mapUpdatePasswordError(apiError('session_not_found', 403))).toBe(AuthCopy.recoveryExpired);
  });

  it('falls back to neutral copy', () => {
    expect(mapUpdatePasswordError(apiError('unexpected_failure', 500))).toBe(AuthCopy.setPasswordFailed);
  });
});

describe('link error mapping', () => {
  it('tells someone on the wrong device what to do', () => {
    expect(mapLinkError(new AuthPKCECodeVerifierMissingError())).toBe(AuthCopy.linkOtherDevice);
  });

  it.each(['flow_state_not_found', 'flow_state_expired', 'otp_expired'])('maps %s to "expired or used"', (code) => {
    expect(mapLinkError(apiError(code, 404))).toBe(AuthCopy.linkExpired);
  });
});

// ----------------------------------------------------------- sign up --

describe('signUpWithEmail', () => {
  const input = { name: '  Sam Rivera ', email: '  Sam@Example.com ', password: 'correct horse' };

  it('sends full_name for the profiles trigger, a normalised address and the app redirect', async () => {
    const client = fakeClient({
      signUp: vi.fn(async () => ({ data: { user: user({ email_confirmed_at: undefined }), session: null }, error: null })),
    });

    await expect(signUpWithEmail(client, input)).resolves.toEqual({ status: 'check-inbox' });
    expect(client.signUp).toHaveBeenCalledWith({
      email: 'sam@example.com',
      password: 'correct horse',
      options: { data: { full_name: 'Sam Rivera' }, emailRedirectTo: AUTH_REDIRECT_URL },
    });
  });

  it('answers a duplicate address (obfuscated user, no identities) exactly like a new one', async () => {
    const fresh = fakeClient({
      signUp: vi.fn(async () => ({ data: { user: user({ email_confirmed_at: undefined }), session: null }, error: null })),
    });
    const duplicate = fakeClient({
      signUp: vi.fn(async () => ({
        data: { user: user({ identities: [], email_confirmed_at: undefined }), session: null },
        error: null,
      })),
    });
    const explicit = fakeClient({
      signUp: vi.fn(async () => ({ data: { user: null, session: null }, error: apiError('user_already_exists', 422) })),
    });

    const results = await Promise.all([
      signUpWithEmail(fresh, input),
      signUpWithEmail(duplicate, input),
      signUpWithEmail(explicit, input),
    ]);
    expect(results).toEqual([{ status: 'check-inbox' }, { status: 'check-inbox' }, { status: 'check-inbox' }]);
  });

  it('refuses a session for an unconfirmed account and clears it', async () => {
    const unconfirmed = user({ email_confirmed_at: undefined, confirmed_at: undefined });
    const client = fakeClient({
      signUp: vi.fn(async () => ({ data: { user: unconfirmed, session: session(unconfirmed) }, error: null })),
    });

    await expect(signUpWithEmail(client, input)).resolves.toEqual({ status: 'check-inbox' });
    expect(client.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('accepts a session only when the account is confirmed (auto-confirm projects)', async () => {
    const confirmed = user();
    const client = fakeClient({
      signUp: vi.fn(async () => ({ data: { user: confirmed, session: session(confirmed) }, error: null })),
    });

    await expect(signUpWithEmail(client, input)).resolves.toEqual({ status: 'signed-in' });
    expect(client.signOut).not.toHaveBeenCalled();
  });

  it('keeps the password and address out of the logs on failure', async () => {
    const client = fakeClient({
      signUp: vi.fn(async () => ({ data: { user: null, session: null }, error: apiError('unexpected_failure', 500) })),
    });

    await expect(signUpWithEmail(client, input)).resolves.toEqual({ status: 'failed', message: AuthCopy.signUpFailed });
    expectLogsClean('correct horse', 'sam@example.com', 'Sam@Example.com');
  });
});

// ----------------------------------------------------------- sign in --

describe('signInWithEmail', () => {
  const input = { email: 'Sam@Example.com', password: 'hunter2hunter2' };

  it('signs in', async () => {
    const confirmed = user();
    const client = fakeClient({
      signInWithPassword: vi.fn(async () => ({ data: { user: confirmed, session: session(confirmed) }, error: null })),
    });
    await expect(signInWithEmail(client, input)).resolves.toEqual({ status: 'signed-in' });
    expect(client.signInWithPassword).toHaveBeenCalledWith({ email: 'sam@example.com', password: 'hunter2hunter2' });
  });

  it('gives a wrong password and an unknown address the same result', async () => {
    const wrongPassword = fakeClient({
      signInWithPassword: vi.fn(async () => ({ data: { user: null, session: null }, error: apiError('invalid_credentials') })),
    });
    const unknown = fakeClient({
      signInWithPassword: vi.fn(async () => ({ data: { user: null, session: null }, error: apiError('user_not_found') })),
    });

    const [a, b] = await Promise.all([signInWithEmail(wrongPassword, input), signInWithEmail(unknown, input)]);
    expect(a).toEqual({ status: 'failed', message: AuthCopy.signInFailed });
    expect(b).toEqual(a);
    expectLogsClean('hunter2hunter2', 'sam@example.com');
  });

  it('sends a correct-password, unconfirmed account to check-inbox', async () => {
    const client = fakeClient({
      signInWithPassword: vi.fn(async () => ({ data: { user: null, session: null }, error: apiError('email_not_confirmed') })),
    });
    await expect(signInWithEmail(client, input)).resolves.toEqual({ status: 'check-inbox' });
  });

  it('refuses a session Supabase hands back for an unconfirmed account', async () => {
    const unconfirmed = user({ email_confirmed_at: undefined, confirmed_at: undefined });
    const client = fakeClient({
      signInWithPassword: vi.fn(async () => ({ data: { user: unconfirmed, session: session(unconfirmed) }, error: null })),
    });
    await expect(signInWithEmail(client, input)).resolves.toEqual({ status: 'check-inbox' });
    expect(client.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('survives a thrown network error', async () => {
    const client = fakeClient({
      signInWithPassword: vi.fn(async () => {
        throw new TypeError('Network request failed');
      }),
    });
    await expect(signInWithEmail(client, input)).resolves.toEqual({ status: 'failed', message: AuthCopy.offline });
  });
});

// ------------------------------------------------------ reset request --

describe('requestPasswordReset (rule 2: always looks sent)', () => {
  it('sends with the app redirect', async () => {
    const client = fakeClient({ resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })) });
    await expect(requestPasswordReset(client, ' Sam@Example.com ')).resolves.toEqual({ status: 'sent' });
    expect(client.resetPasswordForEmail).toHaveBeenCalledWith('sam@example.com', { redirectTo: AUTH_REDIRECT_URL });
  });

  it.each([
    ['user_not_found', 404],
    ['over_email_send_rate_limit', 429],
    ['email_address_not_authorized', 400],
    ['unexpected_failure', 500],
  ])('shows %s as sent — anything the server answered is address-dependent', async (code, status) => {
    const client = fakeClient({
      resetPasswordForEmail: vi.fn(async () => ({ data: null, error: apiError(code, status) })),
    });
    await expect(requestPasswordReset(client, 'sam@example.com')).resolves.toEqual({ status: 'sent' });
    expectLogsClean('sam@example.com');
  });

  it('admits failure only when the request never arrived', async () => {
    const client = fakeClient({
      resetPasswordForEmail: vi.fn(async () => ({ data: null, error: new AuthRetryableFetchError('Failed to fetch', 0) })),
    });
    await expect(requestPasswordReset(client, 'sam@example.com')).resolves.toEqual({
      status: 'failed',
      message: AuthCopy.resetFailed,
    });
  });
});

// --------------------------------------------------- resend / update --

describe('resendConfirmation', () => {
  it('resends a signup confirmation with the app redirect', async () => {
    const client = fakeClient({ resend: vi.fn(async () => ({ data: { user: null, session: null }, error: null })) });
    await expect(resendConfirmation(client, 'Sam@Example.com')).resolves.toEqual({ status: 'sent' });
    expect(client.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'sam@example.com',
      options: { emailRedirectTo: AUTH_REDIRECT_URL },
    });
  });

  it('maps failures to neutral copy', async () => {
    const client = fakeClient({
      resend: vi.fn(async () => ({ data: { user: null, session: null }, error: apiError('over_email_send_rate_limit', 429) })),
    });
    await expect(resendConfirmation(client, 'sam@example.com')).resolves.toEqual({
      status: 'failed',
      message: AuthCopy.resendFailed,
    });
  });
});

describe('updatePassword', () => {
  it('updates', async () => {
    const client = fakeClient({ updateUser: vi.fn(async () => ({ data: { user: user() }, error: null })) });
    await expect(updatePassword(client, 'a new long one')).resolves.toEqual({ status: 'updated' });
    expect(client.updateUser).toHaveBeenCalledWith({ password: 'a new long one' });
  });

  it('never logs the password', async () => {
    const client = fakeClient({
      updateUser: vi.fn(async () => ({ data: { user: null }, error: apiError('same_password', 422) })),
    });
    await expect(updatePassword(client, 'a new long one')).resolves.toEqual({
      status: 'failed',
      message: AuthCopy.samePassword,
    });
    expectLogsClean('a new long one');
  });
});

// ------------------------------------------------------ incoming link --

describe('completeAuthLink', () => {
  const code = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

  it('exchanges a code and reports a confirmation', async () => {
    const confirmed = user();
    const client = fakeClient({
      exchangeCodeForSession: vi.fn(async () => ({
        data: { user: confirmed, session: session(confirmed), redirectType: null },
        error: null,
      })),
    });
    await expect(completeAuthLink(client, { kind: 'code', code, flowId: null })).resolves.toEqual({
      status: 'signed-in',
      purpose: 'confirmation',
    });
    expect(client.exchangeCodeForSession).toHaveBeenCalledWith(code, undefined);
  });

  it('reports recovery from the stored verifier, and passes a flow id through', async () => {
    const confirmed = user();
    const client = fakeClient({
      exchangeCodeForSession: vi.fn(async () => ({
        data: { user: confirmed, session: session(confirmed), redirectType: 'recovery' },
        error: null,
      })),
    });
    await expect(completeAuthLink(client, { kind: 'code', code, flowId: 'flow-1' })).resolves.toEqual({
      status: 'signed-in',
      purpose: 'recovery',
    });
    expect(client.exchangeCodeForSession).toHaveBeenCalledWith(code, { flowId: 'flow-1' });
  });

  it('does not touch the client for an error link or a refused link', async () => {
    const client = fakeClient();
    await expect(completeAuthLink(client, { kind: 'error', errorCode: 'otp_expired' })).resolves.toEqual({
      status: 'failed',
      message: AuthCopy.linkExpired,
    });
    await expect(completeAuthLink(client, { kind: 'rejected' })).resolves.toEqual({
      status: 'failed',
      message: AuthCopy.linkUnrecognised,
    });
    await expect(completeAuthLink(client, { kind: 'empty' })).resolves.toEqual({
      status: 'failed',
      message: AuthCopy.linkUnrecognised,
    });
  });

  it('keeps the code out of the logs when the exchange fails', async () => {
    const client = fakeClient({
      exchangeCodeForSession: vi.fn(async () => ({
        data: { user: null, session: null, redirectType: null },
        error: new AuthPKCECodeVerifierMissingError(),
      })),
    });
    await expect(completeAuthLink(client, { kind: 'code', code, flowId: null })).resolves.toEqual({
      status: 'failed',
      message: AuthCopy.linkOtherDevice,
    });
    expectLogsClean(code);
  });
});

// ---------------------------------------------------- session filter --

describe('isUnconfirmedEmailUser / isUsableSession', () => {
  it('flags an email-only user with no confirmation', () => {
    expect(isUnconfirmedEmailUser(user({ email_confirmed_at: undefined, confirmed_at: undefined }))).toBe(true);
  });

  it('accepts a confirmed email user', () => {
    expect(isUnconfirmedEmailUser(user())).toBe(false);
  });

  it.each([['apple'], ['google'], ['email', 'apple']])(
    'never flags an account with a %s identity (Apple and Google must not regress)',
    (...providers) => {
      const u = user({ email_confirmed_at: undefined, confirmed_at: undefined }, providers);
      expect(isUnconfirmedEmailUser(u)).toBe(false);
      expect(isUsableSession(session(u))).toBe(true);
    },
  );

  it('treats a null session as unusable', () => {
    expect(isUsableSession(null)).toBe(false);
  });
});
