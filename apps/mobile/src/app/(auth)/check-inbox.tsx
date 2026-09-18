/**
 * Check your inbox — after sign-up, and after signing in to an account whose
 * address is not confirmed yet.
 *
 * Confirmation is required, so this screen is not a courtesy. Between here and
 * the confirming tap the account exists and does not work. So it carries three
 * things a generic "we sent you an email" does not:
 *
 * 1. **The address**, spelled out, because a typo here is invisible everywhere
 *    else and the resulting silence looks exactly like a slow mail server.
 * 2. **What does not work yet**, in those words.
 * 3. **A way out that is not resend** — the address was wrong, and no number
 *    of resends will fix that.
 *
 * It never claims a mail *was* sent. For an address that already has a
 * confirmed account, Supabase sends nothing (and says nothing, by design), so
 * the wording is conditional and there is a pointer back to sign-in for the
 * person who already has an account.
 *
 * The resend cooldown mirrors Supabase's default of one confirmation mail per
 * address per 60 seconds; a button that ignores that only produces errors.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useAuthDraft } from '@/components/auth/auth-draft';
import {
  AuthLayout,
  AuthScaffold,
  Notice,
  SecondaryButton,
  TextLink,
} from '@/components/auth/auth-kit';
import { AuthCopy } from '@/components/auth/copy';
import { validateEmail } from '@/components/auth/validation';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { resendConfirmation } from '@/lib/auth';

const RESEND_COOLDOWN_SECONDS = 60;

export default function CheckInboxScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { email } = useAuthDraft();
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const [sending, setSending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Starts counting on arrival: the sign-up that brought us here already sent
  // one, and resending inside the minute is refused by the server anyway.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((left) => Math.max(0, left - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const address = email.trim();
  const hasAddress = address !== '' && validateEmail(address) === undefined;

  const resend = useCallback(async () => {
    if (!hasAddress || sending) return;
    setSending(true);
    setError(null);
    setResent(false);
    const result = await resendConfirmation(address);
    setSending(false);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    if (result.status === 'failed') setError(result.message);
    else setResent(true);
  }, [address, hasAddress, sending]);

  return (
    <AuthScaffold>
      <View style={AuthLayout.centered}>
        <View style={styles.header}>
          <ThemedText type="subtitle" style={AuthLayout.centredText}>
            Check your inbox
          </ThemedText>
          <ThemedText type="default" themeColor="textSecondary" style={AuthLayout.centredText}>
            If this address needs confirming, a link is on its way to
          </ThemedText>
          {/* The address gets its own line and the full text colour: it is the
              one thing on this screen the user has to check. */}
          <ThemedText type="default" style={[AuthLayout.centredText, styles.address]}>
            {hasAddress ? address : 'your email address'}
          </ThemedText>
        </View>

        <View style={[styles.callout, { backgroundColor: theme.warningSurface }]}>
          <ThemedText type="small" style={{ color: theme.warningText }}>
            Your account will not work until you tap that link. You cannot sign in yet. Open it on
            this phone to go straight in.
          </ThemedText>
        </View>

        {error !== null ? <Notice tone="critical">{error}</Notice> : null}
        {resent && error === null ? <Notice tone="positive">{AuthCopy.resent}</Notice> : null}

        <View style={AuthLayout.formStack}>
          <SecondaryButton
            label={cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend the email'}
            busy={sending}
            disabled={cooldown > 0 || !hasAddress}
            onPress={() => void resend()}
          />
          <ThemedText type="small" themeColor="textSecondary" style={AuthLayout.centredText}>
            Nothing yet? Check your spam folder first — confirmation mail lands there often.
          </ThemedText>
        </View>
      </View>

      <View style={AuthLayout.footer}>
        <ThemedText type="small" themeColor="textSecondary" style={AuthLayout.centredText}>
          Wrong address?
        </ThemedText>
        <TextLink label="Sign up with a different email" onPress={() => router.replace('/sign-up')} />
        <ThemedText type="small" themeColor="textSecondary" style={AuthLayout.centredText}>
          Already have an account with this address?
        </ThemedText>
        <TextLink label="Back to sign in" emphasis="muted" onPress={() => router.replace('/sign-in')} />
      </View>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: Spacing.two,
  },
  address: {
    fontWeight: '700',
  },
  callout: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
});
