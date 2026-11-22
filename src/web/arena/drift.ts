// The start screen's camera (#79): no robot of its own to follow, so it drifts slowly between the
// action. Every DRIFT_HOLD_S it picks as its focus the robot with the most bugs near it (a
// different one from the last when there is one; the world's centre with nobody in a life), then
// follows that robot, easing toward it over DRIFT_SECONDS and never faster than DRIFT_MAX_SPEED,
// so a pick across the map is a slow pan, never a cut. Pure.
import { WORLD_H, WORLD_W } from "../../shared/arena/constants";
import { clampCamera, type Camera } from "./camera";

/** How long the camera stays on one robot, seconds. */
export const DRIFT_HOLD_S = 6;
/** Easing time constant toward the focus, seconds. */
export const DRIFT_SECONDS = 2.5;
/** The fastest the camera moves, units per second. */
export const DRIFT_MAX_SPEED = 220;
/** Bugs within this many units of a robot count as its action. */
export const DRIFT_NEAR = 400;

export type Drift = {
  /** The focus's id (0: the world's centre). */
  id: number;
  /** Where the focus was last seen, world units. */
  x: number;
  y: number;
  /** Seconds left before the next pick. */
  hold: number;
};

type Spot = { id: number; x: number; y: number };
type Bugs = { x: ArrayLike<number>; y: ArrayLike<number>; count: number };

export function createDrift(): Drift {
  return { id: 0, x: WORLD_W / 2, y: WORLD_H / 2, hold: 0 };
}

/** Bugs within DRIFT_NEAR of (x, y). */
function busyness(x: number, y: number, bugs: Bugs): number {
  const r2 = DRIFT_NEAR * DRIFT_NEAR;
  let n = 0;
  for (let i = 0; i < bugs.count; i++) {
    const dx = bugs.x[i]! - x;
    const dy = bugs.y[i]! - y;
    if (dx * dx + dy * dy <= r2) n++;
  }
  return n;
}

/** Picks the next focus: the busiest robot, not the current one when another exists (ties: the first). */
export function pickFocus(d: Drift, robots: readonly Spot[], count: number, bugs: Bugs): void {
  let best = -1;
  let bestN = -1;
  for (let i = 0; i < count; i++) {
    const r = robots[i]!;
    if (r.id === d.id && count > 1) continue;
    const n = busyness(r.x, r.y, bugs);
    if (n > bestN) {
      best = i;
      bestN = n;
    }
  }
  if (best < 0) {
    d.id = 0;
    d.x = WORLD_W / 2;
    d.y = WORLD_H / 2;
    return;
  }
  const r = robots[best]!;
  d.id = r.id;
  d.x = r.x;
  d.y = r.y;
}

/**
 * One frame: picks a new focus when the hold is up, tracks the focus while it is on screen data,
 * and moves the camera toward it (eased, speed-capped, inside the world's bounds).
 */
export function stepDrift(d: Drift, cam: Pick<Camera, "x" | "y" | "w" | "h">, robots: readonly Spot[], count: number, bugs: Bugs, dt: number): void {
  d.hold -= dt;
  if (d.hold <= 0) {
    pickFocus(d, robots, count, bugs);
    d.hold = DRIFT_HOLD_S;
  } else {
    for (let i = 0; i < count; i++) {
      const r = robots[i]!;
      if (r.id !== d.id) continue;
      d.x = r.x;
      d.y = r.y;
      break;
    }
  }
  const k = 1 - Math.exp(-dt / DRIFT_SECONDS);
  let mx = (d.x - cam.x) * k;
  let my = (d.y - cam.y) * k;
  const len = Math.hypot(mx, my);
  const cap = DRIFT_MAX_SPEED * dt;
  if (len > cap) {
    mx *= cap / len;
    my *= cap / len;
  }
  cam.x += mx;
  cam.y += my;
  clampCamera(cam);
}
