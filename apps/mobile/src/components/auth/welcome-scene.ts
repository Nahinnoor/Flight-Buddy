/**
 * Geometry for the welcome artwork: pure numbers and pure functions, no React,
 * no colour, no react-native-svg.
 *
 * Everything here is in the scene's own coordinate space. The screen never
 * sees these numbers as pixels — `WelcomeArtwork` hands the whole space to a
 * `viewBox` and lets `preserveAspectRatio` scale it into whatever the top half
 * of the device turns out to be, which is how the same drawing survives both a
 * 375×667 iPhone SE and an iPhone 17.
 *
 * ## The three routes
 *
 * Each route is one cubic Bézier: it starts at a departure marker on the
 * globe, swings out into open space, and comes back down onto the pin. They
 * are cubics rather than arcs because a cubic lets the *final approach* be set
 * independently of the departure, and the final approach is what the animation
 * spends its time on.
 *
 * Two constraints shaped the control points, and both are easy to break by
 * "just nudging" a number:
 *
 * 1. **The aircraft must not somersault.** A plane is drawn nose-first along
 *    +x and mirrored across its own long axis when the tangent points leftward
 *    (see `planeTransform`), so it stays the right way up. That mirror flips at
 *    ±90°. Each route's `enter`…`settle` window therefore has to stay entirely
 *    on one side of ±90°, or the aircraft visibly turns inside out mid-flight.
 *    `welcome-scene.test.ts` asserts this.
 * 2. **All three end on the pin.** `x3`/`y3` is the pin for every route; that
 *    is the whole picture. Also asserted.
 */

/** The drawing's own coordinate space, fed straight to `viewBox`. */
export const SCENE = { x: 24, y: 40, width: 280, height: 212 } as const;

export const GLOBE = { cx: 160, cy: 172, r: 60 } as const;

/** Where every route ends, and where the pin's point touches the globe. */
export const DESTINATION = { x: 184, y: 132 } as const;

/**
 * Abstract landmasses. Deliberately not any real coastline: the brief is that
 * the origins and destination are decorative and must not imply real cities,
 * and recognisable geography would do exactly that.
 */
export const LAND_PATHS = [
  'M 104 152 q 20 -27 45 -16 q 18 8 10 25 q -11 22 -33 17 q -27 -5 -22 -26 z',
  'M 150 194 q 25 -12 39 4 q 12 13 -2 27 q -17 17 -37 5 q -15 -12 0 -36 z',
  'M 194 140 q 24 -6 29 12 q 5 17 -14 21 q -21 4 -23 -14 q -2 -15 8 -19 z',
  'M 104 210 q 19 -8 27 5 q 5 12 -10 17 q -19 8 -25 -5 q -4 -12 8 -17 z',
] as const;

export interface Route {
  /** Departure marker, on the globe. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Always `DESTINATION`. */
  readonly x3: number;
  readonly y3: number;
  /** Curve parameter at which the aircraft appears on the drawn trail. */
  readonly enter: number;
  /** Curve parameter at which it stops, short of the pin, still in flight. */
  readonly settle: number;
  /** Relative aircraft size — three depths rather than three clones. */
  readonly scale: number;
  /** Fraction of the master timeline this route waits before starting. */
  readonly stagger: number;
}

export const ROUTES: readonly Route[] = [
  // Out over the top of the globe and down onto the pin. Levels off, then
  // descends: the tangent runs -72° → +26° across the window, never past ±90.
  // The departure marker sits high on the globe's left rim rather than mid-face
  // because the south-west aircraft settles right on top of the obvious spot,
  // and a departure marker nobody can see is two thirds of the picture.
  {
    x0: 124, y0: 126, x1: 64, y1: 62, x2: 126, y2: 44,
    x3: DESTINATION.x, y3: DESTINATION.y,
    enter: 0.34, settle: 0.66, scale: 0.82, stagger: 0,
  },
  // The near aircraft, climbing back in from the south-west. Window sits
  // entirely after the turn, so the tangent runs -77° → -41°.
  {
    x0: 134, y0: 226, x1: 46, y1: 262, x2: 46, y2: 140,
    x3: DESTINATION.x, y3: DESTINATION.y,
    enter: 0.5, settle: 0.7, scale: 1, stagger: 0.1,
  },
  // Swings out east and comes back westbound, so this one flies nose-left and
  // is the mirrored case. Tangent runs -121° → -167°: past ±90 the whole way,
  // which is what keeps the mirror from switching.
  {
    x0: 212, y0: 204, x1: 300, y1: 206, x2: 292, y2: 92,
    x3: DESTINATION.x, y3: DESTINATION.y,
    enter: 0.58, settle: 0.78, scale: 0.74, stagger: 0.2,
  },
];

/** Total stagger, so the last route still finishes on the master timeline. */
const LAST_START = 0.2;

/**
 * Per-route progress, eased.
 *
 * The master value runs linearly so the three routes can be offset from each
 * other; the ease-out lives here instead, applied after the offset, so every
 * route decelerates into its own landing rather than inheriting a slice of one
 * shared curve.
 */
export function routeProgress(master: number, stagger: number): number {
  'worklet';
  const raw = (master - stagger) / (1 - LAST_START);
  const p = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const inverse = 1 - p;
  return 1 - inverse * inverse * inverse;
}

/**
 * The trail as drawn so far: the exact sub-curve from the origin to `t`, via
 * de Casteljau. Truncating the real curve rather than masking a finished one
 * means the dash pattern is laid from the origin and simply grows — new dashes
 * appear at the head, the ones behind never shift.
 */
export function trailPath(route: Route, t: number): string {
  'worklet';
  const ax = route.x0 + (route.x1 - route.x0) * t;
  const ay = route.y0 + (route.y1 - route.y0) * t;
  const bx = route.x1 + (route.x2 - route.x1) * t;
  const by = route.y1 + (route.y2 - route.y1) * t;
  const cx = route.x2 + (route.x3 - route.x2) * t;
  const cy = route.y2 + (route.y3 - route.y2) * t;
  const dx = ax + (bx - ax) * t;
  const dy = ay + (by - ay) * t;
  const ex = bx + (cx - bx) * t;
  const ey = by + (cy - by) * t;
  const fx = dx + (ex - dx) * t;
  const fy = dy + (ey - dy) * t;
  return `M ${route.x0} ${route.y0} C ${ax} ${ay} ${dx} ${dy} ${fx} ${fy}`;
}

/**
 * Where the aircraft sits and how it is oriented at curve parameter `t`, as an
 * SVG matrix `[a, b, c, d, tx, ty]`.
 *
 * ## Why a matrix and not a `transform` string
 *
 * Reanimated claims the `transform` prop for React Native's own style
 * transforms, and throws `invalidTransform` on the UI runtime the moment it is
 * handed an SVG transform string. react-native-svg's native group node takes
 * `matrix` — six floats — so that is the one handle that survives being driven
 * from a worklet. Composing it here also skips react-native-svg's JS-side
 * `props2transform`, which never runs for a Reanimated update anyway.
 *
 * The composition is `translate · rotate · scale`. The rotation is always the
 * raw tangent angle, so the nose points along the path; the mirror is a
 * *negative y scale*, which flips the aircraft across its own long axis and
 * leaves the nose where it was. The thing you must not do is add 180° to the
 * angle: it looks almost right in a still frame and flies the aircraft
 * backwards along its own route.
 */
export function planeMatrix(
  route: Route,
  t: number,
): [number, number, number, number, number, number] {
  'worklet';
  const ax = route.x0 + (route.x1 - route.x0) * t;
  const ay = route.y0 + (route.y1 - route.y0) * t;
  const bx = route.x1 + (route.x2 - route.x1) * t;
  const by = route.y1 + (route.y2 - route.y1) * t;
  const cx = route.x2 + (route.x3 - route.x2) * t;
  const cy = route.y2 + (route.y3 - route.y2) * t;
  const dx = ax + (bx - ax) * t;
  const dy = ay + (by - ay) * t;
  const ex = bx + (cx - bx) * t;
  const ey = by + (cy - by) * t;
  const fx = dx + (ex - dx) * t;
  const fy = dy + (ey - dy) * t;
  const radians = Math.atan2(ey - dy, ex - dx);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = route.scale;
  // Mirrored when the nose points leftward, i.e. |heading| > 90°, which is the
  // same as the cosine being negative.
  const sy = cos < 0 ? -route.scale : route.scale;
  return [cos * sx, sin * sx, -sin * sy, cos * sy, fx, fy];
}

/** The tangent angle in degrees. Exported for the geometry test. */
export function headingAt(route: Route, t: number): number {
  const bx = route.x1 + (route.x2 - route.x1) * t;
  const by = route.y1 + (route.y2 - route.y1) * t;
  const ax = route.x0 + (route.x1 - route.x0) * t;
  const ay = route.y0 + (route.y1 - route.y0) * t;
  const cx = route.x2 + (route.x3 - route.x2) * t;
  const cy = route.y2 + (route.y3 - route.y2) * t;
  const dx = ax + (bx - ax) * t;
  const dy = ay + (by - ay) * t;
  const ex = bx + (cx - bx) * t;
  const ey = by + (cy - by) * t;
  return (Math.atan2(ey - dy, ex - dx) * 180) / Math.PI;
}

/**
 * The aircraft, in its own coordinates: nose along +x, centred on the origin,
 * roughly 74 long and 56 tall including fin and wing.
 *
 * The figures are the reason the windows are oversized and the heads sit half
 * above the fuselage line. A person leaning out of a window on the near side of
 * a true side view would be facing the camera and so invisible; every cartoon
 * solves it the same way, by popping the head up through the window and over
 * the roof line. Taken literally, as asked — they are grinning and waving.
 */
export const PLANE = {
  fin: 'M -7 -10 L -21 -10 L -34 -29 L -22 -29 Z',
  wing: 'M 4 9 L -8 9 L -21 24 L -8 24 Z',
  body:
    'M 38 0 C 34 -11 26 -11 16 -11 L -22 -11 C -33 -11 -36 -5 -36 -1 ' +
    'L -36 1 C -36 5 -33 11 -22 11 L 16 11 C 26 11 34 11 38 0 Z',
  cockpit: 'M 22 -6.5 C 28 -6.5 31 -4.5 33.5 -2 L 23 -2 Z',
  /** Window centres along the fuselage; one figure leans out of each. */
  seats: [-14, 4],
} as const;

/** Geometry of one figure, relative to its window centre at `x`. */
export function figureAt(x: number) {
  return {
    window: { cx: x, cy: -2.5, r: 6.4 },
    shoulders: { cx: x, cy: 0.8, r: 4.8 },
    arm: `M ${x + 3.6} -5 Q ${x + 10.5} -9 ${x + 9.4} -18.5`,
    hand: { cx: x + 9.4, cy: -20.2, r: 2.4 },
    head: { cx: x, cy: -10.6, r: 6.3 },
    leftEye: { cx: x - 2.3, cy: -12.3, r: 0.95 },
    rightEye: { cx: x + 2.3, cy: -12.3, r: 0.95 },
    smile: `M ${x - 2.8} -9.3 Q ${x} -6.4 ${x + 2.8} -9.3`,
  };
}
