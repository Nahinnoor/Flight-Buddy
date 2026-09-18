/**
 * Root layout: theme, session, and the route guard.
 *
 * The guard is the only place that decides which half of the app you are in.
 * Signed out, the entry point is the welcome screen; signed in, the dashboard;
 * holding a password-reset session, set-a-new-password and nothing else. It
 * waits for `isLoading` to clear first — redirecting while the stored session
 * is still being read out of the keychain would flash the welcome screen at
 * every returning user, every cold start.
 */
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { configureNotificationHandler } from '@/lib/push';
import { routeFor } from '@/lib/route-guard';
import { SessionProvider, useSession } from '@/providers/session-provider';

void SplashScreen.preventAutoHideAsync();
configureNotificationHandler();

function RootNavigator() {
  const { session, isLoading, isRecovering } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const signedIn = session !== null;

  useEffect(() => {
    // The decision itself lives in src/lib/route-guard.ts, where it is tested.
    const target = routeFor({ isLoading, signedIn, isRecovering, segments });
    if (target !== null) router.replace(target);
  }, [signedIn, isLoading, isRecovering, segments, router]);

  useEffect(() => {
    if (!isLoading) void SplashScreen.hideAsync();
  }, [isLoading]);

  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <SessionProvider>
        <StatusBar style="auto" />
        <RootNavigator />
      </SessionProvider>
    </ThemeProvider>
  );
}
