/**
 * The frequent-flyer level: where you are on eight levels of lifetime miles,
 * drawn as a climb — solid and filled up to the aircraft, dashed beyond it.
 *
 * The chart is one image to VoiceOver with a sentence that says what it
 * shows; the heading, the miles-to-go line and the level chip above it are
 * read as text. The chart is drawn in a fixed 326 × 136 space (the design's
 * width on a 390 pt phone) and scaled to the card, so its labels do not follow
 * Dynamic Type; everything outside it does.
 */
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Polygon, Polyline, Text as SvgText } from 'react-native-svg';

import { PLANE } from '@/components/auth/welcome-scene';
import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useIllustration } from '@/hooks/use-illustration';
import { useTheme } from '@/hooks/use-theme';
import { formatNumber, LEVELS, type LevelProgress } from '@/lib/profile-stats';

import {
  CHART_BASELINE as BASELINE,
  CHART_HEIGHT as HEIGHT,
  CHART_WIDTH as WIDTH,
  chartGeometry,
  DOTS,
  PLANE_SCALE,
} from '@/components/profile/level-chart-geometry';

const points = (list: readonly (readonly [number, number])[]) =>
  list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

export function LevelCard({ level }: { level: LevelProgress }) {
  const theme = useTheme();
  const art = useIllustration();
  const g = chartGeometry(level);
  const atTop = level.nextName === null;
  const percent = Math.round(level.progress * 100);

  const chartLabel = atTop
    ? `Altitude chart of eight levels. You are at level ${level.index}, ${level.name}, the top level.`
    : `Altitude chart of eight levels. You are at level ${level.index}, ${level.name}, ` +
      `${percent}% of the way to level ${level.index + 1}, ${level.nextName}.`;

  const area = [...g.solid, [g.plane[0], BASELINE] as const, [DOTS[0]?.[0] ?? 16, BASELINE] as const];

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <ThemedText style={styles.title} accessibilityRole="header">
            Frequent flyer level
          </ThemedText>
          <ThemedText style={styles.subtitle} themeColor="textSecondary">
            {atTop || level.milesToNext === null
              ? 'Top level'
              : `${formatNumber(level.milesToNext)} mi to ${level.nextName}`}
          </ThemedText>
        </View>
        <View style={[styles.chip, { backgroundColor: theme.accentSurface }]}>
          <Text style={[styles.chipText, { color: theme.accent }]} maxFontSizeMultiplier={1.5}>
            Level {level.index}
          </Text>
        </View>
      </View>

      <View style={styles.chart} accessible accessibilityRole="image" accessibilityLabel={chartLabel}>
        <Svg width="100%" height="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
          <Line x1={8} y1={BASELINE} x2={WIDTH - 8} y2={BASELINE} stroke={theme.border} strokeWidth={1} />
          <Polygon points={points(area)} fill={theme.accentSurface} />
          <Polyline
            points={points(g.solid)}
            fill="none"
            stroke={theme.accent}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {g.dashed.length > 1 ? (
            <Polyline
              points={points(g.dashed)}
              fill="none"
              stroke={theme.textSecondary}
              strokeWidth={2}
              strokeDasharray="4 5"
              strokeLinecap="round"
            />
          ) : null}
          {DOTS.map(([x, y], i) =>
            i < g.index ? (
              <Circle key={i} cx={x} cy={y} r={4.5} fill={theme.accent} />
            ) : i === g.index ? (
              <Circle
                key={i}
                cx={x}
                cy={y}
                r={6}
                fill={theme.accent}
                stroke={theme.backgroundElement}
                strokeWidth={2.5}
              />
            ) : (
              <Circle
                key={i}
                cx={x}
                cy={y}
                r={4.5}
                fill={theme.backgroundElement}
                stroke={theme.textSecondary}
                strokeWidth={2}
              />
            ),
          )}
          <G
            transform={`translate(${g.plane[0].toFixed(1)} ${(g.plane[1] - 1).toFixed(1)}) rotate(${g.angle.toFixed(1)}) scale(${PLANE_SCALE})`}>
            <Path d={PLANE.fin} fill={art.planeWing} />
            <Path d={PLANE.wing} fill={art.planeWing} />
            <Path d={PLANE.body} fill={art.planeBody} />
            <Path d={PLANE.cockpit} fill={art.planeWindow} />
          </G>
          <SvgText
            x={g.current.x}
            y={g.current.y}
            textAnchor={g.current.anchor}
            fontSize={12}
            fontWeight="700"
            fill={theme.text}>
            {level.name}
          </SvgText>
          {g.nextLabel !== null && level.nextName !== null ? (
            <SvgText
              x={g.nextLabel.x}
              y={g.nextLabel.y}
              textAnchor="end"
              fontSize={12}
              fontWeight="600"
              fill={theme.textSecondary}>
              {`Next: ${level.nextName}`}
            </SvgText>
          ) : null}
          {DOTS.map(([x], i) => (
            <SvgText
              key={i}
              x={x}
              y={132}
              textAnchor="middle"
              fontSize={11}
              fontWeight={i === g.index ? '700' : '400'}
              fill={i === g.index ? theme.text : theme.textSecondary}>
              {String(i + 1)}
            </SvgText>
          ))}
        </Svg>
      </View>

      <ThemedText style={styles.levels} themeColor="textSecondary">
        {LEVELS.map((l) => l.name).join(' · ')}. Every mile you fly climbs you higher.
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 12,
    padding: Spacing.three,
    borderRadius: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: Spacing.one,
  },
  title: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400',
  },
  chip: {
    flexShrink: 0,
    minHeight: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    justifyContent: 'center',
  },
  chipText: {
    fontFamily: Fonts.rounded,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800',
  },
  chart: {
    width: '100%',
    aspectRatio: WIDTH / HEIGHT,
  },
  levels: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '400',
  },
});
