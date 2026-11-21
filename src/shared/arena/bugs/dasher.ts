// The dasher (#65): a lean, hot-pink bug that closes in, tells, then lunges in a straight line.
// - approach: walks at the nearest player who is up at APPROACH_SPEED (no one up: it stands).
//   On the first tick it is within TELL_RANGE of that player, it locks its line, the unit vector
//   toward where the player is on that tick, and starts its tell.
// - tell: stands still, crouched and glowing (the browser draws the line, for every player), for
//   TELL_TICKS ticks, the first one included. It never re-aims.
// - lunge: LUNGE_SPEED along the locked line for LUNGE_DIST units, ignoring every player: it
//   cannot turn. A wall ends it early.
// - recover: stands still for RECOVER_TICKS ticks, then approaches again.
// Contact is the stepper's, as for every kind: touching a player who can be hit, in any phase,
// costs a hit and the dasher is gone. A sidestep out of the line during the tell, or a dash
// through it, beats it.
import { DT, WORLD_H, WORLD_W } from "../constants";
import type { Bug } from "../sim";
import type { BugKindDef } from "./kind";

/** Collision radius, units: leaner than a crawler's 12. */
export const DASHER_RADIUS = 11;
/** Walking speed while it closes in, units per second. */
export const APPROACH_SPEED = 170;
/** It tells once its target is this close, units. */
export const TELL_RANGE = 350;
/** How long the tell lasts, seconds, and in ticks. */
export const TELL_S = 0.7;
export const TELL_TICKS = Math.round(TELL_S / DT);
/** Lunge speed, units per second: 3x a crawler's, 24 units a tick (under the 50-unit touch diameter, so it cannot pass through a player). */
export const LUNGE_SPEED = 480;
/** How far a lunge carries, units. */
export const LUNGE_DIST = 500;
/** How long it stands after a lunge, seconds, and in ticks. */
export const RECOVER_S = 1;
export const RECOVER_TICKS = Math.round(RECOVER_S / DT);
/** A life must be this old before a dasher spawns for it, seconds: the second wave's start, so a late joiner's opening matches an early one's. */
export const DASHER_FROM_S = 30;
/** Its share of a life's spawns at DASHER_FROM_S, rising by DASHER_SHARE_RAMP a second to DASHER_SHARE_MAX. */
export const DASHER_SHARE_START = 0.15;
export const DASHER_SHARE_RAMP = 0.005;
export const DASHER_SHARE_MAX = 0.35;
/** The most dashers alive in one arena. */
export const DASHER_MAX_PER_ARENA = 30;

export const DASHER_PHASES = ["approach", "tell", "lunge", "recover"] as const;
export const [APPROACH, TELL, LUNGE, RECOVER] = [0, 1, 2, 3] as const;

/** A dasher's share of the spawns for a life `lifeSeconds` old. */
export function dasherShare(lifeSeconds: number): number {
  if (lifeSeconds < DASHER_FROM_S) return 0;
  return Math.min(DASHER_SHARE_MAX, DASHER_SHARE_START + DASHER_SHARE_RAMP * (lifeSeconds - DASHER_FROM_S));
}

function enter(b: Bug, phase: number): void {
  b.phase = phase;
  b.phaseTicks = 0;
  b.vx = 0;
  b.vy = 0;
}

/** One lunge tick along the locked line; a wall or the end of its travel starts the recover. */
function lunge(b: Bug): void {
  const step = Math.min(b.travel, LUNGE_SPEED * DT);
  b.x += b.dx * step;
  b.y += b.dy * step;
  b.travel -= step;
  b.vx = b.dx * LUNGE_SPEED;
  b.vy = b.dy * LUNGE_SPEED;
  b.phaseTicks++;
  const R = DASHER_RADIUS;
  let wall = false;
  if (b.x < R || b.x > WORLD_W - R) {
    b.x = Math.min(WORLD_W - R, Math.max(R, b.x));
    wall = true;
  }
  if (b.y < R || b.y > WORLD_H - R) {
    b.y = Math.min(WORLD_H - R, Math.max(R, b.y));
    wall = true;
  }
  if (wall || b.travel <= 1e-9) {
    b.travel = 0;
    enter(b, RECOVER);
  }
}

export const dasher: BugKindDef = {
  id: "dasher",
  phases: DASHER_PHASES,
  radius: DASHER_RADIUS,
  hp: 2,
  points: 25,
  spawn: { unlockWave: 2, share: dasherShare, maxPerArena: DASHER_MAX_PER_ARENA },
  step(b, target) {
    switch (b.phase) {
      case TELL:
        b.vx = 0;
        b.vy = 0;
        if (++b.phaseTicks < TELL_TICKS) return;
        enter(b, LUNGE);
        b.travel = LUNGE_DIST;
        lunge(b);
        return;
      case LUNGE:
        lunge(b);
        return;
      case RECOVER:
        b.vx = 0;
        b.vy = 0;
        if (++b.phaseTicks <= RECOVER_TICKS) return;
        enter(b, APPROACH);
        break;
    }
    // Approach.
    if (!target) {
      b.vx = 0;
      b.vy = 0;
      return;
    }
    const dx = target.x - b.x;
    const dy = target.y - b.y;
    const d = Math.hypot(dx, dy);
    if (d <= TELL_RANGE) {
      enter(b, TELL);
      if (d > 0) {
        b.dx = dx / d;
        b.dy = dy / d;
      } else {
        b.dx = 1;
        b.dy = 0;
      }
      return;
    }
    const step = APPROACH_SPEED * DT;
    b.vx = (dx / d) * APPROACH_SPEED;
    b.vy = (dy / d) * APPROACH_SPEED;
    b.x += (dx / d) * step;
    b.y += (dy / d) * step;
    b.phaseTicks++;
  },
};
