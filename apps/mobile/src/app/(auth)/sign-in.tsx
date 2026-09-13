/**
 * Sign in.
 *
 * Both buttons do the same thing underneath: get an OIDC ID token from the
 * platform, hand it to Supabase (`src/lib/auth.ts`). No browser, no redirect,
 * so there is no deep link to come back from and nothing to lose if the app is
 * backgrounded mid-flow.
 *
 * Cancelling is not an error and is not reported as one — the user closed a
 * sheet, they know what happened.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as AppleAuthentication from 'expo-apple-authentication';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { isAppleSignInAvailable, isGoogleSignInAvailable, SignInCancelledError } from '@/lib/auth';
import { useSession } from '@/providers/session-provider';

type Provider = 'apple' | 'google';

export default function SignInScreen() {
  const theme = useTheme();
  const isDark = useColorScheme() === 'dark';
  const { signInWithApple, signInWithGoogle } = useSession();

  const [appleAvailable, setAppleAvailable] = useState(false);
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void isAppleSignInAvailable().then((available) => {
      if (active) setAppleAvailable(available);
    });
    return () => {
      active = false;
    };
  }, []);

  const run = useCallback(async (provider: Provider, action: () => Promise<void>) => {
    setError(null);
    setPending(provider);
    try {
      await action();
      // No navigation here: the route guard in src/app/_layout.tsx reacts to
      // the session change. One place decides where you are.
    } catch (caught) {
      if (caught instanceof SignInCancelledError) return;
      setError(caught instanceof Error ? caught.message : 'Sign-in failed. Try again.');
    } finally {
      setPending(null);
    }
  }, []);

  const busy = pending !== null;

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.hero}>
          <ThemedText type="title" style={styles.title}>
            FlightBuddy
          </ThemedText>
          <ThemedText type="default" themeColor="textSecondary" style={styles.subtitle}>
            Every leg of every trip, in one view.
          </ThemedText>
        </View>

        <View style={styles.actions}>
          {appleAvailable ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={
                isDark
                  ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                  : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={Spacing.three}
              style={styles.appleButton}
              onPress={() => void run('apple', signInWithApple)}
            />
          ) : null}

          {isGoogleSignInAvailable() ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign in with Google"
              disabled={busy}
              onPress={() => void run('google', signInWithGoogle)}
              style={({ pressed }) => [
                styles.googleButton,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                  opacity: pressed || busy ? 0.7 : 1,
                },
              ]}>
              {pending === 'google' ? (
                <ActivityIndicator color={theme.text} />
              ) : (
                <ThemedText type="default" style={styles.googleLabel}>
                  Sign in with Google
                </ThemedText>
              )}
            </Pressable>
          ) : null}

          {!appleAvailable && !isGoogleSignInAvailable() ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.centred}>
              {Platform.OS === 'ios'
                ? 'No sign-in provider is configured in this build.'
                : 'FlightBuddy is iOS-only for now.'}
            </ThemedText>
          ) : null}

          {error !== null ? (
            <ThemedText type="small" style={[styles.centred, { color: theme.criticalText }]}>
              {error}
            </ThemedText>
          ) : null}
        </View>

        <ThemedText type="small" themeColor="textSecondary" style={styles.centred}>
          We only use your name and email to show who is on which flight.
        </ThemedText>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    gap: Spacing.four,
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.two,
  },
  title: {
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
  },
  actions: {
    gap: Spacing.three,
  },
  appleButton: {
    height: 50,
    width: '100%',
  },
  googleButton: {
    height: 50,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleLabel: {
    fontWeight: '600',
  },
  centred: {
    textAlign: 'center',
  },
});
