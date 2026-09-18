/**
 * Welcome — the signed-out entry point, and the owner's own design.
 *
 * Illustration on top, every control underneath: a main sign-in button, then
 * Apple and Google side by side at equal width, then the sign-up and reset
 * links on one row. Apple and Google sign in directly from here; the route
 * guard moves a successful sign-in into the app.
 *
 * ## Why the halves are not both `flex: 1`
 *
 * A literal 50/50 split fits an iPhone SE today — the controls measure about
 * 260pt against the 323pt an SE's bottom half gives them — but it fits with
 * roughly 27pt to spare, and the first person to raise their text size spends
 * that and then overlaps the artwork. So the controls take their natural
 * height and the illustration takes everything above them. At default text
 * sizes that lands at 55/45 on an SE; when text grows, the artwork gives way
 * instead of the buttons, and it gives way gracefully because it is a
 * `viewBox` and not a fixed height.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AuthScaffold, Notice, PrimaryButton, TextLink } from '@/components/auth/auth-kit';
import { AuthCopy } from '@/components/auth/copy';
import { SocialSignIn } from '@/components/auth/social-buttons';
import { WelcomeArtwork } from '@/components/auth/welcome-artwork';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

export default function WelcomeScreen() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <AuthScaffold contentStyle={styles.content}>
      <View style={styles.art}>
        <WelcomeArtwork />
      </View>

      <View style={styles.controls}>
        <View style={styles.hero}>
          <ThemedText type="subtitle" style={styles.centred}>
            {AuthCopy.productName}
          </ThemedText>
          <ThemedText type="default" themeColor="textSecondary" style={styles.centred}>
            {AuthCopy.tagline}
          </ThemedText>
        </View>

        <PrimaryButton label="Sign in" disabled={busy} onPress={() => router.push('/sign-in')} />

        <SocialSignIn layout="row" onBusyChange={setBusy} onError={setError} />

        {error !== null ? <Notice tone="critical">{error}</Notice> : null}

        <View style={styles.links}>
          <TextLink label="Create an account" onPress={() => router.push('/sign-up')} />
          <ThemedText type="small" themeColor="textSecondary" accessibilityElementsHidden>
            ·
          </ThemedText>
          <TextLink label="Forgot password?" onPress={() => router.push('/forgot-password')} />
        </View>
      </View>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.four,
  },
  art: {
    flex: 1,
    // Never let the drawing squeeze the controls out of reach; below this the
    // scene is not worth showing and the buttons matter more.
    minHeight: 140,
  },
  controls: {
    gap: Spacing.three,
  },
  hero: {
    gap: Spacing.one,
    paddingBottom: Spacing.one,
  },
  centred: {
    textAlign: 'center',
  },
  links: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
  },
});
