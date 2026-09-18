/**
 * The email address typed on one auth screen, carried to the next.
 *
 * What is typed on sign-up is the address "check your inbox" names and
 * resends to; what is typed on sign-in pre-fills "forgot password". It lives
 * in memory in the `(auth)` layout, not in a route param, so the address never
 * becomes part of a URL (route params are URL query strings under
 * expo-router) and is gone the moment the user leaves the signed-out screens.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface AuthDraft {
  email: string;
  setEmail: (email: string) => void;
}

const AuthDraftContext = createContext<AuthDraft | null>(null);

export function AuthDraftProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState('');
  const value = useMemo(() => ({ email, setEmail }), [email]);
  return <AuthDraftContext.Provider value={value}>{children}</AuthDraftContext.Provider>;
}

export function useAuthDraft(): AuthDraft {
  const value = useContext(AuthDraftContext);
  if (value === null) throw new Error('useAuthDraft must be used inside <AuthDraftProvider>');
  return value;
}
