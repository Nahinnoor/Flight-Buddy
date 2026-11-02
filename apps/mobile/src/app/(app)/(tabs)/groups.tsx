/**
 * Groups tab: every group the user is in or has asked to join.
 *
 * Active groups first (soonest departure first, same countdown as the
 * dashboard), then pending requests, marked "Waiting for approval". Creating
 * a group, joining with a code and owner approval are Phase 3 and have no API
 * yet, so both actions are shown — so the feature is discoverable — but are
 * disabled and labelled "Coming soon". Cards are not tappable: the group page
 * (§3.6) is Phase 3 too.
 */
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';

import { TAB_SCREEN_BOTTOM_INSET } from '@/components/app-tab-bar';
import { GroupCard } from '@/components/compact-cards';
import { Pill } from '@/components/pill';
import {
  Section,
  SectionEmpty,
  SectionStatus,
  sectionState,
} from '@/components/section';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ContentColumn, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useRefreshControl } from '@/hooks/use-refresh-control';
import { useReloadOnFocus } from '@/hooks/use-reload-on-focus';
import { useUserRemote } from '@/hooks/use-remote';
import { useTheme } from '@/hooks/use-theme';
import { groupsTabEntries } from '@/lib/dashboard-model';
import { fetchMyMemberships } from '@/lib/groups';
import { useSession } from '@/providers/session-provider';

export default function GroupsScreen() {
  const { userId } = useSession();
  const now = useNow(30_000);

  const memberships = useUserRemote(userId, fetchMyMemberships, 'Could not load your groups.');
  const { reload } = memberships;

  useReloadOnFocus(reload);
  const refreshControl = useRefreshControl(reload);

  const state = sectionState(memberships.data, memberships.error);
  const entries = memberships.data === null ? [] : groupsTabEntries(memberships.data, now);

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={refreshControl}>
        <View style={styles.inner}>
          <View style={styles.actions}>
            <ComingSoonAction icon="plus.circle" label="Create a group" />
            <ComingSoonAction icon="number" label="Join with a code" />
          </View>

          <Section title="Your groups">
            <SectionStatus remote={memberships} loadingLabel="Loading your groups" />
            {state === 'ready' && entries.length === 0 ? (
              <SectionEmpty>
                You are not in any groups yet. A group follows everyone flying to the same place
                on one screen — creating and joining one arrive in the next update.
              </SectionEmpty>
            ) : null}
            {entries.map((entry) => (
              <GroupCard
                key={entry.membershipId}
                label={entry.label}
                detail={entry.isOwner ? `${entry.detail} · You organise this` : entry.detail}
                emphasis={entry.isCountdown ? 'accent' : 'muted'}
              />
            ))}
          </Section>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

/**
 * A visible, clearly disabled action. It is a disabled button, not plain
 * text, so VoiceOver announces what it will do *and* that it is unavailable.
 */
function ComingSoonAction({
  icon,
  label,
}: {
  icon: Extract<SymbolViewProps['name'], string>;
  label: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Coming soon"
      accessibilityState={{ disabled: true }}
      disabled
      style={[styles.action, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
      <SymbolView name={icon} tintColor={theme.textSecondary} size={22} fallback={null} />
      <ThemedText type="default" themeColor="textSecondary" style={styles.actionLabel}>
        {label}
      </ThemedText>
      <Pill label="Coming soon" tone="neutral" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingBottom: TAB_SCREEN_BOTTOM_INSET,
  },
  inner: {
    ...ContentColumn,
    padding: Spacing.three,
    gap: Spacing.four,
  },
  actions: {
    gap: Spacing.two,
  },
  action: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionLabel: {
    flex: 1,
  },
});
