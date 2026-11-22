// The glob (#72): what a spitter lobs. A launched kind, never spawned by the mix (its share is 0):
// the stepper makes one from a spitter's mouth (bugs/index.ts launch) with its line in (dx, dy).
// - fly: GLOB_SPEED along its line, ignoring every player, for FLY_TICKS ticks.
// - fade: on along its line for FADE_TICKS more (the browser fades it out), then it expires.
// Meeting a wall expires it at once. An expired glob leaves with no touch, kill or score.
// Contact is the stepper's, as for every kind: touching a player who can be hit costs a hit and the
// glob is spent. One shot kills it, for GLOB_POINTS times the streak multiplier, like any kill.
import { DT, WORLD_H, WORLD_W } from "../constants";
import { STEP_EXPIRE, type BugKindDef } from "./kind";

/** Collision radius, units. */
export const GLOB_RADIUS = 8;
/** Speed, units per second: slow enough to dodge, as fast as a running player. */
export const GLOB_SPEED = 300;
/** How long it flies before fading, seconds, and the fade; 2.5 s in all. */
export const FLY_TICKS = Math.round(2 / DT);
export const FADE_TICKS = Math.round(0.5 / DT);
/** Points for shooting one down, before the streak multiplier. */
export const GLOB_POINTS = 5;
/** The most globs in flight in one arena: a spitter's launch past it lobs nothing. */
export const GLOB_MAX_PER_ARENA = 12;

export const GLOB_PHASES = ["fly", "fade"] as const;
export const [FLY, FADE] = [0, 1] as const;

export const glob: BugKindDef = {
  id: "glob",
  phases: GLOB_PHASES,
  radius: GLOB_RADIUS,
  hp: 1,
  points: GLOB_POINTS,
  // Never from the spawn mix: a share of 0 is never eligible. The wave matches the spitter's.
  spawn: { unlockWave: 3, share: () => 0, maxPerArena: GLOB_MAX_PER_ARENA },
  step(b) {
    const step = GLOB_SPEED * DT;
    b.vx = b.dx * GLOB_SPEED;
    b.vy = b.dy * GLOB_SPEED;
    b.x += b.dx * step;
    b.y += b.dy * step;
    const R = GLOB_RADIUS;
    if (b.x < R || b.x > WORLD_W - R || b.y < R || b.y > WORLD_H - R) return STEP_EXPIRE;
    b.phaseTicks++;
    if (b.phase === FLY) {
      if (b.phaseTicks >= FLY_TICKS) {
        b.phase = FADE;
        b.phaseTicks = 0;
      }
    } else if (b.phaseTicks >= FADE_TICKS) return STEP_EXPIRE;
  },
};
