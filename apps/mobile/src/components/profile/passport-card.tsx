/**
 * The Profile's passport cover: name, level, home base, member-since, the four
 * lifetime totals and two machine-readable lines that are a joke, not a
 * document.
 *
 * VoiceOver reads the whole cover as one element with one sentence; the globe,
 * the dashed trail and the machine-readable lines are decoration and hidden.
 * Text scales with Dynamic Type up to a cap, so the cover grows taller at
 * large sizes rather than truncating its numbers or bursting out of shape.
 */
import { StyleSheet, Text, View, type TextProps } from 'react-native';
import Svg, { Circle, Ellipse, Line, Path } from 'react-native-svg';

import { Fonts, Spacing } from '@/constants/theme';
import { usePassport } from '@/hooks/use-passport';
import {
  formatCompact,
  formatNumber,
  initialsOf,
  mrzLines,
  type LevelProgress,
} from '@/lib/profile-stats';

/** Past this, a larger text size makes the cover taller but no bigger. */
const COVER_MAX_SCALE = 1.35;

/** The cover's padding and the gap under the brand row: the trail's lane. */
const COVER_PADDING = 18;
const TRAIL_HEIGHT = Spacing.three;
const TRAIL_WIDTH = 170;

export interface PassportData {
  displayName: string;
  level: LevelProgress;
  homeBase: string | null;
  memberSince: string | null;
  flights: number;
  airports: number;
  countries: number;
  miles: number;
}

function CoverText(props: TextProps) {
  return <Text maxFontSizeMultiplier={COVER_MAX_SCALE} {...props} />;
}

export function PassportCard({ data }: { data: PassportData }) {
  const colors = usePassport();
  const [lineOne, lineTwo] = mrzLines(data.displayName, {
    flights: data.flights,
    airports: data.airports,
    countries: data.countries,
    miles: data.miles,
    level: data.level.index,
  });

  const summary =
    `Your FlightBuddy passport. ${data.displayName}. ` +
    `Level ${data.level.index}, ${data.level.name}. ` +
    `Home base ${data.homeBase ?? 'not set yet'}. ` +
    (data.memberSince === null ? '' : `Member since ${data.memberSince}. `) +
    `${formatNumber(data.flights)} ${data.flights === 1 ? 'flight' : 'flights'}, ` +
    `${formatNumber(data.airports)} ${data.airports === 1 ? 'airport' : 'airports'}, ` +
    `${formatNumber(data.countries)} ${data.countries === 1 ? 'country' : 'countries'}, ` +
    `${formatNumber(data.miles)} miles.`;

  const totals: [string, string][] = [
    [formatCompact(data.flights), 'flights'],
    [formatCompact(data.airports), 'airports'],
    [formatCompact(data.countries), 'countries'],
    [formatCompact(data.miles), 'miles'],
  ];

  const label = [styles.label, { color: colors.coverSub }];
  const value = [styles.value, { color: colors.coverInk }];

  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={summary}
      style={[styles.cover, { backgroundColor: colors.cover }]}>
      <Svg
        width={200}
        height={200}
        viewBox="0 0 200 200"
        style={styles.globe}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        <Circle cx={100} cy={100} r={88} fill="none" stroke={colors.coverLine} strokeWidth={1.5} />
        <Ellipse cx={100} cy={100} rx={30} ry={88} fill="none" stroke={colors.coverLine} strokeWidth={1.5} />
        <Ellipse cx={100} cy={100} rx={62} ry={88} fill="none" stroke={colors.coverLine} strokeWidth={1.5} />
        <Line x1={12} y1={100} x2={188} y2={100} stroke={colors.coverLine} strokeWidth={1.5} />
        <Path d="M 24 64 H 176" stroke={colors.coverLine} strokeWidth={1.5} />
        <Path d="M 24 136 H 176" stroke={colors.coverLine} strokeWidth={1.5} />
      </Svg>

      <View style={styles.brand}>
        <CoverText style={[styles.brandText, { color: colors.gold }]}>FLIGHTBUDDY</CoverText>
        <CoverText style={[styles.brandText, { color: colors.gold }]}>PASSPORT</CoverText>
        {/* The dashed trail flies across the top of the globe in the gap under
            this row, so it never runs behind the name, level or dates. Pinned
            to the row's bottom, it follows the row down at larger text sizes. */}
        <Svg
          width={TRAIL_WIDTH}
          height={TRAIL_HEIGHT}
          viewBox={`0 0 ${TRAIL_WIDTH} ${TRAIL_HEIGHT}`}
          style={styles.trail}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants">
          <Path
            d={`M 2 ${TRAIL_HEIGHT - 3} Q ${TRAIL_WIDTH / 2} -4 ${TRAIL_WIDTH + 4} ${TRAIL_HEIGHT - 6}`}
            fill="none"
            stroke={colors.gold}
            strokeWidth={2}
            strokeDasharray="5 6"
            strokeLinecap="round"
            opacity={0.7}
          />
        </Svg>
      </View>

      <View style={styles.identity}>
        <View style={[styles.photo, { backgroundColor: colors.photo }]}>
          <CoverText style={[styles.initials, { color: colors.cover }]} numberOfLines={1}>
            {initialsOf(data.displayName)}
          </CoverText>
        </View>
        <View style={styles.fields}>
          <View style={styles.field}>
            <CoverText style={label}>NAME</CoverText>
            <CoverText style={[value, styles.name]} numberOfLines={2}>
              {data.displayName}
            </CoverText>
          </View>
          <View style={styles.field}>
            <CoverText style={label}>LEVEL</CoverText>
            <CoverText style={value}>
              {data.level.index} · {data.level.name}
            </CoverText>
          </View>
          <View style={styles.pair}>
            <View style={[styles.field, styles.half]}>
              <CoverText style={label}>HOME BASE</CoverText>
              <CoverText style={value}>{data.homeBase ?? '—'}</CoverText>
            </View>
            <View style={[styles.field, styles.half]}>
              <CoverText style={label}>MEMBER SINCE</CoverText>
              <CoverText style={value}>{data.memberSince ?? '—'}</CoverText>
            </View>
          </View>
        </View>
      </View>

      <View style={[styles.totals, { borderTopColor: colors.coverLine }]}>
        {totals.map(([amount, caption]) => (
          <View key={caption} style={styles.total}>
            <CoverText style={[styles.amount, { color: colors.coverInk }]} numberOfLines={1} adjustsFontSizeToFit>
              {amount}
            </CoverText>
            <CoverText style={[styles.caption, { color: colors.coverSub }]} numberOfLines={1}>
              {caption}
            </CoverText>
          </View>
        ))}
      </View>

      <View style={styles.mrz} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {[lineOne, lineTwo].map((line) => (
          <Text
            key={line}
            allowFontScaling={false}
            numberOfLines={1}
            ellipsizeMode="clip"
            style={[styles.mrzLine, { color: colors.coverSub }]}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    position: 'relative',
    overflow: 'hidden',
    gap: Spacing.three,
    padding: COVER_PADDING,
    borderRadius: 22,
  },
  globe: {
    position: 'absolute',
    right: -48,
    top: -36,
  },
  brand: {
    position: 'relative',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  trail: {
    position: 'absolute',
    top: '100%',
    right: -COVER_PADDING,
  },
  brandText: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 11 * 0.18,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
  },
  photo: {
    width: 76,
    height: 92,
    flexShrink: 0,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontFamily: Fonts.rounded,
    fontSize: 30,
    fontWeight: '900',
  },
  fields: {
    flex: 1,
    minWidth: 0,
    gap: Spacing.two,
  },
  pair: {
    flexDirection: 'row',
    gap: 12,
  },
  half: {
    flex: 1,
    minWidth: 0,
  },
  field: {
    gap: 1,
  },
  label: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    letterSpacing: 10 * 0.08,
  },
  value: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '700',
  },
  name: {
    fontSize: 20,
    lineHeight: 24,
  },
  totals: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  total: {
    flex: 1,
    minWidth: 0,
  },
  amount: {
    fontFamily: Fonts.rounded,
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  caption: {
    fontSize: 11,
    lineHeight: 14,
  },
  mrz: {
    overflow: 'hidden',
  },
  mrzLine: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 11 * 0.04,
  },
});
