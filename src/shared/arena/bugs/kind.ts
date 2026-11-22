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
   * Optional (#72): what this kind launches. `step` returning STEP_LAUNCH launches `launches[0]`,
   * STEP_LAUNCH_ALT `launches[1]` (#85: a queen's brood and her ring).
   */
  launches?: readonly Launch[];
  /**
   * Optional (#85): touching a player who can be hit costs them a hit (strikePlayer) and the bug
   * stays, striking every such player it touches that tick; strikePlayer's untouchable time stops
   * a repeat hit. Without it, a touch spends the bug.
   */
  staysOnContact?: true;
  /**
   * Optional (#85): a boss, placed by its own arena-level code, never by a spawn. MAX_BUG_RADIUS
   * leaves it out, so its size never moves the spawn clamps and view checks every other kind uses.
   */
  boss?: true;
  /**
   * Optional (#80): a front shell centred on the bug's facing, its unit (b.dx, b.dy). A shot
   * travelling within acos(cosHalf) of straight against that facing is blocked (combat.ts
   * shellBlocks): no damage, the shot ends, the shooter's streak neither grows nor resets (#90). A zero facing blocks
   * nothing. The policies read the same rule, so bots flank (policies.ts).
   */
  shell?: { cosHalf: number };
  /**
   * One tick of its behaviour: sets b.x, b.y, b.vx, b.vy and its phase fields (phase,
   * phaseTicks, dx, dy, travel). `target` is the nearest player who is up, or null, and
   * `targetAge` that player's pressure age in seconds (index.ts pressureAge: the life's age, held
   * back on a session's first life; 0 with no target), so a kind can spare young lives as the
   * spawn mix does (#72: a spitter does not start a tell at a target under 60 s; #86: a beetle
   * stands). Pure, draws no randomness and allocates nothing. Contact is the stepper's, the same
   * for every kind. Returns nothing (or STEP_KEEP) to stay as it is; STEP_LAUNCH to launch
   * `launches[0]` from its muzzle along (b.dx, b.dy) this tick (STEP_LAUNCH_ALT: `launches[1]`,
   * #85); STEP_EXPIRE to leave the arena now, untouched and unscored (a glob that fades or meets a
   * wall).
   */
  step(b: Bug, target: Player | null, targetAge: number): BugStepResult | void;
};

/**
 * One thing a kind launches (#72; #85 adds the count and the cap): `count` bugs of `kind`, the
 * first along the launcher's (dx, dy) and the rest evenly round the full turn from it, each leaving
 * at `speed` units per second. Each is launched only while the arena holds fewer than `capAt` bugs
 * and fewer than its kind's maxPerArena of that kind.
 */
export type Launch = { kind: BugKind; speed: number; count: number; capAt: number };

/** What a step asks of the stepper (#72): a number, so a step allocates nothing. */
export type BugStepResult = typeof STEP_KEEP | typeof STEP_LAUNCH | typeof STEP_EXPIRE | typeof STEP_LAUNCH_ALT;
export const STEP_KEEP = 0;
export const STEP_LAUNCH = 1;
export const STEP_EXPIRE = 2;
export const STEP_LAUNCH_ALT = 3;
