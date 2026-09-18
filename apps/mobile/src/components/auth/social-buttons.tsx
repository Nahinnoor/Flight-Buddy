/**
 * Continue with Apple, Continue with Google.
 *
 * Wired to the real providers through the session provider — the same
 * `signInWithApple` / `signInWithGoogle` in `src/lib/auth.ts` that were the
 * only working auth before email existed. Nothing about how they sign in
 * changed; this file only decides how they look and what a failure says.
 *
 * ## Identical wording, identical size
 *
 * App Store Review guideline 4.8 wants Sign in with Apple offered at least as
 * prominently as any other third-party option. The strongest position is two
 * buttons that are the same in every way a reviewer can see: same height,
 * same width, same corner radius, same phrasing. So both say "Continue with…"
 * (`AppleAuthenticationButtonType.CONTINUE`; there is no logo-only Apple
 * style), and at half width both shrink their label rather than truncate it —
 * Apple's native button does that by itself, and the Google label is told to
 * with `adjustsFontSizeToFit`.
 *
 * ## Failures
 *
 * A cancelled sheet is not an error and shows nothing. Anything else shows one
 * fixed sentence per provider. The provider's or Supabase's own message is
 * never displayed and never logged in full: the log line carries the error's
 * name only.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { isAppleSignInAvailable, isGoogleSignInAvailable, SignInCancelledError } from '@/lib/auth';
import { useSession } from '@/providers/session-provider';

import { AuthCopy } from './copy';

type Provider = 'apple' | 'google';

const BUTTON_HEIGHT = 50;

function AppleButton({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  const isDark = useColorScheme() === 'dark';

  return (
    // The native button has no disabled state, so the wrapper supplies one:
    // no touches, and it looks inert.
    <View style={disabled ? styles.dimmed : undefined} pointerEvents={disabled ? 'none' : 'auto'}>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={
          isDark
            ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
            : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
        }
        cornerRadius={Spacing.three}
        style={styles.apple}
        onPress={onPress}
      />
    </View>
  );
}

function GoogleButton({
  disabled,
  pending,
  onPress,
}: {
  disabled: boolean;
  pending: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Continue with Google"
      accessibilityState={{ disabled: disabled || pending, busy: pending }}
      disabled={disabled || pending}
      onPress={onPress}
      style={({ pressed }) => [
        styles.google,
        {
          backgroundColor: theme.backgroundElement,
          borderColor: theme.border,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}>
      {pending ? (
        <ActivityIndicator color={theme.text} />
      ) : (
        <ThemedText
          type="default"
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
          style={styles.googleLabel}>
          Continue with Google
        </ThemedText>
      )}
    </Pressable>
  );
}

/**
 * Both providers, in a row (welcome) or a stack (sign-in, sign-up). Renders
 * only the providers this build has; renders nothing if it has neither.
 *
 * `onBusyChange` lets the host screen lock its own form while a provider sheet
 * is up; `onError` hands it the one sentence to show.
 */
export function SocialSignIn({
  layout,
  disabled = false,
  onBusyChange,
  onError,
}: {
  layout: 'row' | 'stack';
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const { signInWithApple, signInWithGoogle } = useSession();
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [pending, setPending] = useState<Provider | null>(null);
  const googleAvailable = isGoogleSignInAvailable();

  useEffect(() => {
    let active = true;
    void isAppleSignInAvailable().then((available) => {
      if (active) setAppleAvailable(available);
    });
    return () => {
      active = false;
    };
  }, []);

  const run = useCallback(
    async (provider: Provider) => {
      onError(null);
      setPending(provider);
      onBusyChange?.(true);
      try {
        await (provider === 'apple' ? signInWithApple() : signInWithGoogle());
        // No navigation: the route guard reacts to the session change.
      } catch (caught) {
        if (caught instanceof SignInCancelledError) return;
        console.warn(
          `[auth] ${provider} sign-in failed (${caught instanceof Error ? caught.name : 'unknown'})`,
        );
        onError(AuthCopy.socialFailed(provider === 'apple' ? 'Apple' : 'Google'));
      } finally {
        setPending(null);
        onBusyChange?.(false);
      }
    },
    [signInWithApple, signInWithGoogle, onBusyChange, onError],
  );

  if (!appleAvailable && !googleAvailable) return null;

  const locked = disabled || pending !== null;
  const apple = appleAvailable ? (
    <AppleButton disabled={locked} onPress={() => void run('apple')} />
  ) : null;
  const google = googleAvailable ? (
    <GoogleButton
      disabled={disabled || pending === 'apple'}
      pending={pending === 'google'}
      onPress={() => void run('google')}
    />
  ) : null;

  if (layout === 'stack') {
    return (
      <View style={styles.stack}>
        {apple}
        {google}
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {apple !== null ? <View style={styles.half}>{apple}</View> : null}
      {google !== null ? <View style={styles.half}>{google}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  half: {
    flex: 1,
  },
  apple: {
    height: BUTTON_HEIGHT,
    width: '100%',
  },
  dimmed: {
    opacity: 0.4,
  },
  google: {
    height: BUTTON_HEIGHT,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
  },
  googleLabel: {
    fontWeight: '600',
  },
});
