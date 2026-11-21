// The robot's light trail: a ring of its last few positions, each with an age. A point is
// added only when the robot has moved, and points age out, so a robot standing still has no
// trail. Pure (no DOM, no canvas).
export const TRAIL_POINTS = 12;
/** Seconds a point lasts. */
export const TRAIL_SECONDS = 0.25;
/** Arena units the robot must move before a new point is recorded. */
export const TRAIL_STEP = 1.5;

export type Trail = {
  x: Float32Array;
  y: Float32Array;
  age: Float32Array;
  /** The slot holding the newest point. */
  head: number;
  /** Points recorded, up to TRAIL_POINTS (some may have aged out). */
  count: number;
};

export function createTrail(): Trail {
  return {
    x: new Float32Array(TRAIL_POINTS),
    y: new Float32Array(TRAIL_POINTS),
    age: new Float32Array(TRAIL_POINTS),
    head: TRAIL_POINTS - 1,
    count: 0,
  };
}

/** Ages every point by `dt` seconds, then records (x, y) if the robot moved far enough. */
export function updateTrail(t: Trail, x: number, y: number, dt: number): void {
  for (let i = 0; i < TRAIL_POINTS; i++) t.age[i]! += dt;
  const h = t.head;
  if (t.count > 0 && (x - t.x[h]!) ** 2 + (y - t.y[h]!) ** 2 <= TRAIL_STEP * TRAIL_STEP) return;
  const next = (h + 1) % TRAIL_POINTS;
  t.x[next] = x;
  t.y[next] = y;
  t.age[next] = 0;
  t.head = next;
  if (t.count < TRAIL_POINTS) t.count++;
}

/** The slot of the k-th newest point (k = 0 is the newest). */
export function trailSlot(t: Trail, k: number): number {
  return (t.head - k + TRAIL_POINTS) % TRAIL_POINTS;
}

/** Points still young enough to draw. */
export function visibleTrailPoints(t: Trail): number {
  let n = 0;
  for (let k = 0; k < t.count; k++) if (t.age[trailSlot(t, k)]! < TRAIL_SECONDS) n++;
  return n;
}
