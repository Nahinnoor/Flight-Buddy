/**
 * Forgot password — request a reset link.
 *
 * One field, one button, and a success state that is identical whether or not
 * the address is registered, and whether or not Supabase rate-limited it
 * (`copy.ts`, rule 2; the mapping is `requestPasswordReset` in
 * `src/lib/email-auth.ts`). Only a request that never reached the server says
 * anything else.
 *
 * The confirmation names the address back, which is the only useful thing it
 * can say: it does not confirm the account exists, but it lets someone who
 * typed `sam@gmial.com` notice before they spend ten minutes refreshing.
 *
 * The success state replaces the form rather than sitting under it. Leaving
 * the button live invites the "nothing happened, press it again" loop.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { EmailField } from '@/components/auth/auth-fields';
import { useAuthDraft } from '@/components/auth/auth-draft';
import {
  AuthHero,
  AuthLayout,
  AuthScaffold,
  Notice,
  PrimaryButton,
  TextLink,
} from '@/components/auth/auth-kit';
import { AuthCopy } from '@/components/auth/copy';
import { validateEmail } from '@/components/auth/validation';
import { ThemedText } from '@/components/themed-text';
import { requestPasswordReset } from '@/lib/auth';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const { email, setEmail } = useAuthDraft();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    if (submitting) return;
    const error = validateEmail(email);
    setFieldError(error);
    setSubmitError(null);
    if (error !== undefined) return;

    setSubmitting(true);
    const result = await requestPasswordReset(email);
    setSubmitting(false);

    if (result.status === 'failed') setSubmitError(result.message);
    else setSentTo(email.trim());
  };

  return (
    <AuthScaffold>
      <View style={AuthLayout.centered}>
        <AuthHero title="Reset your password" size="compact" />

        {sentTo !== null ? (
          <View style={AuthLayout.formStack}>
            <Notice tone="positive">{AuthCopy.resetRequested(sentTo)}</Notice>
            <ThemedText type="small" themeColor="textSecondary">
              Open the link on this phone. Nothing after a few minutes? Check your spam folder, then
              try the address you used when you signed up.
            </ThemedText>
            <TextLink label="Use a different address" onPress={() => setSentTo(null)} />
          </View>
        ) : (
          <View style={AuthLayout.formStack}>
            <ThemedText type="default" themeColor="textSecondary">
              Tell us the address on your account and we will send a link to set a new password.
            </ThemedText>

            <EmailField
              value={email}
              onChangeText={setEmail}
              error={fieldError}
              editable={!submitting}
              returnKeyType="send"
              onSubmitEditing={() => void onSubmit()}
            />

            {submitError !== null ? <Notice tone="critical">{submitError}</Notice> : null}

            <PrimaryButton
              label="Send reset link"
              busy={submitting}
              onPress={() => void onSubmit()}
            />
          </View>
        )}
      </View>

      <View style={AuthLayout.footer}>
        <TextLink label="Back to sign in" onPress={() => router.replace('/sign-in')} />
      </View>
    </AuthScaffold>
  );
}
