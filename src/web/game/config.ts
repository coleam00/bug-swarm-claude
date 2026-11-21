// Every tuning number in the game, in one place. Distances are arena units, times seconds.
// The simulation (sim.ts), the arena (arena.ts) and the drawing (look.ts, render.ts, sprites.ts) import from here.

// The arena: the same area on every screen, in the screen's ratio between 9:16 and 16:9.
export const ARENA_AREA = 360_000;
/** Width over height: the tallest arena (9:16) and the widest (16:9). */
export const ARENA_RATIO_MIN = 9 / 16;
export const ARENA_RATIO_MAX = 16 / 9;

// The robot and its gun.
export const ROBOT_RADIUS = 14;
export const ROBOT_SPEED = 260;
export const FIRE_INTERVAL = 0.25;
/**
 * How much faster the gun reloads while the robot moves. It is what makes moving pay: a robot
 * that stands still can't keep up with the swarm past about 30 s, one that keeps moving can for
 * a minute or two more. 4 x 1.4 = 5.6 shots a second stays under the server's squash cap of 6.
 */
export const MOVING_FIRE_RATE = 1.4;
export const SHOT_SPEED = 700;
export const SHOT_LIFETIME = 1.0;
export const INVULN_SECONDS = 1.0;
export const MAX_HITS = 3;

// The swarm.
/** A safety cap for the frame budget, not part of the difficulty: an idle run ends long before it. */
export const MAX_BUGS = 200;
// The spawn interval falls in two stages: quickly over the first 30 s, past what a robot
// standing still can shoot down, then slowly, so a robot that keeps moving (and fires faster)
// is overrun only after a minute or two more.
/** Seconds between spawns at the start of a run, */
export const SPAWN_START = 0.62;
/** and the seconds it loses for every second survived early on. */
export const SPAWN_RAMP = 0.007;
/** The late stage: the interval it would have at 0 s, */
export const SPAWN_LATE = 0.45;
/** and the seconds it loses for every second survived. */
export const SPAWN_LATE_RAMP = 0.0015;
/** The shortest interval, reached at 100 s. */
export const SPAWN_MIN = 0.3;

/** Seconds between spawns `time` seconds into a run: shorter as the run goes on, down to a floor. */
export function spawnInterval(time: number): number {
  return Math.max(SPAWN_MIN, SPAWN_START - SPAWN_RAMP * time, SPAWN_LATE - SPAWN_LATE_RAMP * time);
}

/**
 * A kind of bug. `from` is the second of the run it starts appearing at; `share` is the part
 * of spawns it takes once it does (the base kind takes whatever the others leave).
 */
export type BugKind = {
  id: string;
  radius: number;
  /** Units a second. */
  speed: number;
  /** Shots it takes to squash. */
  hp: number;
  from: number;
  share: number;
};

/** Every kind of bug. The first is the base kind, there from the start. */
export const BUG_KINDS = [
  { id: "base", radius: 12, speed: 90, hp: 2, from: 0, share: 1 },
  // Small, quick and fragile: one shot squashes it.
  { id: "fast", radius: 8, speed: 150, hp: 1, from: 30, share: 0.25 },
] as const satisfies readonly BugKind[];

export const BASE_BUG: BugKind = BUG_KINDS[0];
