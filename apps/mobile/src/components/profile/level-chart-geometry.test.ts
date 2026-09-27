/**
 * The altitude chart's labels never sit on the line, a dot or the aircraft,
 * at any level and any progress towards the next one. Text is measured
 * conservatively (a bold 12 pt glyph taken as 0.62 em wide, cap height to
 * descender as 9 above and 3 below the baseline), and the aircraft as a
 * circle around its centre wide enough to hold its fin and wing when rotated.
 */
import { describe, expect, it } from 'vitest';

import { LEVELS, levelFor } from '../../lib/profile-stats';
import {
  chartGeometry,
  currentLabelPosition,
  DOTS,
  type LabelPosition,
} from './level-chart-geometry';

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const FONT = 12;
const LINE_HALF = 1.5; // the solid line is 3 wide; the dashed one 2
// The current dot is 6 with a 2.5 ring; the others 4.5 with a 2 stroke.
const dotRadius = (i: number, current: number) => (i === current ? 6 + 1.25 : 4.5 + 1);
const PLANE_RADIUS = 13;

function textBox(label: LabelPosition, text: string): Box {
  const width = text.length * FONT * 0.62;
  const left =
    label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - width : label.x - width / 2;
  return { left, right: left + width, top: label.y - 9, bottom: label.y + 3 };
}

function distanceToBox(x: number, y: number, box: Box): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}

function lineDistance(points: readonly (readonly [number, number])[], box: Box): number {
  let best = Infinity;
  for (let k = 1; k < points.length; k += 1) {
    const [x0, y0] = points[k - 1] as readonly [number, number];
    const [x1, y1] = points[k] as readonly [number, number];
    for (let s = 0; s <= 200; s += 1) {
      const t = s / 200;
      best = Math.min(best, distanceToBox(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, box));
    }
  }
  return best;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Miles at `progress` of the way through level `index` (1-based). */
function milesAt(index: number, progress: number): number {
  const level = LEVELS[index - 1];
  const next = LEVELS[index];
  if (level === undefined) return 0;
  if (next === undefined) return level.minMiles;
  return level.minMiles + (next.minMiles - level.minMiles) * progress;
}

describe('altitude chart labels', () => {
  for (const level of LEVELS) {
    for (const progress of [0, 0.25, 0.5, 0.75, 0.999]) {
      it(`level ${level.index} at ${Math.round(progress * 100)}% stays clear of the drawing`, () => {
        const state = levelFor(milesAt(level.index, progress));
        expect(state.index).toBe(level.index);
        const g = chartGeometry(state);
        const labels: Box[] = [textBox(g.current, state.name)];
        if (g.nextLabel !== null && state.nextName !== null) {
          labels.push(textBox(g.nextLabel, `Next: ${state.nextName}`));
        }

        for (const box of labels) {
          expect(lineDistance(g.solid, box)).toBeGreaterThan(LINE_HALF);
          expect(lineDistance(g.dashed, box)).toBeGreaterThan(LINE_HALF);
          DOTS.forEach(([x, y], i) =>
            expect(distanceToBox(x, y, box)).toBeGreaterThan(dotRadius(i, g.index)),
          );
          expect(distanceToBox(g.plane[0], g.plane[1] - 1, box)).toBeGreaterThan(PLANE_RADIUS);
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(326);
          expect(box.top).toBeGreaterThanOrEqual(0);
        }
        if (labels.length === 2) {
          expect(overlaps(labels[0] as Box, labels[1] as Box)).toBe(false);
        }
      });
    }
  }

  it('centres levels 2–5 under their dot, inside the filled area', () => {
    for (const index of [1, 2, 3, 4]) {
      const label = currentLabelPosition(index);
      const dot = DOTS[index] as readonly [number, number];
      expect(label.anchor).toBe('middle');
      expect(label.x).toBe(dot[0]);
      expect(label.y).toBeGreaterThan(dot[1]);
      expect(label.y + 3).toBeLessThan(118);
    }
  });
});
