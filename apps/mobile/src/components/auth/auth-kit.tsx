/**
 * The pieces every signed-out screen is built from, so that every one of them
 * shares one idea of what a button, a link and an error look like.
 *
 * Two house rules are enforced here rather than left to each screen:
 *
 * - **No hex values.** Everything resolves through `useTheme()`. The one
 *   non-obvious choice is the primary button's label: it is `theme.background`,
 *   not white. The dark palette's accent (`#67A8FF`) is a light blue, and white
 *   on it lands around 2.3:1 — unreadable. `theme.background` is white on the
 *   light accent and black on the dark one, which clears 6:1 both ways.
 * - **44pt touch targets.** Buttons are 50pt tall; text links are shorter than
 *   that by design, so they carry `hitSlop` to make up the difference.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Link-sized targets are ~20pt of text; this is the rest of the 44. */
const LINK_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const;

/**
 * Screen shell: themed background, keyboard avoidance, a scrollable body.
 *
 * Every one of these screens puts an input near the bottom of a short layout,
 * so the keyboard would otherwise sit on top of the thing being typed into.
 * `padding` on iOS plus a `flexGrow: 1` scroll container is the combination
 * that survives both the short screens (nothing scrolls, content is centred)
 * and the tall ones (content scrolls under a raised keyboard).
 */
export function AuthScaffold({
  children,
  contentStyle,
}: {
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <ThemedView style={styles.fill}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}>
          <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={styles.fill}>
            <View style={[styles.inner, contentStyle]}>{children}</View>
          </SafeAreaView>
        </ScrollView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

export function AuthHero({
  title,
  subtitle,
  size = 'large',
}: {
  title: string;
  subtitle?: string;
  size?: 'large' | 'compact';
}) {
  return (
    <View style={styles.hero}>
      <ThemedText type={size === 'large' ? 'title' : 'subtitle'} style={styles.centred}>
        {title}
      </ThemedText>
      {subtitle !== undefined ? (
        <ThemedText type="default" themeColor="textSecondary" style={styles.centred}>
          {subtitle}
        </ThemedText>
      ) : null}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  busy = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const inert = busy || disabled;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy }}
      disabled={inert}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: theme.accent, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 },
      ]}>
      {busy ? (
        <ActivityIndicator color={theme.background} />
      ) : (
        <ThemedText type="default" style={[styles.buttonLabel, { color: theme.background }]}>
          {label}
        </ThemedText>
      )}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  busy = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const inert = busy || disabled;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy }}
      disabled={inert}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles.bordered,
        {
          backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: theme.border,
          opacity: disabled ? 0.4 : 1,
        },
      ]}>
      {busy ? (
        <ActivityIndicator color={theme.text} />
      ) : (
        <ThemedText type="default" style={styles.buttonLabel}>
          {label}
        </ThemedText>
      )}
    </Pressable>
  );
}

export function TextLink({
  label,
  onPress,
  align = 'center',
  emphasis = 'accent',
}: {
  label: string;
  onPress: () => void;
  align?: 'center' | 'left' | 'right';
  emphasis?: 'accent' | 'muted';
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={LINK_HIT_SLOP}
      onPress={onPress}
      style={({ pressed }) => [{ alignSelf: alignmentOf(align), opacity: pressed ? 0.6 : 1 }]}>
      {/* Not `ThemedText type="linkPrimary"`: that variant hard-codes a blue
          that does not change with the scheme. `theme.accent` does. */}
      <ThemedText
        type="smallBold"
        style={{ color: emphasis === 'accent' ? theme.accent : theme.textSecondary }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

function alignmentOf(align: 'center' | 'left' | 'right') {
  if (align === 'left') return 'flex-start';
  if (align === 'right') return 'flex-end';
  return 'center';
}

/** A hairline with a word in it. `accessibilityElementsHidden` — it is decoration. */
export function Divider({ label = 'or' }: { label?: string }) {
  const theme = useTheme();

  return (
    <View style={styles.divider} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.dividerLine, { backgroundColor: theme.border }]} />
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <View style={[styles.dividerLine, { backgroundColor: theme.border }]} />
    </View>
  );
}

export type NoticeTone = 'critical' | 'neutral' | 'positive';

/**
 * The block a submission failure lands in. `accessibilityLiveRegion` and the
 * `alert` role are what make VoiceOver announce it — a red box that only sighted
 * users notice is half a feature.
 */
export function Notice({ tone, children }: { tone: NoticeTone; children: string }) {
  const theme = useTheme();
  const surface =
    tone === 'critical'
      ? theme.criticalSurface
      : tone === 'positive'
        ? theme.positiveSurface
        : theme.neutralSurface;
  const text =
    tone === 'critical'
      ? theme.criticalText
      : tone === 'positive'
        ? theme.positiveText
        : theme.neutralText;

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.notice, { backgroundColor: surface }]}>
      <ThemedText type="small" style={{ color: text }}>
        {children}
      </ThemedText>
    </View>
  );
}

/** The handful of arrangements the auth screens share. */
export const AuthLayout = StyleSheet.create({
  /** Vertically centred group — the "hero and controls float in the middle" shape. */
  centered: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.four,
  },
  /** A run of fields plus their submit button. */
  formStack: {
    gap: Spacing.three,
  },
  /** Pushes whatever follows it to the bottom of the screen. */
  spacer: {
    flex: 1,
  },
  /** The "already have an account?" pair at the foot of a screen. */
  footer: {
    alignItems: 'center',
    gap: Spacing.two,
  },
  centredText: {
    textAlign: 'center',
  },
});

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  inner: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.four,
    gap: Spacing.four,
  },
  hero: {
    gap: Spacing.two,
  },
  centred: {
    textAlign: 'center',
  },
  button: {
    height: 50,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bordered: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonLabel: {
    fontWeight: '700',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  notice: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
});
