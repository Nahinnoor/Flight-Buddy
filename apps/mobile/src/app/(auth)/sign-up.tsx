/**
 * Create an account — name, email, password, in the approved variant B
 * arrangement, with Apple and Google below a divider.
 *
 * The name goes to Supabase as `full_name` in the user metadata, which is what
 * the `on_auth_user_created` trigger copies into `profiles.display_name`
 * (supabase/migrations/20260912011737_profiles.sql). No API or schema change.
 *
 * Every outcome that reached the server and was not a password problem lands
 * on "check your inbox" — including an address that already has an account.
 * See `copy.ts`, rule 3.
 */
import { useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { EmailField, NameField, PasswordField } from '@/components/auth/auth-fields';
import { useAuthDraft } from '@/components/auth/auth-draft';
import {
  AuthHero,
  AuthLayout,
  AuthScaffold,
  Divider,
  Notice,
  PrimaryButton,
  TextLink,
} from '@/components/auth/auth-kit';
import { AuthCopy } from '@/components/auth/copy';
import { SocialSignIn } from '@/components/auth/social-buttons';
import {
  isClean,
  validateEmail,
  validateName,
  validateNewPassword,
  type FieldErrors,
} from '@/components/auth/validation';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { signUpWithEmail } from '@/lib/auth';

export default function SignUpScreen() {
  const router = useRouter();
  const { email, setEmail } = useAuthDraft();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  const busy = submitting || socialBusy;

  const onSubmit = async () => {
    if (busy) return;
    const errors = {
      name: validateName(name),
      email: validateEmail(email),
      password: validateNewPassword(password),
    };
    setFieldErrors(errors);
    setSubmitError(null);
    if (!isClean(errors)) return;

    setSubmitting(true);
    const result = await signUpWithEmail({ name, email, password });
    setSubmitting(false);

    if (result.status === 'failed') {
      setSubmitError(result.message);
      return;
    }
    setPassword('');
    // 'signed-in' only happens if the project auto-confirms; the guard takes
    // it from there.
    if (result.status === 'check-inbox') router.replace('/check-inbox');
  };

  return (
    <AuthScaffold>
      <AuthHero title="Create an account" size="compact" />

      <View style={AuthLayout.formStack}>
        <NameField
          value={name}
          onChangeText={setName}
          error={fieldErrors.name}
          editable={!busy}
          onSubmitEditing={() => emailRef.current?.focus()}
        />
        <EmailField
          ref={emailRef}
          value={email}
          onChangeText={setEmail}
          error={fieldErrors.email}
          editable={!busy}
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <PasswordField
          ref={passwordRef}
          purpose="new"
          value={password}
          onChangeText={setPassword}
          error={fieldErrors.password}
          editable={!busy}
          returnKeyType="go"
          onSubmitEditing={() => void onSubmit()}
        />

        {submitError !== null ? <Notice tone="critical">{submitError}</Notice> : null}

        <PrimaryButton
          label="Create account"
          busy={submitting}
          disabled={socialBusy}
          onPress={() => void onSubmit()}
        />
        <ThemedText type="small" themeColor="textSecondary" style={styles.confirmNote}>
          {AuthCopy.confirmRequired}
        </ThemedText>
      </View>

      <Divider />

      <SocialSignIn
        layout="stack"
        disabled={submitting}
        onBusyChange={setSocialBusy}
        onError={setSubmitError}
      />

      <View style={AuthLayout.spacer} />

      <View style={AuthLayout.footer}>
        <ThemedText type="small" themeColor="textSecondary">
          Already have an account?
        </ThemedText>
        <TextLink label="Sign in" onPress={() => router.replace('/sign-in')} />
      </View>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  confirmNote: {
    marginTop: Spacing.half,
  },
});
