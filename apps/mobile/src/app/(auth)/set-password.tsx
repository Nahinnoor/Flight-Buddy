/**
 * Set a new password — where a password-reset link lands.
 *
 * By the time this renders, the reset link's PKCE code has been exchanged and
 * the device holds a *recovery* session. That session is real, so the root
 * guard keeps the user here (`isRecovering`) until one of two things happens:
 *
 * - **Saved:** `updateUser({ password })` succeeds, recovery ends, the guard
 *   moves into the app.
 * - **Abandoned:** "Cancel" signs the recovery session out, and the guard
 *   returns to the welcome screen.
 *
 * The account's address is shown in a read-only username field. That is not
 * decoration: iOS only files a new password against the right keychain entry
 * when a `username` field sits next to the `newPassword` one.
 */
import { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

import { EmailField, PasswordField } from '@/components/auth/auth-fields';
import {
  AuthHero,
  AuthLayout,
  AuthScaffold,
  Notice,
  PrimaryButton,
  TextLink,
} from '@/components/auth/auth-kit';
import { AuthCopy } from '@/components/auth/copy';
import { validateNewPassword } from '@/components/auth/validation';
import { updatePassword } from '@/lib/auth';
import { useSession } from '@/providers/session-provider';

export default function SetPasswordScreen() {
  const { session, finishRecovery, cancelRecovery } = useSession();
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  const accountEmail = session?.user.email ?? '';

  const onSubmit = async () => {
    if (submitting) return;
    const error = validateNewPassword(password);
    setFieldError(error);
    setSubmitError(null);
    if (error !== undefined) return;

    setSubmitting(true);
    const result = await updatePassword(password);
    if (result.status === 'failed') {
      setSubmitting(false);
      setSubmitError(result.message);
      return;
    }
    setPassword('');
    // The guard moves into the app once recovery is over.
    await finishRecovery();
  };

  const onCancel = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await cancelRecovery();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthScaffold>
      <View style={AuthLayout.centered}>
        <AuthHero title={AuthCopy.setPasswordTitle} subtitle={AuthCopy.setPasswordIntro} size="compact" />

        <View style={AuthLayout.formStack}>
          {accountEmail !== '' ? (
            <EmailField value={accountEmail} onChangeText={() => undefined} editable={false} />
          ) : null}
          <PasswordField
            ref={passwordRef}
            purpose="new"
            value={password}
            onChangeText={setPassword}
            error={fieldError}
            editable={!submitting}
            returnKeyType="done"
            onSubmitEditing={() => void onSubmit()}
          />

          {submitError !== null ? <Notice tone="critical">{submitError}</Notice> : null}

          <PrimaryButton label="Save password" busy={submitting} onPress={() => void onSubmit()} />
        </View>
      </View>

      <View style={AuthLayout.footer}>
        <TextLink label="Cancel" emphasis="muted" onPress={() => void onCancel()} />
      </View>
    </AuthScaffold>
  );
}
