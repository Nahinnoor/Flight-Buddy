/**
 * Root layout: theme, session, and the route guard.
 *
 * The guard is the only place that decides which half of the app you are in.
 * Signed out, the entry point is the welcome screen; signed in, the dashboard;
 * holding a password-reset session, set-a-new-password and nothing else. It
 * waits for `isLoading` to clear first — redirecting while the stored session
 * is still being read out of the keychain would flash the welcome screen at
 * every returning user, every cold start.
 *
 * Notification taps are handled here too (`use-notification-taps.ts`), under
 * the same session state, so a tap can only ever lead somewhere the guard
 * already allows: the Dashboard when signed in, nowhere (the guard's welcome
 * screen) when not.
 */
import { useEffect, useMemo } from 'react';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useNotificationTaps } from '@/hooks/use-notification-taps';
import { configureNotificationHandler } from '@/lib/push';
import { routeFor } from '@/lib/route-guard';
import { AppearanceProvider, useAppearance } from '@/providers/appearance-provider';
import { SessionProvider, useSession } from '@/providers/session-provider';

void SplashScreen.preventAutoHideAsync();
configureNotificationHandler();

function RootNavigator() {
  const { session, isLoading, isRecovering } = useSession();
  const { isReady: appearanceReady } = useAppearance();
  const segments = useSegments();
  const router = useRouter();
  const signedIn = session !== null;

  useNotificationTaps({ isLoading, signedIn, isRecovering });

  useEffect(() => {
    // The decision itself lives in src/lib/route-guard.ts, where it is tested.
    const target = routeFor({ isLoading, signedIn, isRecovering, segments });
    if (target !== null) router.replace(target);
  }, [signedIn, isLoading, isRecovering, segments, router]);

  // Also held for the stored appearance, so a user who chose Dark on a
  // light-mode phone never sees a light frame first. The route guard does not
  // wait for it: appearance never decides where anyone is allowed to be.
  useEffect(() => {
    if (!isLoading && appearanceReady) void SplashScreen.hideAsync();
  }, [isLoading, appearanceReady]);

  return <Stack screenOptions={{ headerShown: false }} />;
}

/**
 * The navigation theme — headers, the modal sheet's backdrop, the tab screens'
 * background — built from the same tokens as every screen, so a header is
 * never a different white (or black) from the page under it. It follows
 * `useColorScheme`, which the appearance override drives.
 */
function ThemedNavigation({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const value = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    const palette = Colors[scheme];
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: palette.accent,
        background: palette.background,
        card: palette.background,
        text: palette.text,
        border: palette.border,
      },
    };
  }, [scheme]);

  return <ThemeProvider value={value}>{children}</ThemeProvider>;
}

export default function RootLayout() {
  return (
    <AppearanceProvider>
      <ThemedNavigation>
        <SessionProvider>
          <StatusBar style="auto" />
          <RootNavigator />
        </SessionProvider>
      </ThemedNavigation>
    </AppearanceProvider>
  );
}
