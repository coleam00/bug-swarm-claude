// Every tuning number in the game, in one place. Distances are arena units, times seconds.
// The simulation (sim.ts), the arena (arena.ts) and the drawing (loop.ts) import from here.

// The arena: the same area on every screen, in the screen's ratio between 9:16 and 16:9.
export const ARENA_AREA = 360_000;
/** Width over height: the tallest arena (9:16) and the widest (16:9). */
export const ARENA_RATIO_MIN = 9 / 16;
export const ARENA_RATIO_MAX = 16 / 9;

// The robot and its gun.
export const ROBOT_RADIUS = 14;
export const ROBOT_SPEED = 260;
export const FIRE_INTERVAL = 0.25;
export const SHOT_SPEED = 700;
export const SHOT_LIFETIME = 1.0;
export const INVULN_SECONDS = 1.0;
export const MAX_HITS = 3;

// The swarm.
/** A safety cap for the frame budget, not part of the difficulty: an idle run ends long before it. */
export const MAX_BUGS = 200;
/** Seconds between spawns at the start of a run, */
export const SPAWN_START = 0.62;
/** the seconds it loses for every second survived, */
export const SPAWN_RAMP = 0.007;
/** and the shortest it gets. */
export const SPAWN_MIN = 0.42;

/** Seconds between spawns `time` seconds into a run: shorter as the run goes on, down to a floor. */
export function spawnInterval(time: number): number {
  return Math.max(SPAWN_MIN, SPAWN_START - SPAWN_RAMP * time);
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
  color: string;
  from: number;
  share: number;
};

/** Every kind of bug. The first is the base kind, there from the start. */
export const BUG_KINDS = [
  { id: "base", radius: 12, speed: 90, hp: 2, color: "#f97316", from: 0, share: 1 },
  // Small, quick and fragile: one shot squashes it.
  { id: "fast", radius: 8, speed: 150, hp: 1, color: "#a3e635", from: 30, share: 0.25 },
] as const satisfies readonly BugKind[];

export const BASE_BUG: BugKind = BUG_KINDS[0];
