/**
 * Account (pushed from Profile, by its Edit button or its "Name, email and
 * sign out" row): your name, your email, and sign out. Moved here unchanged
 * from the old Profile tab when Profile became the passport; the full list of
 * past flights moved to the Flight log screen.
 *
 * - **Name** is editable. A save writes `profiles.display_name` and your own
 *   traveller row's `display_name` — the one group members see — under RLS;
 *   see `src/lib/profile.ts` for exactly why both.
 * - **Email** is read-only.
 * - No delete-account control in this pass: deleting needs the service-role
 *   key, which ADR 0001 reserves for `ingestFlight`, so it gets its own ADR in
 *   Phase 3. A destructive button that does not work is worse than none.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';

import { Section, SectionError, SectionLoading, sectionState } from '@/components/section';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useRemote } from '@/hooks/use-remote';
import { useTheme } from '@/hooks/use-theme';
import { checkDisplayName, DISPLAY_NAME_MAX_LENGTH } from '@/lib/display-name';
import { fetchProfile, updateDisplayName, type ProfileView } from '@/lib/profile';
import { useSession } from '@/providers/session-provider';

export default function AccountScreen() {
  const theme = useTheme();
  const { userId, session, signOut } = useSession();

  const profile = useRemote(
    useMemo(() => (userId === null ? null : () => fetchProfile(userId)), [userId]),
    'Could not load your profile.',
  );
  const { reload: reloadProfile } = profile;

  useFocusEffect(
    useCallback(() => {
      void reloadProfile();
    }, [reloadProfile]),
  );

  const [isRefreshing, setIsRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await reloadProfile();
    setIsRefreshing(false);
  }, [reloadProfile]);

  const [isSigningOut, setIsSigningOut] = useState(false);
  // A failed sign-out leaves the session in place (supabase-js only clears it
  // when the server revoke succeeds), so the user must be told, or the button
  // reads as doing nothing.
  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await signOut();
    } catch (caught) {
      Alert.alert(
        'Could not sign out',
        caught instanceof Error ? caught.message : 'Check your connection and try again.',
      );
    } finally {
      setIsSigningOut(false);
    }
  }, [signOut]);

  const profileState = sectionState(profile.data, profile.error);
  const email = profile.data?.email ?? session?.user.email ?? null;

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void onRefresh()}
            tintColor={theme.textSecondary}
          />
        }>
        <View style={styles.inner}>
          <Section title="Your name">
            {profileState === 'loading' ? <SectionLoading label="Loading your profile" /> : null}
            {profileState === 'error' ? (
              <SectionError message={profile.error ?? ''} onRetry={() => void reloadProfile()} />
            ) : null}
            {profileState === 'ready' && profile.data !== null && userId !== null ? (
              // Keyed on the user, not the name: a save reloads the profile,
              // and remounting then would swallow the "Saved." confirmation.
              <NameEditor
                key={userId}
                userId={userId}
                profile={profile.data}
                onSaved={() => void reloadProfile()}
              />
            ) : null}
          </Section>

          <Section title="Email">
            <View
              style={[styles.readOnly, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}
              accessible
              accessibilityLabel={`Email, ${email ?? 'not available'}. Read only.`}>
              <ThemedText type="default" themeColor="textSecondary" selectable>
                {email ?? 'Not available'}
              </ThemedText>
            </View>
          </Section>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            accessibilityState={{ disabled: isSigningOut, busy: isSigningOut }}
            disabled={isSigningOut}
            onPress={() => void handleSignOut()}
            style={({ pressed }) => [
              styles.secondaryButton,
              { borderColor: theme.border, opacity: pressed ? 0.6 : 1 },
            ]}>
            {isSigningOut ? (
              <ActivityIndicator color={theme.text} />
            ) : (
              <ThemedText type="default" style={[styles.buttonLabel, { color: theme.criticalText }]}>
                Sign out
              </ThemedText>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

function NameEditor({
  userId,
  profile,
  onSaved,
}: {
  userId: string;
  profile: ProfileView;
  onSaved: () => void;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState(profile.displayName);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);

  // A success note is momentary; an error stays until the user acts on it.
  useEffect(() => {
    if (message?.tone !== 'ok') return;
    const timer = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  const checked = checkDisplayName(draft);
  const isChanged = checked.ok ? checked.value !== profile.displayName : draft !== profile.displayName;
  const canSave = isChanged && checked.ok && !isSaving;

  const save = useCallback(async () => {
    setIsSaving(true);
    setMessage(null);
    try {
      const stored = await updateDisplayName(userId, draft);
      setDraft(stored);
      setMessage({ tone: 'ok', text: 'Saved.' });
      onSaved();
    } catch (caught) {
      setMessage({
        tone: 'error',
        text: caught instanceof Error ? caught.message : 'Could not save your name.',
      });
    } finally {
      setIsSaving(false);
    }
  }, [draft, onSaved, userId]);

  const showInvalid = isChanged && !checked.ok;

  return (
    <View style={styles.editor}>
      <TextInput
        value={draft}
        onChangeText={(text) => {
          setDraft(text);
          setMessage(null);
        }}
        placeholder="Your name"
        placeholderTextColor={theme.textSecondary}
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        autoCorrect={false}
        maxLength={DISPLAY_NAME_MAX_LENGTH + 10}
        returnKeyType="done"
        onSubmitEditing={() => {
          if (canSave) void save();
        }}
        accessibilityLabel="Display name"
        style={[
          styles.input,
          { color: theme.text, backgroundColor: theme.backgroundElement, borderColor: theme.border },
        ]}
      />
      <ThemedText type="small" themeColor="textSecondary">
        People in your groups see this name next to your flight.
      </ThemedText>

      {showInvalid && !checked.ok ? (
        <ThemedText type="small" style={{ color: theme.criticalText }} accessibilityLiveRegion="polite">
          {checked.reason}
        </ThemedText>
      ) : null}
      {message !== null ? (
        <ThemedText
          type="small"
          accessibilityLiveRegion="polite"
          style={{ color: message.tone === 'error' ? theme.criticalText : theme.positiveText }}>
          {message.text}
        </ThemedText>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save name"
        accessibilityState={{ disabled: !canSave, busy: isSaving }}
        disabled={!canSave}
        onPress={() => void save()}
        style={({ pressed }) => [
          styles.primaryButton,
          { backgroundColor: theme.accent, opacity: !canSave ? 0.4 : pressed ? 0.8 : 1 },
        ]}>
        {isSaving ? (
          <ActivityIndicator color={theme.onAccent} />
        ) : (
          <ThemedText type="default" style={[styles.buttonLabel, { color: theme.onAccent }]}>
            Save name
          </ThemedText>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingBottom: Spacing.five,
  },
  inner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.three,
    gap: Spacing.four,
  },
  editor: {
    gap: Spacing.two,
  },
  input: {
    height: 50,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    fontSize: 17,
  },
  readOnly: {
    minHeight: 50,
    justifyContent: 'center',
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
  },
  primaryButton: {
    height: 50,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    height: 50,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: {
    fontWeight: '700',
  },
});
