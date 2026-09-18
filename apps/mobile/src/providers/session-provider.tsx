/**
 * The app's one source of truth for "who is signed in".
 *
 * Everything that depends on auth reads this: the route guard in
 * `src/app/_layout.tsx`, the dashboard's queries, and the API client's bearer
 * token (which goes to `supabase.auth` directly, so it cannot go stale relative
 * to what this provider shows).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

import {
  configureGoogleSignIn,
  signInWithApple,
  signInWithGoogle,
  signOut as performSignOut,
} from '@/lib/auth';
import { isUsableSession } from '@/lib/email-auth';
import { registerPushToken } from '@/lib/push';
import { startSupabaseAutoRefresh, supabase } from '@/lib/supabase';

interface SessionContextValue {
  session: Session | null;
  userId: string | null;
  /** Display name from the JWT. `null` until the profile row has one. */
  displayName: string | null;
  /**
   * True only while the stored session is being read back out of the keychain.
   * The route guard must not redirect during this window or a returning user
   * sees the sign-in screen flash before their dashboard.
   */
  isLoading: boolean;
  /**
   * True from the moment a password-reset link is exchanged until a new
   * password is saved (or the reset is abandoned). The session is real while
   * this is true, so the route guard must hold the user on the set-password
   * screen rather than let them into the app on a link alone.
   */
  isRecovering: boolean;
  /** The new password is saved: leave recovery and continue into the app. */
  finishRecovery: () => Promise<void>;
  /** Abandon the reset: sign the recovery session out. */
  cancelRecovery: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Persisted so that killing the app on the set-password screen does not turn
 * the recovery session into an ordinary signed-in one on the next launch.
 * Holds no secret — just "1".
 */
const RECOVERY_FLAG_KEY = 'flightbuddy.recovery-pending';

async function readRecoveryFlag(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(RECOVERY_FLAG_KEY)) === '1';
  } catch {
    return false;
  }
}

async function writeRecoveryFlag(pending: boolean): Promise<void> {
  try {
    if (pending) await SecureStore.setItemAsync(RECOVERY_FLAG_KEY, '1');
    else await SecureStore.deleteItemAsync(RECOVERY_FLAG_KEY);
  } catch (error) {
    console.warn('[auth] could not store the recovery flag', error instanceof Error ? error.name : 'unknown');
  }
}

/**
 * An email account that was never confirmed must not get a working session,
 * whatever Supabase handed back. This is the backstop behind the checks in
 * `email-auth.ts`: whichever path produced the session, the provider refuses
 * it and clears it from the keychain. Signing out is deferred out of the
 * auth-state callback, where calling back into supabase can deadlock.
 */
function acceptSession(next: Session | null): Session | null {
  if (next === null || isUsableSession(next)) return next;
  setTimeout(() => {
    void supabase.auth.signOut({ scope: 'local' });
  }, 0);
  return null;
}

function nameFromSession(session: Session | null): string | null {
  if (session === null) return null;
  const metadata = session.user.user_metadata as Record<string, unknown> | null;
  for (const key of ['full_name', 'name']) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const email = session.user.email;
  return typeof email === 'string' && email !== '' ? email : null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRecovering, setIsRecovering] = useState(false);

  useEffect(() => {
    let active = true;

    configureGoogleSignIn();
    const stopAutoRefresh = startSupabaseAutoRefresh();

    // If the stored session cannot be read (keychain unavailable, corrupt
    // entry), fall through to signed-out rather than holding the splash
    // screen forever: the route guard only leaves it once isLoading is false.
    // Trade-off: a transient read failure also lands on sign-in for a user
    // who has a valid stored session. `session` is deliberately not reset in
    // `catch` — it starts null, so resetting could only discard a real
    // session delivered first by onAuthStateChange.
    Promise.all([supabase.auth.getSession(), readRecoveryFlag()])
      .then(([{ data }, recoveryPending]) => {
        if (!active) return;
        const restored = acceptSession(data.session);
        setSession(restored);
        // A flag without a session is stale (signed out elsewhere, expired).
        if (restored !== null && recoveryPending) setIsRecovering(true);
        else if (recoveryPending) void writeRecoveryFlag(false);
      })
      .catch((error: unknown) => {
        console.warn('[auth] could not restore the stored session', error);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    // Fires for SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED and USER_UPDATED. The
    // callback only sets state: calling back into supabase from inside it can
    // deadlock the auth client's internal lock.
    //
    // PASSWORD_RECOVERY is emitted by `exchangeCodeForSession` when the stored
    // PKCE verifier belongs to a reset, before the call returns — so the
    // session and the recovery flag land in the same render and the guard
    // never sees one without the other.
    const { data: subscription } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return;
      const accepted = acceptSession(next);
      if (event === 'PASSWORD_RECOVERY' && accepted !== null) {
        setIsRecovering(true);
        void writeRecoveryFlag(true);
      } else if (event === 'SIGNED_OUT' || accepted === null) {
        setIsRecovering(false);
        void writeRecoveryFlag(false);
      }
      setSession(accepted);
      setIsLoading(false);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
      stopAutoRefresh();
    };
  }, []);

  // Push registration, once per signed-in user per app run. Keyed on the user
  // id rather than the session object, so a token refresh does not re-prompt.
  const registeredFor = useRef<string | null>(null);
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (userId === null) {
      registeredFor.current = null;
      return;
    }
    if (registeredFor.current === userId) return;
    registeredFor.current = userId;

    void registerPushToken(userId).then((result) => {
      if (result.status !== 'registered') {
        console.log(`[push] token not stored: ${result.status} (${result.reason})`);
      }
    });
  }, [userId]);

  // Rejects when the server revoke fails; the caller decides how to show
  // that. `session` is cleared only on success, because supabase-js keeps the
  // stored session on a network failure and the route guard must agree with it.
  const handleSignOut = useCallback(async () => {
    await performSignOut();
    setSession(null);
    setIsRecovering(false);
    void writeRecoveryFlag(false);
  }, []);

  const finishRecovery = useCallback(async () => {
    await writeRecoveryFlag(false);
    setIsRecovering(false);
  }, []);

  // Local scope: abandoning a reset must work offline, and the recovery
  // session was only ever on this device.
  const cancelRecovery = useCallback(async () => {
    await writeRecoveryFlag(false);
    await supabase.auth.signOut({ scope: 'local' });
    setIsRecovering(false);
    setSession(null);
  }, []);

  const handleApple = useCallback(async () => {
    const next = await signInWithApple();
    setSession(acceptSession(next));
  }, []);

  const handleGoogle = useCallback(async () => {
    const next = await signInWithGoogle();
    setSession(acceptSession(next));
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      userId,
      displayName: nameFromSession(session),
      isLoading,
      isRecovering,
      finishRecovery,
      cancelRecovery,
      signInWithApple: handleApple,
      signInWithGoogle: handleGoogle,
      signOut: handleSignOut,
    }),
    [
      session,
      userId,
      isLoading,
      isRecovering,
      finishRecovery,
      cancelRecovery,
      handleApple,
      handleGoogle,
      handleSignOut,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return value;
}
