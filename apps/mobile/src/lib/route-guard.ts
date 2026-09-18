/**
 * The routing decision the root layout acts on, as a pure function.
 *
 * It is the only thing deciding which half of the app someone is in, and a
 * mistake here locks the owner out of their own app, so it is pulled out of
 * the component and tested case by case (`route-guard.test.ts`).
 *
 * `segments` is expo-router's `useSegments()`: the first entry is the group
 * (`'(auth)'` or `'(app)'`), the rest is the path inside it.
 */

export type GuardTarget = '/' | '/welcome' | '/set-password';

export interface GuardState {
  isLoading: boolean;
  signedIn: boolean;
  isRecovering: boolean;
  segments: readonly string[];
}

/** Where to go, or `null` to stay put. */
export function routeFor({ isLoading, signedIn, isRecovering, segments }: GuardState): GuardTarget | null {
  // Never decide while the keychain is still being read: a returning user
  // would see the welcome screen flash before their dashboard.
  if (isLoading) return null;

  const inAuthGroup = segments[0] === '(auth)';
  const screen = inAuthGroup ? segments.slice(1).join('/') : null;
  const onSetPassword = screen === 'set-password';

  // A reset link produced a real session. Until a new password is saved, that
  // session only opens one door. (`isRecovering` is only ever true with a
  // session; the provider clears it on sign-out.)
  if (signedIn && isRecovering) return onSetPassword ? null : '/set-password';

  if (!signedIn) {
    // Everything in (auth) is open to a signed-out visitor — including the
    // email-link callback, which is how a signed-out visitor becomes signed
    // in — except set-password, which is meaningless without a session.
    if (inAuthGroup && !onSetPassword) return null;
    return '/welcome';
  }

  // Signed in, not recovering: the signed-out screens are behind you.
  return inAuthGroup ? '/' : null;
}

/** What the email-link callback may do with the code it was opened with. */
export type LinkExchange = 'wait' | 'exchange' | 'skip';

/**
 * Whether `(auth)/auth/callback` may exchange its link's code right now.
 *
 * Exchanging replaces whatever session is on the device — auth-js saves the
 * new one unconditionally. PKCE stops a stranger's link from working on this
 * phone, because the stored verifier will not match, but not a link whose
 * verifier *is* on this phone: sign out, start a sign-up for a second account,
 * sign back in as the first, then tap the second account's confirmation link,
 * and the exchange would silently swap you into the other account. So:
 *
 * - **wait** while the stored session is still being read. On a cold start
 *   from a deep link the callback mounts before the keychain has answered, and
 *   exchanging then would overwrite a session that is about to load.
 * - **exchange** only when signed out — the one case a link exists for.
 * - **skip** whenever a session exists, including a recovery session. The link
 *   is not used; the root guard takes a signed-in user to the dashboard. The
 *   recovery case is skipped too: the only verifier on a device is its most
 *   recent flow's, and the guard allows no new flow to start mid-recovery, so
 *   exchanging there could only ever swap sessions, never help.
 */
export function linkExchangeFor({ isLoading, signedIn }: { isLoading: boolean; signedIn: boolean }): LinkExchange {
  if (isLoading) return 'wait';
  return signedIn ? 'skip' : 'exchange';
}

