/**
 * The three labelled inputs the auth screens use.
 *
 * They exist as named components rather than as props on one generic field so
 * that the autofill contract lives in exactly one place. That contract is not
 * decoration: iOS only offers the Passwords keychain, only proposes a strong
 * password, and only saves a new credential when `textContentType`,
 * `autoComplete` and `secureTextEntry` line up the way it expects. Get one of
 * them wrong and the screen still looks fine in a screenshot while being
 * miserable on a real phone, which is the exact failure this pass is meant to
 * catch.
 *
 * What each field commits to:
 *
 * | field    | textContentType | autoComplete       | keyboard       |
 * |----------|-----------------|--------------------|----------------|
 * | email    | `username`      | `email`            | email-address  |
 * | password | `password`      | `current-password` | default        |
 * | new pw   | `newPassword`   | `new-password`     | default        |
 *
 * `username` rather than `emailAddress` on the email field is deliberate: it is
 * what pairs the field with the password field into one saveable credential.
 * `emailAddress` fills a contact's address and saves nothing.
 *
 * Labels are real text above the input, never a placeholder standing in for
 * one. A placeholder disappears the moment someone starts typing, which is
 * precisely when a person who paused to think needs to know which box they are
 * in, and it is invisible to a screen reader once filled.
 */
import { useState, type Ref } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { FieldCopy } from './copy';
import { MIN_PASSWORD_LENGTH } from './validation';

/**
 * What iOS generates a suggested strong password against. The minimum comes
 * from the same constant the form validates with. 64 stays under bcrypt's
 * 72-byte limit, which is Supabase's hard ceiling.
 */
const NEW_PASSWORD_RULES = `minlength: ${MIN_PASSWORD_LENGTH}; maxlength: 64;`;

interface SharedFieldProps {
  value: string;
  onChangeText: (value: string) => void;
  error?: string | undefined;
  editable?: boolean;
  onSubmitEditing?: () => void;
  returnKeyType?: TextInputProps['returnKeyType'];
  autoFocus?: boolean;
  ref?: Ref<TextInput>;
}

function FieldShell({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  const theme = useTheme();

  return (
    <View style={styles.field}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {label}
      </ThemedText>
      {children}
      {error !== undefined ? (
        <ThemedText type="small" accessibilityLiveRegion="polite" style={{ color: theme.criticalText }}>
          {error}
        </ThemedText>
      ) : hint !== undefined ? (
        <ThemedText type="small" themeColor="textSecondary">
          {hint}
        </ThemedText>
      ) : null}
    </View>
  );
}

function useInputStyle(error: string | undefined, editable: boolean) {
  const theme = useTheme();
  return [
    styles.input,
    {
      color: theme.text,
      backgroundColor: theme.backgroundElement,
      // The error is carried by the message underneath as well as the border:
      // colour alone is not a signal.
      borderColor: error !== undefined ? theme.criticalText : theme.border,
      // A field that cannot be typed into while a submit is in flight has to
      // look that way. `editable={false}` alone changes nothing on screen, and
      // a live-looking field that swallows keystrokes reads as a broken app.
      opacity: editable ? 1 : 0.5,
    },
  ];
}

export function NameField({
  value,
  onChangeText,
  error,
  editable = true,
  onSubmitEditing,
  returnKeyType = 'next',
  autoFocus,
  ref,
}: SharedFieldProps) {
  const inputStyle = useInputStyle(error, editable);

  return (
    <FieldShell label={FieldCopy.nameLabel} hint={FieldCopy.nameHint} error={error}>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        accessibilityLabel={FieldCopy.nameLabel}
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        autoCorrect={false}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        submitBehavior="submit"
        autoFocus={autoFocus}
        style={inputStyle}
      />
    </FieldShell>
  );
}

export function EmailField({
  value,
  onChangeText,
  error,
  editable = true,
  onSubmitEditing,
  returnKeyType = 'next',
  autoFocus,
  ref,
}: SharedFieldProps) {
  const inputStyle = useInputStyle(error, editable);

  return (
    <FieldShell label={FieldCopy.emailLabel} error={error}>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        accessibilityLabel={FieldCopy.emailLabel}
        keyboardType="email-address"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="email"
        textContentType="username"
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        submitBehavior="submit"
        autoFocus={autoFocus}
        style={inputStyle}
      />
    </FieldShell>
  );
}

export function PasswordField({
  value,
  onChangeText,
  error,
  editable = true,
  onSubmitEditing,
  returnKeyType = 'go',
  purpose,
  ref,
}: SharedFieldProps & { purpose: 'current' | 'new' }) {
  const theme = useTheme();
  const [revealed, setRevealed] = useState(false);
  const inputStyle = useInputStyle(error, editable);
  const isNew = purpose === 'new';
  const label = isNew ? FieldCopy.newPasswordLabel : FieldCopy.passwordLabel;

  return (
    <FieldShell label={label} hint={isNew ? FieldCopy.passwordHint : undefined} error={error}>
      <View style={styles.passwordRow}>
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          editable={editable}
          accessibilityLabel={label}
          secureTextEntry={!revealed}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete={isNew ? 'new-password' : 'current-password'}
          textContentType={isNew ? 'newPassword' : 'password'}
          // Tells iOS what to generate when it offers a strong password. Without
          // it the suggestion can violate a rule the server then rejects, and
          // the user is left with a password their keychain thinks it saved.
          passwordRules={isNew ? NEW_PASSWORD_RULES : undefined}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          submitBehavior="submit"
          style={[inputStyle, styles.passwordInput]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
          disabled={!editable}
          onPress={() => setRevealed((shown) => !shown)}
          style={styles.reveal}>
          <ThemedText type="smallBold" style={{ color: theme.accent, opacity: editable ? 1 : 0.5 }}>
            {revealed ? 'Hide' : 'Show'}
          </ThemedText>
        </Pressable>
      </View>
    </FieldShell>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: Spacing.two,
  },
  input: {
    height: 50,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    fontSize: 17,
  },
  passwordRow: {
    justifyContent: 'center',
  },
  passwordInput: {
    // Room for the reveal button, so a long password never runs under it.
    paddingRight: Spacing.six,
  },
  reveal: {
    position: 'absolute',
    right: 0,
    height: 50,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
