/**
 * Guards on the welcome artwork's geometry.
 *
 * These are not tests of what the picture looks like — nothing here can tell
 * you that. They pin the two properties that are invisible in a still frame
 * and only show up as a glitch once the thing animates, which is exactly the
 * kind of regression a later "just nudge that control point" produces.
 */
import { describe, expect, it } from 'vitest';

import {
  DESTINATION,
  headingAt,
  planeMatrix,
  ROUTES,
  routeProgress,
  trailPath,
} from './welcome-scene';

describe('routes', () => {
  it('all three end on the pin', () => {
    for (const route of ROUTES) {
      expect([route.x3, route.y3]).toEqual([DESTINATION.x, DESTINATION.y]);
    }
  });

  it('keeps each aircraft on one side of the mirror boundary', () => {
    // `planeMatrix` mirrors the aircraft across its own long axis once the
    // tangent points leftward. If a route's flight window straddles ±90° the
    // aircraft turns inside out partway along, which is unmistakable in motion
    // and invisible in a screenshot.
    for (const [index, route] of ROUTES.entries()) {
      const mirrored = new Set<boolean>();
      for (let t = route.enter; t <= route.settle + 1e-9; t += 0.01) {
        const heading = headingAt(route, t);
        mirrored.add(heading > 90 || heading < -90);
      }
      expect(mirrored, `route ${index} flips mid-flight`).toHaveProperty('size', 1);
    }
  });

  it('gives every aircraft a window it can actually travel along', () => {
    for (const route of ROUTES) {
      expect(route.enter).toBeLessThan(route.settle);
      // Short of the pin: the aircraft is still in flight when it settles, and
      // the remaining dashes run on ahead of it.
      expect(route.settle).toBeLessThan(1);
    }
  });
});

describe('trailPath', () => {
  it('reproduces the whole curve at t = 1', () => {
    const route = ROUTES[0];
    expect(trailPath(route, 1)).toBe(
      `M ${route.x0} ${route.y0} C ${route.x1} ${route.y1} ${route.x2} ${route.y2} ${route.x3} ${route.y3}`,
    );
  });

  it('starts at the origin at t = 0', () => {
    const route = ROUTES[1];
    expect(trailPath(route, 0)).toBe(
      `M ${route.x0} ${route.y0} C ${route.x0} ${route.y0} ${route.x0} ${route.y0} ${route.x0} ${route.y0}`,
    );
  });
});

describe('routeProgress', () => {
  it('reaches 1 for every route once the master timeline finishes', () => {
    // The staggered routes must still land: a route that only reaches 0.97
    // leaves a trail that stops a dash short of the pin, for ever.
    for (const route of ROUTES) {
      expect(routeProgress(1, route.stagger)).toBe(1);
    }
  });

  it('has not started before its stagger elapses', () => {
    const staggered = ROUTES[2];
    expect(routeProgress(0, staggered.stagger)).toBe(0);
    expect(routeProgress(staggered.stagger, staggered.stagger)).toBe(0);
  });
});

describe('planeMatrix', () => {
  /** The direction the aircraft's nose ends up pointing, in degrees. */
  const noseOf = ([a, b]: readonly number[]) => (Math.atan2(b, a) * 180) / Math.PI;
  /** Where the aircraft's own "up" ends up pointing. Negative y is up. */
  const upOf = ([, , c, d]: readonly number[]) => ({ x: -c, y: -d });

  it('points the nose along the path rather than back down it', () => {
    // The mirror is a negative y scale, never a 180° turn: turning the angle
    // instead looks almost right in a still frame and flies the aircraft
    // backwards along its own route.
    for (const route of ROUTES) {
      const matrix = planeMatrix(route, route.settle);
      expect(noseOf(matrix)).toBeCloseTo(headingAt(route, route.settle), 6);
    }
  });

  it('keeps every aircraft the right way up', () => {
    for (const [index, route] of ROUTES.entries()) {
      for (let t = route.enter; t <= route.settle + 1e-9; t += 0.02) {
        const up = upOf(planeMatrix(route, t));
        expect(up.y, `route ${index} is upside down at t=${t.toFixed(2)}`).toBeLessThan(0);
      }
    }
  });

  it('puts the aircraft on its own curve', () => {
    const route = ROUTES[1];
    const [, , , , tx, ty] = planeMatrix(route, 0);
    expect([tx, ty]).toEqual([route.x0, route.y0]);
  });

  it('mirrors exactly the westbound aircraft', () => {
    // Determinant is negative for a mirrored frame, positive otherwise.
    const determinant = (m: readonly number[]) => m[0] * m[3] - m[1] * m[2];
    expect(determinant(planeMatrix(ROUTES[2], ROUTES[2].settle))).toBeLessThan(0);
    expect(determinant(planeMatrix(ROUTES[0], ROUTES[0].settle))).toBeGreaterThan(0);
  });
});
