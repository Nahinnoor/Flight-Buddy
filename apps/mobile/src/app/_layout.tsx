/**
 * Root layout: theme, session, and the route guard.
 *
 * The guard is the only place that decides which half of the app you are in.
 * It waits for `isLoading` to clear first — redirecting while the stored
 * session is still being read out of the keychain would flash the sign-in
 * screen at every returning user, every cold start.
 */
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { configureNotificationHandler } from '@/lib/push';
import { SessionProvider, useSession } from '@/providers/session-provider';

void SplashScreen.preventAutoHideAsync();
configureNotificationHandler();

function RootNavigator() {
  const { session, isLoading } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === '(auth)';
    if (session === null && !inAuthGroup) {
      router.replace('/sign-in');
    } else if (session !== null && inAuthGroup) {
      router.replace('/');
    }
  }, [session, isLoading, segments, router]);

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
