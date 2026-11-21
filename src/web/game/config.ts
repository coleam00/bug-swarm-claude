// Every tuning number in the game, in one place. Distances are arena units, times seconds.
// The simulation (sim.ts), the arena (arena.ts) and the drawing (look.ts, render.ts, sprites.ts) import from here.
import { CI_DRONE, REFACTOR_BOMB, REVIEW_LASER, TEST_SHIELD, type UpgradeId } from "../../server/rules";

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
 * a minute or two more.
 */
export const MOVING_FIRE_RATE = 1.8;
export const SHOT_SPEED = 700;
export const SHOT_LIFETIME = 1.0;
export const INVULN_SECONDS = 1.0;
export const MAX_HITS = 3;

// The swarm.
/** A safety cap for the frame budget, not part of the difficulty: an idle run ends long before it. */
export const MAX_BUGS = 200;
// The spawn interval falls in two stages: quickly over the first 50 s or so, past what a robot
// standing still can shoot down, then a little more slowly to a plateau at about 57 s. From
// SURGE_FROM the swarm surges: the interval keeps falling to its last floor and every bug speeds
// up, so a robot that keeps moving is overrun after a minute or two more, whatever it picked.
/** Seconds between spawns at the start of a run, */
export const SPAWN_START = 0.62;
/** and the seconds it loses for every second survived early on. */
export const SPAWN_RAMP = 0.007;
/** The late stage: the interval it would have at 0 s, */
export const SPAWN_LATE = 0.45;
/** and the seconds it loses for every second survived. */
export const SPAWN_LATE_RAMP = 0.0035;
/** Where the two stages level off, at about 57 s. */
export const SPAWN_PLATEAU = 0.25;
/** The second of the run the surge starts: the spawn interval and the bugs' speed ramp again. */
export const SURGE_FROM = 60;
/** The surge: seconds the spawn interval loses for every second survived past SURGE_FROM. */
export const SURGE_SPAWN_RAMP = 0.003;
/** The last floor, reached at about 83 s. Its inverse bounds squashes a second (sim.ts). */
export const SPAWN_MIN = 0.18;
/** The surge: the part of its base speed every bug gains for every second survived past SURGE_FROM. */
export const SURGE_SPEED = 0.035;

/** Seconds between spawns `time` seconds into a run: shorter as the run goes on, down to a floor. */
export function spawnInterval(time: number): number {
  const ramp = Math.max(SPAWN_PLATEAU, SPAWN_START - SPAWN_RAMP * time, SPAWN_LATE - SPAWN_LATE_RAMP * time);
  return time <= SURGE_FROM ? ramp : Math.max(SPAWN_MIN, ramp - SURGE_SPAWN_RAMP * (time - SURGE_FROM));
}

/**
 * How fast the swarm moves `time` seconds into a run, as a multiple of each kind's base speed.
 * It applies to every bug on screen at once, by run time: 1 up to SURGE_FROM, then rising
 * without end, so no build holds forever. The fast bug passes the robot's speed at about 89 s
 * and the base bug at about 125 s.
 */
export function swarmSpeed(time: number): number {
  return 1 + SURGE_SPEED * Math.max(0, time - SURGE_FROM);
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

// Upgrades. The ids live in rules.ts (UPGRADE_IDS); each array here is indexed by level, 0 to 2.
/** Seconds of run time between upgrade choices. The choice pauses the run. */
export const CHOICE_EVERY = 20;
/** Cards on offer at each choice, all different (fewer when fewer upgrades are left to take). */
export const CHOICE_CARDS = 3;
/** Review laser: bugs a shot passes through after its first hit. */
export const LASER_PIERCE = [0, 1, 3] as const;
/** Review laser: how much longer the shot is drawn. */
export const LASER_BEAM = [1, 1.8, 2.6] as const;
/** Refactor bomb: seconds of run time it takes to recharge after a blast. */
export const BOMB_RECHARGE = [0, 30, 15] as const;
/** Refactor bomb: seconds of run time its ring takes to sweep the arena. */
export const BOMB_RING_SECONDS = 0.5;
/**
 * Test shield: the hits the bubble holds when it is taken at each level. A pick renews the
 * bubble at its level's charges (a spent one too); charges never come back on their own.
 */
export const SHIELD_CHARGES = [0, 1, 2] as const;
/** CI drone: drones orbiting the robot. The second level adds a second drone, opposite the first. */
export const DRONE_COUNT = [0, 1, 2] as const;
/** CI drone: the orbit's radius, from the robot's centre. */
export const DRONE_ORBIT = 34;
/** CI drone: radians a second around the orbit. */
export const DRONE_SPIN = 3;
/** CI drone: the drone's drawn radius. */
export const DRONE_RADIUS = 5;
/**
 * CI drone: seconds between a drone's shots while the robot moves. It doesn't reload faster for
 * moving, but slower for standing still (DRONE_STILL_RATE).
 */
export const DRONE_FIRE_INTERVAL = 0.5;
/**
 * CI drone: the part of its reload rate a drone keeps while the robot stands still, the gun's
 * "moving pays" rule (operator ruling on #18). Without it an idle player who is offered the
 * drone outlasts 60 s (bun run pacing: idle up to 84 s).
 */
export const DRONE_STILL_RATE = 1 / 3;
/** CI drone: a drone fires only at a bug within this distance of itself. */
export const DRONE_RANGE = 220;
/** CI drone: seconds a drone's shot flies, enough to cross its range at SHOT_SPEED. */
export const DRONE_SHOT_LIFETIME = 0.45;

/** What each upgrade's card says. A Record over the ids, so an id without a card fails tsc. */
export const UPGRADES: Record<UpgradeId, { name: string; line: string }> = {
  [REVIEW_LASER]: { name: "Review laser", line: "Shots pierce through bugs" },
  [REFACTOR_BOMB]: { name: "Refactor bomb", line: "Clears the screen, recharges in 30 s (15 s if taken twice)" },
  [TEST_SHIELD]: { name: "Test shield", line: "Blocks the next hit" },
  [CI_DRONE]: { name: "CI drone", line: "A drone orbits you and fires too, while you move" },
};
