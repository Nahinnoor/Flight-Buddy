/**
 * "Flying with friends", this year: who you landed with, and three small
 * insights that each disappear when they have nothing to say. With no group
 * trip this year it is an invitation instead, with a way to the Groups tab.
 *
 * Every name here is someone else's typing, rendered as plain text only.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing, type ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { friendsInsights, plural, type FriendsStats } from '@/lib/profile-stats';

type SymbolName = Extract<SymbolViewProps['name'], string>;

/** Faces shown before the rest collapse into "+N". */
const MAX_AVATARS = 5;

const AVATAR_TONES: readonly [ThemeColor, ThemeColor][] = [
  ['avatarOrange', 'onAvatar'],
  ['avatarTeal', 'onAvatar'],
  ['avatarYellow', 'onAvatar'],
  ['accent', 'onAccent'],
  ['avatarRed', 'onAvatarRed'],
];

export function FriendsHeading() {
  return (
    <View style={styles.heading}>
      <ThemedText style={styles.headingTitle} accessibilityRole="header">
        Flying with friends
      </ThemedText>
      <ThemedText style={styles.headingNote} themeColor="textSecondary">
        This year
      </ThemedText>
    </View>
  );
}

export function FriendsCard({ stats }: { stats: FriendsStats }) {
  const theme = useTheme();
  const shown = stats.buddies.slice(0, MAX_AVATARS);
  const rest = stats.buddies.length - shown.length;
  const insights = friendsInsights(stats);

  const stackLabel =
    shown.map((buddy) => buddy.firstName).join(', ') + (rest > 0 ? ` and ${rest} more` : '');

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <View style={styles.crewRow}>
        <View style={styles.stack} accessible accessibilityRole="image" accessibilityLabel={stackLabel}>
          {shown.map((buddy, i) => {
            const [fill, ink] = AVATAR_TONES[i % AVATAR_TONES.length] as [ThemeColor, ThemeColor];
            return (
              <Avatar
                key={buddy.travelerId}
                text={buddy.initials}
                fill={theme[fill]}
                ink={theme[ink]}
                ring={theme.backgroundElement}
                first={i === 0}
              />
            );
          })}
          {rest > 0 ? (
            <Avatar
              text={`+${rest}`}
              fill={theme.backgroundSelected}
              ink={theme.text}
              ring={theme.backgroundElement}
              first={false}
            />
          ) : null}
        </View>
        <View style={styles.crewText}>
          <ThemedText style={styles.crewTitle}>{plural(stats.buddies.length, 'buddy', 'buddies')}</ThemedText>
          <ThemedText style={styles.detail} themeColor="textSecondary">
            {plural(stats.groupTrips, 'group trip', 'group trips')}
          </ThemedText>
        </View>
      </View>

      {insights.mostInSync !== null ? (
        <Insight icon="person.2.fill" tint="tealText" surface="tealSurface" {...insights.mostInSync} />
      ) : null}
      {insights.welcomeCommittee !== null ? (
        <Insight icon="flag.fill" tint="orangeText" surface="orangeSurface" {...insights.welcomeCommittee} />
      ) : null}
      {insights.longestWait !== null ? (
        <Insight icon="hourglass" tint="yellowText" surface="yellowSurface" {...insights.longestWait} />
      ) : null}
    </View>
  );
}

/** No group trip this year: say what this section is for, and where to start. */
export function FriendsEmpty({ onOpenGroups }: { onOpenGroups: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <ThemedText style={styles.detail} themeColor="textSecondary">
        Fly with your group this year and see who lands in sync with you.
      </ThemedText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go to Groups"
        onPress={onOpenGroups}
        style={({ pressed }) => [
          styles.groupsButton,
          { backgroundColor: theme.accentSurface, opacity: pressed ? 0.7 : 1 },
        ]}>
        <SymbolView name="person.2" tintColor={theme.accent} size={18} fallback={null} />
        <Text style={[styles.groupsButtonText, { color: theme.accent }]}>Go to Groups</Text>
      </Pressable>
    </View>
  );
}

function Avatar({
  text,
  fill,
  ink,
  ring,
  first,
}: {
  text: string;
  fill: string;
  ink: string;
  ring: string;
  first: boolean;
}) {
  return (
    <View style={[styles.avatar, { backgroundColor: fill, borderColor: ring }, !first && styles.overlap]}>
      <Text style={[styles.avatarText, { color: ink }]} allowFontScaling={false} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

function Insight({
  icon,
  tint,
  surface,
  title,
  detail,
}: {
  icon: SymbolName;
  tint: ThemeColor;
  surface: ThemeColor;
  title: string;
  detail: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.insight} accessible accessibilityLabel={`${title}. ${detail}`}>
      <View style={[styles.insightIcon, { backgroundColor: theme[surface] }]}>
        <SymbolView name={icon} tintColor={theme[tint]} size={18} fallback={null} />
      </View>
      <View style={styles.insightText}>
        <ThemedText style={styles.insightTitle}>{title}</ThemedText>
        <ThemedText style={styles.detail} themeColor="textSecondary">
          {detail}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  headingTitle: {
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '700',
  },
  headingNote: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400',
  },
  card: {
    gap: 14,
    padding: Spacing.three,
    borderRadius: 20,
  },
  crewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stack: {
    flexDirection: 'row',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The design overlaps by 10; wide pairs like "MW" then lose their last
  // letter under the next face, so 8, with the letters drawn slightly tighter.
  overlap: {
    marginLeft: -8,
  },
  avatarText: {
    fontFamily: Fonts.rounded,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  crewText: {
    flex: 1,
  },
  crewTitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
  },
  detail: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400',
  },
  insight: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  insightIcon: {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insightText: {
    flex: 1,
    gap: 2,
  },
  insightTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  groupsButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: 22,
  },
  groupsButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
