// What a bug kind is (#65, architecture.md "Bug kinds (the recipe)"). Each kind is one file in this
// folder exporting a BugKindDef, listed in registry.ts. The stepper (index.ts) spawns, steps and
// checks contact for every kind the same way; a kind only says how big and tough it is, what it
// scores, when it spawns, and how it moves through its phases.
import type { BugKind } from "../constants";
import type { Bug, Player } from "../sim";

export type BugSpawn = {
  /** The arena's first wave (sim.ts wave) in which this kind may spawn. */
  unlockWave: number;
  /**
   * The chance, 0 to 1, that a spawn for a life of pressure age `lifeSeconds` (index.ts
   * pressureAge: the life's age, held back on a session's first life) is this kind. Depends on
   * the life, never the arena's age, so a late joiner's opening matches an early joiner's. The base
   * kind (BUG_KINDS[0]) takes whatever share the others leave, so its own is never read.
   */
  share(lifeSeconds: number): number;
  /** The most of this kind alive in one arena; past it, spawns are another kind. */
  maxPerArena: number;
};

export type BugKindDef = {
  id: BugKind;
  /**
   * Its phases, in order; a bug's `phase` is an index into this list and starts at 0. Phase 0 is
   * the quiet one: a snapshot row carries a bug's phase only when it is not 0.
   */
  phases: readonly string[];
  /** Collision radius, units: touches players at PLAYER_RADIUS + this, shots at + SHOT_RADIUS. */
  radius: number;
  /** Shots it takes to die. */
  hp: number;
  /** Points for a kill, before the streak multiplier. */
  points: number;
  spawn: BugSpawn;
  /**
   * Optional (#72): the kind this one launches (a spitter's glob), and the speed it leaves at,
   * units per second. Read when `step` returns STEP_LAUNCH.
   */
  launches?: { kind: BugKind; speed: number };
  /**
   * One tick of its behaviour: sets b.x, b.y, b.vx, b.vy and its phase fields (phase,
   * phaseTicks, dx, dy, travel). `target` is the nearest player who is up, or null, and
   * `targetAge` that player's pressure age in seconds (index.ts pressureAge: the life's age, held
   * back on a session's first life; 0 with no target), so a kind can spare young lives as the
   * spawn mix does (#72: a spitter does not start a tell at a target under 60 s). Pure, draws
   * no randomness and allocates nothing. Contact is the stepper's, the same for every kind.
   * Returns nothing (or STEP_KEEP) to stay as it is; STEP_LAUNCH to launch one `launches` bug from
   * its muzzle along (b.dx, b.dy) this tick; STEP_EXPIRE to leave the arena now, untouched and
   * unscored (a glob that fades or meets a wall).
   */
  step(b: Bug, target: Player | null, targetAge: number): BugStepResult | void;
};

/** What a step asks of the stepper (#72): a number, so a step allocates nothing. */
export type BugStepResult = typeof STEP_KEEP | typeof STEP_LAUNCH | typeof STEP_EXPIRE;
export const STEP_KEEP = 0;
export const STEP_LAUNCH = 1;
export const STEP_EXPIRE = 2;
