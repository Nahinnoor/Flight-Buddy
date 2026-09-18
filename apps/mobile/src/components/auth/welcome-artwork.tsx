/**
 * The welcome illustration: one globe, three aircraft converging on one pin.
 *
 * Drawn in code with react-native-svg — no raster art, no second asset for
 * dark mode. Every colour resolves through `useIllustration()`; there is not a
 * hex value in this file, and the red pin has its own token rather than
 * borrowing the "something is wrong" red a flight card uses.
 *
 * ## How the animation is put together
 *
 * One shared value runs 0 → 1, linearly, once. Everything else is derived from
 * it inside worklets:
 *
 * - each trail's `d` is the **real sub-curve** truncated at that route's eased
 *   progress, so the dashes are laid from the origin and grow outward;
 * - each aircraft rides the head of its own trail from `enter` to `settle`,
 *   then holds while the remaining dashes run on ahead of it to the pin. That
 *   last part is the bit that reads as tracking rather than decoration: what is
 *   drawn behind the aircraft is where it has been, and what runs on in front
 *   is where it is going.
 *
 * Nothing loops. When it finishes it is a still picture.
 *
 * **Reduce Motion is honoured by never starting.** The shared value is seeded
 * at 1, so the first committed frame is the finished scene — not a frame of
 * empty sky followed by a jump, which is the usual way this gets got wrong.
 *
 * The whole thing is a single accessibility element with an image role and a
 * label saying what it depicts. The internals are explicitly hidden: a screen
 * reader walking forty decorative circles is worse than no artwork at all.
 */
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Path } from 'react-native-svg';

import type { IllustrationPalette } from '@/constants/theme';
import { useIllustration } from '@/hooks/use-illustration';

import {
  DESTINATION,
  figureAt,
  GLOBE,
  LAND_PATHS,
  PLANE,
  planeMatrix,
  ROUTES,
  routeProgress,
  SCENE,
  trailPath,
  type Route,
} from './welcome-scene';

/** Long enough to read as a route being traced, short enough not to be a wait. */
const DRAW_MS = 1900;

/** Progress over which an aircraft fades in once the trail head reaches it. */
const FADE = 0.08;

export const ARTWORK_LABEL = 'Three planes converging on one destination';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedG = Animated.createAnimatedComponent(G);

export function WelcomeArtwork() {
  const colors = useIllustration();
  const reduceMotion = useReducedMotion();
  // Seeded at the finished state when motion is reduced, so there is no first
  // frame to correct.
  const progress = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withTiming(1, { duration: DRAW_MS, easing: Easing.linear });
  }, [progress, reduceMotion]);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={ARTWORK_LABEL}
      style={styles.stage}>
      <Svg
        viewBox={`${SCENE.x} ${SCENE.y} ${SCENE.width} ${SCENE.height}`}
        preserveAspectRatio="xMidYMid meet"
        style={styles.svg}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        <Defs>
          <ClipPath id="globe">
            <Circle cx={GLOBE.cx} cy={GLOBE.cy} r={GLOBE.r} />
          </ClipPath>
        </Defs>

        <Globe colors={colors} />

        {ROUTES.map((route, index) => (
          <Circle
            key={`origin-${index}`}
            cx={route.x0}
            cy={route.y0}
            r={6}
            fill={colors.originRing}
          />
        ))}
        {ROUTES.map((route, index) => (
          <Circle
            key={`origin-dot-${index}`}
            cx={route.x0}
            cy={route.y0}
            r={3.4}
            fill={colors.originDot}
          />
        ))}

        {ROUTES.map((route, index) => (
          <Trail key={`trail-${index}`} route={route} progress={progress} colors={colors} />
        ))}

        <Pin colors={colors} />

        {ROUTES.map((route, index) => (
          <Aircraft
            key={`plane-${index}`}
            route={route}
            progress={progress}
            colors={colors}
            shirts={SHIRTS[index]}
          />
        ))}
      </Svg>
    </View>
  );
}

/** Which two shirts each aircraft's pair of passengers wear. */
const SHIRTS: readonly (readonly [
  keyof IllustrationPalette,
  keyof IllustrationPalette,
])[] = [
  ['figureShirtOne', 'figureShirtTwo'],
  ['figureShirtTwo', 'figureShirtThree'],
  ['figureShirtThree', 'figureShirtOne'],
];

function Globe({ colors }: { colors: IllustrationPalette }) {
  return (
    <G>
      <Circle cx={GLOBE.cx} cy={GLOBE.cy} r={GLOBE.r + 11} fill={colors.sky} />
      {/* The ocean fill alone does not clear 3:1 on white — this rim does, and
          it is what gives the globe an edge in both schemes. */}
      <Circle
        cx={GLOBE.cx}
        cy={GLOBE.cy}
        r={GLOBE.r}
        fill={colors.globeOcean}
        stroke={colors.globeEdge}
        strokeWidth={2}
      />
      <G clipPath="url(#globe)">
        {LAND_PATHS.map((d, index) => (
          <Path key={index} d={d} fill={colors.globeLand} />
        ))}
        <Ellipse
          cx={GLOBE.cx}
          cy={GLOBE.cy}
          rx={GLOBE.r}
          ry={22}
          fill="none"
          stroke={colors.globeGraticule}
          strokeWidth={1.2}
          opacity={0.6}
        />
        <Ellipse
          cx={GLOBE.cx}
          cy={GLOBE.cy}
          rx={GLOBE.r}
          ry={44}
          fill="none"
          stroke={colors.globeGraticule}
          strokeWidth={1.2}
          opacity={0.4}
        />
        <Ellipse
          cx={GLOBE.cx}
          cy={GLOBE.cy}
          rx={24}
          ry={GLOBE.r}
          fill="none"
          stroke={colors.globeGraticule}
          strokeWidth={1.2}
          opacity={0.45}
        />
      </G>
    </G>
  );
}

function Pin({ colors }: { colors: IllustrationPalette }) {
  const { x, y } = DESTINATION;
  const headY = y - 21;
  return (
    <G>
      <Ellipse cx={x} cy={y + 2} rx={9} ry={3.4} fill={colors.pinShadow} opacity={0.4} />
      <Path
        d={
          `M ${x} ${y} C ${x - 13.5} ${y - 14} ${x - 12} ${headY - 8} ${x} ${headY - 10.5} ` +
          `C ${x + 12} ${headY - 8} ${x + 13.5} ${y - 14} ${x} ${y} Z`
        }
        fill={colors.pin}
      />
      <Circle cx={x} cy={headY - 2} r={4.8} fill={colors.pinCore} />
    </G>
  );
}

function Trail({
  route,
  progress,
  colors,
}: {
  route: Route;
  progress: SharedValue<number>;
  colors: IllustrationPalette;
}) {
  const animatedProps = useAnimatedProps(() => ({
    d: trailPath(route, routeProgress(progress.value, route.stagger)),
  }));

  return (
    <AnimatedPath
      animatedProps={animatedProps}
      fill="none"
      stroke={colors.trail}
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeDasharray="7 7.5"
    />
  );
}

function Aircraft({
  route,
  progress,
  colors,
  shirts,
}: {
  route: Route;
  progress: SharedValue<number>;
  colors: IllustrationPalette;
  shirts: readonly [keyof IllustrationPalette, keyof IllustrationPalette];
}) {
  const animatedProps = useAnimatedProps(() => {
    const eased = routeProgress(progress.value, route.stagger);
    // Ride the head of the drawn trail, then hold short of the pin while the
    // rest of the route runs on ahead.
    const t = eased < route.enter ? route.enter : eased > route.settle ? route.settle : eased;
    const fade = (eased - route.enter) / FADE;
    return {
      matrix: planeMatrix(route, t),
      opacity: fade < 0 ? 0 : fade > 1 ? 1 : fade,
    };
  });

  return (
    <AnimatedG animatedProps={animatedProps}>
      <Path d={PLANE.fin} fill={colors.planeWing} />
      <Path d={PLANE.wing} fill={colors.planeWing} />
      <Path d={PLANE.body} fill={colors.planeBody} />
      <Path d={PLANE.cockpit} fill={colors.planeWindow} />
      {PLANE.seats.map((seat, index) => (
        <Figure key={seat} x={seat} colors={colors} shirt={colors[shirts[index]]} />
      ))}
    </AnimatedG>
  );
}

function Figure({
  x,
  colors,
  shirt,
}: {
  x: number;
  colors: IllustrationPalette;
  shirt: string;
}) {
  const f = figureAt(x);
  return (
    <G>
      <Circle cx={f.window.cx} cy={f.window.cy} r={f.window.r} fill={colors.planeWindow} />
      <Circle cx={f.shoulders.cx} cy={f.shoulders.cy} r={f.shoulders.r} fill={shirt} />
      <Path
        d={f.arm}
        fill="none"
        stroke={colors.figureSkin}
        strokeWidth={2.6}
        strokeLinecap="round"
      />
      <Circle cx={f.hand.cx} cy={f.hand.cy} r={f.hand.r} fill={colors.figureSkin} />
      {/* The outline is load-bearing in dark mode: the fuselage is nearly white
          there and skin on its own would disappear against it. */}
      <Circle
        cx={f.head.cx}
        cy={f.head.cy}
        r={f.head.r}
        fill={colors.figureSkin}
        stroke={colors.figureInk}
        strokeWidth={0.9}
      />
      <Circle cx={f.leftEye.cx} cy={f.leftEye.cy} r={f.leftEye.r} fill={colors.figureInk} />
      <Circle cx={f.rightEye.cx} cy={f.rightEye.cy} r={f.rightEye.r} fill={colors.figureInk} />
      <Path
        d={f.smile}
        fill="none"
        stroke={colors.figureInk}
        strokeWidth={1.1}
        strokeLinecap="round"
      />
    </G>
  );
}

const styles = StyleSheet.create({
  stage: {
    flex: 1,
  },
  svg: {
    flex: 1,
  },
});
