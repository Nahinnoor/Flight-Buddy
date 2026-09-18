/**
 * Where confirmation and password-reset links land:
 * `flightbuddy://auth/callback?code=…` (the constant is `AUTH_REDIRECT_URL`).
 *
 * The link is read with `useLinkingURL()` — the recommended expo-linking hook
 * in SDK 57 (`useURL` is deprecated) — because it is the raw URL, fragment
 * included, which is where Supabase puts some errors. If the route was reached
 * without one (the router restored it), the router's own search params are
 * used instead.
 *
 * `parseAuthLink` accepts a PKCE code and nothing else (see `auth-links.ts`
 * for why bearer tokens in a link are refused). The code is exchanged exactly
 * once per mount. On success this screen does not navigate: the session
 * change reaches the root guard, which goes to the dashboard for a
 * confirmation or to set-a-new-password for a reset — the reset case is known
 * from the stored PKCE verifier, not from anything in the URL.
 *
 * Nothing from the link is logged or displayed: not the code, not the
 * address, not Supabase's `error_description`.
 *
 * **The code is never exchanged over a live session** (`linkExchangeFor`).
 * An exchange replaces whatever session is on the device, and a link whose
 * PKCE verifier is on this phone — a second account's sign-up, started here
 * earlier — would otherwise swap a signed-in user into that other account
 * without asking. The screen waits until the stored session has been read,
 * exchanges only when signed out, and otherwise leaves the link unused for
 * the root guard to route a signed-in user to the dashboard.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AuthHero, AuthLayout, AuthScaffold, Notice, PrimaryButton } from '@/components/auth/auth-kit';
import { AuthCopy } from '@/components/auth/copy';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { completeAuthLink } from '@/lib/auth';
import { isAuthCallbackUrl, parseAuthLink, urlFromSearchParams } from '@/lib/auth-links';
import { linkExchangeFor } from '@/lib/route-guard';
import { useSession } from '@/providers/session-provider';

export default function AuthCallbackScreen() {
  const theme = useTheme();
  const router = useRouter();
  const linkingUrl = Linking.useLinkingURL();
  const searchParams = useLocalSearchParams();
  const { session, isLoading } = useSession();
  const [failure, setFailure] = useState<string | null>(null);
  /** Codes are single-use: never exchange the same one twice. */
  const handled = useRef<string | null>(null);

  const url =
    linkingUrl !== null && isAuthCallbackUrl(linkingUrl)
      ? linkingUrl
      : urlFromSearchParams(searchParams);

  // Tracked separately from the exchange effect: under StrictMode an effect
  // is mounted, cleaned up and mounted again, and a per-effect "active" flag
  // would cancel the one exchange the `handled` guard lets through.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const exchange = linkExchangeFor({ isLoading, signedIn: session !== null });

  useEffect(() => {
    // Decide nothing until the stored session is known (see the module note).
    if (exchange === 'wait') return;
    if (handled.current === url) return;
    handled.current = url;
    // A live session: leave the link unused. The guard routes to the dashboard.
    if (exchange === 'skip') return;

    void completeAuthLink(parseAuthLink(url)).then((result) => {
      if (!mounted.current) return;
      if (result.status === 'failed') setFailure(result.message);
      // Success: the guard in src/app/_layout.tsx takes it from here.
    });
  }, [url, exchange]);

  return (
    <AuthScaffold>
      <View style={AuthLayout.centered}>
        {failure === null ? (
          <View style={styles.working} accessibilityLiveRegion="polite">
            <ActivityIndicator color={theme.text} />
            <ThemedText type="default" themeColor="textSecondary">
              {AuthCopy.linkWorking}
            </ThemedText>
          </View>
        ) : (
          <View style={AuthLayout.formStack}>
            <AuthHero title="That link did not work" size="compact" />
            <Notice tone="critical">{failure}</Notice>
            <PrimaryButton label="Go to sign in" onPress={() => router.replace('/sign-in')} />
          </View>
        )}
      </View>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  working: {
    alignItems: 'center',
    gap: Spacing.three,
  },
});
