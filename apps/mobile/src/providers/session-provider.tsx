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

import {
  configureGoogleSignIn,
  signInWithApple,
  signInWithGoogle,
  signOut as performSignOut,
} from '@/lib/auth';
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
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

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

  useEffect(() => {
    let active = true;

    configureGoogleSignIn();
    const stopAutoRefresh = startSupabaseAutoRefresh();

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setIsLoading(false);
    });

    // Fires for SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED and USER_UPDATED. The
    // callback only sets state: calling back into supabase from inside it can
    // deadlock the auth client's internal lock.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
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
  }, []);

  const handleApple = useCallback(async () => {
    const next = await signInWithApple();
    setSession(next);
  }, []);

  const handleGoogle = useCallback(async () => {
    const next = await signInWithGoogle();
    setSession(next);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      userId,
      displayName: nameFromSession(session),
      isLoading,
      signInWithApple: handleApple,
      signInWithGoogle: handleGoogle,
      signOut: handleSignOut,
    }),
    [session, userId, isLoading, handleApple, handleGoogle, handleSignOut],
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
