/**
 * Where everything on the frequent-flyer altitude chart goes: pure numbers in
 * the chart's own 326 × 136 space, no React, so the label placement is pinned
 * down by `level-chart-geometry.test.ts` rather than by eyeballing.
 *
 * Relative imports only: vitest runs this file without the app's `@/` alias.
 */
import type { LevelProgress } from '../../lib/profile-stats';

export const CHART_WIDTH = 326;
export const CHART_HEIGHT = 136;
/** The axis the filled area sits on. */
export const CHART_BASELINE = 118;
/** One dot per level, on the climb curve. */
export const DOTS: readonly (readonly [number, number])[] = [
  [16, 112],
  [58, 88],
  [100, 67],
  [142, 51],
  [184, 38],
  [226, 28],
  [268, 23],
  [310, 21],
];
export const PLANE_SCALE = 0.34;

export type Anchor = 'start' | 'middle' | 'end';
export interface LabelPosition {
  /** Text x, read with `anchor`. */
  x: number;
  /** Text baseline. */
  y: number;
  anchor: Anchor;
}

export function chartGeometry(level: LevelProgress) {
  const i = Math.min(Math.max(level.index, 1), DOTS.length) - 1;
  const here = DOTS[i] as readonly [number, number];
  const next = DOTS[i + 1];
  const t = next === undefined ? 0 : Math.min(Math.max(level.progress, 0), 1);
  const plane: [number, number] =
    next === undefined
      ? [here[0], here[1]]
      : [here[0] + (next[0] - here[0]) * t, here[1] + (next[1] - here[1]) * t];

  // Nose along the climb: the slope of the segment the aircraft is on (the
  // last one at the top level).
  const [from, to] = next === undefined ? [DOTS[i - 1] ?? here, here] : [here, next];
  const angle = (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;

  const reached = DOTS.slice(0, i + 1);
  const solid = [...reached, plane];
  const dashed = next === undefined ? [] : [plane, ...DOTS.slice(i + 1)];

  return {
    index: i,
    plane,
    angle,
    solid,
    dashed,
    current: currentLabelPosition(i),
    nextLabel: next === undefined ? null : nextLabelPosition(i),
  };
}

/**
 * The current level's name, by zero-based level index.
 *
 * - Level 1: under its dot is the axis and beside it is the aircraft, so it
 *   goes in the open sky above the first segment.
 * - Levels 2–5: centred under the dot, about halfway down to the axis — inside
 *   the filled area, below the line, clear of the dots and the aircraft.
 * - Levels 6–7: just under the dot; "Next: …" then sits lower down (see below).
 * - Level 8: under the last dot, right-aligned so it stays inside the chart.
 */
export function currentLabelPosition(index: number): LabelPosition {
  const here = DOTS[index] ?? DOTS[0] ?? [16, 112];
  if (index <= 0) return { x: 8, y: 62, anchor: 'start' };
  if (index <= 4) {
    return { x: here[0], y: Math.round((here[1] + CHART_BASELINE) / 2 + 7), anchor: 'middle' };
  }
  if (here[0] > CHART_WIDTH - 40) return { x: CHART_WIDTH - 8, y: here[1] + 24, anchor: 'end' };
  return { x: here[0], y: here[1] + 24, anchor: 'middle' };
}

/**
 * "Next: …", right-aligned: in the open sky top right, or — once the
 * aircraft is up there itself (levels 6 and 7) — below the curve.
 */
export function nextLabelPosition(index: number): LabelPosition {
  return { x: CHART_WIDTH - 8, y: index >= 5 ? 72 : 11, anchor: 'end' };
}
