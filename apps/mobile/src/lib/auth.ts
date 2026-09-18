/**
 * Every way into the app.
 *
 * Apple and Google are the same shape: get an OIDC ID token from the platform,
 * hand it to `supabase.auth.signInWithIdToken`. No browser redirect, so no
 * deep link and no PKCE state to lose.
 *
 * Email and password (bottom of the file) is the one path that leaves the app
 * and comes back: confirmation and reset links return through
 * `flightbuddy://auth/callback` carrying a PKCE code (see `supabase.ts`).
 */
import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import type { Session } from '@supabase/supabase-js';

import type { AuthLink } from './auth-links';
import * as emailAuth from './email-auth';
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from './env';
import { supabase } from './supabase';

/** Thrown when the user backed out. Callers swallow this — it is not an error. */
export class SignInCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled.');
    this.name = 'SignInCancelledError';
  }
}

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

/** Native modules reject with an `Error` carrying a string `code`. */
function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

// ------------------------------------------------------------------- Apple --

/** Whether to offer the Apple button at all (iOS 13+, and not on web). */
export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  return AppleAuthentication.isAvailableAsync();
}

/**
 * Apple returns the user's name **only on the very first authorisation** for
 * this Apple ID + bundle ID. Every later sign-in has `fullName: null`, and
 * `identityToken` never carries a name claim, so there is exactly one moment in
 * a user's life when this value exists.
 *
 * The `handle_new_user` trigger (supabase/migrations/*_profiles.sql) runs on
 * insert into `auth.users` and reads `raw_user_meta_data ->> 'full_name'`,
 * which for an Apple ID-token sign-in is empty — it falls back to the email
 * prefix, or 'Traveller' for a Hide My Email relay address.
 *
 * `signInWithIdToken` has no `options.data` channel (its only option is
 * `captchaToken`), so the name is written immediately afterwards, in two
 * places: `user_metadata`, so it is there for anything reading the JWT later,
 * and `profiles.display_name`, because the trigger has already run and will not
 * run again.
 *
 * Missing name is never written: overwriting a good name with `null` on the
 * second sign-in is exactly the bug this guards against.
 */
function joinAppleName(fullName: AppleAuthentication.AppleAuthenticationFullName | null): string | null {
  if (fullName === null) return null;
  const joined = [fullName.givenName, fullName.familyName]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .trim();
  return joined === '' ? null : joined;
}

async function persistDisplayName(userId: string, displayName: string): Promise<void> {
  // Best effort on both. A name is cosmetic; failing to store it must never
  // turn a successful sign-in into a failed one.
  const { error: metadataError } = await supabase.auth.updateUser({
    data: { full_name: displayName },
  });
  if (metadataError !== null) {
    console.warn('[auth] could not store full_name in user metadata', metadataError.message);
  }

  const { error: profileError } = await supabase
    .from('profiles')
    .update({ display_name: displayName })
    .eq('id', userId);
  if (profileError !== null) {
    console.warn('[auth] could not update profiles.display_name', profileError.message);
  }
}

export async function signInWithApple(): Promise<Session> {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (error) {
    if (errorCode(error) === 'ERR_REQUEST_CANCELED') throw new SignInCancelledError();
    throw new SignInError(
      error instanceof Error ? error.message : 'Sign in with Apple failed.',
    );
  }

  const { identityToken } = credential;
  if (identityToken === null) {
    throw new SignInError('Apple did not return an identity token. Try again.');
  }

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: identityToken,
  });
  if (error !== null) throw new SignInError(error.message);
  if (data.session === null) throw new SignInError('Apple sign-in returned no session.');

  const displayName = joinAppleName(credential.fullName);
  if (displayName !== null) {
    await persistDisplayName(data.session.user.id, displayName);
  }

  return data.session;
}

// ------------------------------------------------------------------ Google --

let googleConfigured = false;

/**
 * Idempotent. The **web** client ID is the one Supabase validates the ID
 * token's `aud` against, so it is required even though this is an iOS app; the
 * iOS client ID is what the native SDK presents.
 */
export function configureGoogleSignIn(): void {
  if (googleConfigured) return;
  if (GOOGLE_WEB_CLIENT_ID === undefined) {
    console.warn('[auth] EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is not set; Google sign-in is disabled');
    return;
  }

  GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    scopes: ['openid', 'email', 'profile'],
    // No server-side Google API access is needed; the ID token is the whole
    // point, and offlineAccess would ask for a refresh token nothing consumes.
    offlineAccess: false,
  });
  googleConfigured = true;
}

export function isGoogleSignInAvailable(): boolean {
  return GOOGLE_WEB_CLIENT_ID !== undefined;
}

export async function signInWithGoogle(): Promise<Session> {
  configureGoogleSignIn();
  if (!isGoogleSignInAvailable()) {
    throw new SignInError('Google sign-in is not configured in this build.');
  }

  let idToken: string | null;
  try {
    if (Platform.OS === 'android') {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    }
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) throw new SignInCancelledError();
    idToken = response.data.idToken;
  } catch (error) {
    if (error instanceof SignInCancelledError) throw error;
    if (isErrorWithCode(error)) {
      if (error.code === statusCodes.SIGN_IN_CANCELLED) throw new SignInCancelledError();
      if (error.code === statusCodes.IN_PROGRESS) {
        throw new SignInError('A sign-in is already in progress.');
      }
      if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        throw new SignInError('Google Play services are not available on this device.');
      }
    }
    throw new SignInError(error instanceof Error ? error.message : 'Google sign-in failed.');
  }

  if (idToken === null) {
    throw new SignInError(
      'Google did not return an ID token. Check that the web client ID matches the one in Supabase.',
    );
  }

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'google',
    token: idToken,
  });
  if (error !== null) throw new SignInError(error.message);
  if (data.session === null) throw new SignInError('Google sign-in returned no session.');

  return data.session;
}

// ----------------------------------------------------------------- sign out --

export async function signOut(): Promise<void> {
  // Google first, and never fatally: if the native session is not cleared the
  // next sign-in silently reuses the old account, which reads as a bug.
  try {
    if (googleConfigured) await GoogleSignin.signOut();
  } catch (error) {
    console.warn('[auth] Google sign-out failed', error);
  }

  const { error } = await supabase.auth.signOut();
  if (error !== null) throw new SignInError(error.message);
}

// ----------------------------------------------------- email and password --
//
// The logic, and the enumeration-safe error mapping, live in `email-auth.ts`
// so they can be tested without native modules. These bind the app's client.
// Unlike the Apple and Google functions above, none of these throw on an auth
// failure: each returns a result whose failure branch carries only neutral
// copy from `components/auth/copy.ts`.

export function signUpWithEmail(input: { name: string; email: string; password: string }) {
  return emailAuth.signUpWithEmail(supabase.auth, input);
}

export function signInWithEmail(input: { email: string; password: string }) {
  return emailAuth.signInWithEmail(supabase.auth, input);
}

export function requestPasswordReset(email: string) {
  return emailAuth.requestPasswordReset(supabase.auth, email);
}

export function updatePassword(password: string) {
  return emailAuth.updatePassword(supabase.auth, password);
}

export function resendConfirmation(email: string) {
  return emailAuth.resendConfirmation(supabase.auth, email);
}

export function completeAuthLink(link: AuthLink) {
  return emailAuth.completeAuthLink(supabase.auth, link);
}
