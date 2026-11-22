// The hive queen (#85): a boss the arena itself places every QUEEN_EVERY_WAVES-th wave (queen.ts,
// one level up: her arrival, toughness, goal and reward). This file is only how she moves and what
// she launches, a kind like any other on the seam (kind.ts).
// - drift: she moves at QUEEN_SPEED toward her goal (b.gx, b.gy: the largest group of players,
//   written by queen.ts every tick), stopping GOAL_NEAR short of it, for DRIFT_TICKS ticks.
// - tell: she stands still for TELL_TICKS (1 s; her abdomen glows in the browser), then turns her
//   ring's line (b.dx, b.dy) by RING_TURN and fires a ring of RING_COUNT stock globs evenly round
//   it (STEP_LAUNCH_ALT), and drifts again: a ring every 6 s.
// - brood: every BROOD_TICKS (4 s, counted in b.travel from her arrival), in any phase, she births
//   BROOD_COUNT stock crawlers round her (STEP_LAUNCH). On the tick a ring fires, the brood waits a tick.
// Contact costs a hit and she stays (staysOnContact). Her hit points are set by queen.ts at her
// arrival; a kill scores no kind points (queen.ts pays the reward instead).
import { DT, MAX_BUGS_PER_ARENA, WORLD_H, WORLD_W } from "../constants";
import type { Bug, Player } from "../sim";
import { GLOB_SPEED } from "./glob";
import { STEP_LAUNCH, STEP_LAUNCH_ALT, type BugKindDef } from "./kind";

/** She arrives at the start of every wave that is a multiple of this (queen.ts). */
export const QUEEN_EVERY_WAVES = 5;
/** Collision radius, units (drawn larger, draw/bugs/queen.ts). */
export const QUEEN_RADIUS = 40;
/**
 * Drift speed toward her goal, units per second: 40% of a player's top speed, so anyone can walk
 * away from her. The item's 45 kept her off the scripted aimers' screens (they keep away from bugs
 * and shoot only the nearest): 4 aimers never killed her within 180 s on 30 seeds. Set with her hit
 * points (queen.ts) by `bun run skill`'s queen line (#85).
 */
export const QUEEN_SPEED = 120;
/** She stops this far short of her goal, units. */
export const GOAL_NEAR = 60;
/** Ticks of drift before each tell, and the tell itself (1 s): a ring every 6 s. */
export const DRIFT_TICKS = Math.round(5 / DT);
export const TELL_TICKS = Math.round(1 / DT);
/** Globs in a ring, and how far each ring's line turns from the last, radians (15 degrees). */
export const RING_COUNT = 12;
export const RING_TURN = Math.PI / 12;
/**
 * Crawlers in a brood, and the ticks between broods (4 s, the first 4 s after she arrives). The
 * item's 3 read the late-joiner gate at 0.797x (FAIL) on 240 late seeds and 0.81x on 480; 2 read
 * 0.82x on both (3 every 5 s: 0.81x on both). The late joiner meets the wave-20 queen 30 s after she
 * arrived (#85).
 */
export const BROOD_COUNT = 2;
export const BROOD_TICKS = Math.round(4 / DT);
/** Her brood stops while the arena holds this many bugs, so a ring always has room (MAX less RING_COUNT). */
export const BROOD_CAP = MAX_BUGS_PER_ARENA - RING_COUNT;

export const QUEEN_PHASES = ["drift", "tell"] as const;
export const [DRIFT, TELL] = [0, 1] as const;

const RING_C = Math.cos(RING_TURN);
const RING_S = Math.sin(RING_TURN);

/** One drift tick toward (b.gx, b.gy), stopping GOAL_NEAR short, held inside the walls. */
function drift(b: Bug): void {
  const tx = b.gx - b.x;
  const ty = b.gy - b.y;
  const d = Math.hypot(tx, ty);
  const step = Math.min(QUEEN_SPEED * DT, Math.max(0, d - GOAL_NEAR));
  if (step <= 0) {
    b.vx = 0;
    b.vy = 0;
    return;
  }
  b.vx = (tx / d) * QUEEN_SPEED;
  b.vy = (ty / d) * QUEEN_SPEED;
  const R = QUEEN_RADIUS;
  b.x = Math.min(WORLD_W - R, Math.max(R, b.x + (tx / d) * step));
  b.y = Math.min(WORLD_H - R, Math.max(R, b.y + (ty / d) * step));
}

/**
 * Credits `p` with `dmg` hit points dealt to bug `b` when `b` is the queen, at most the `hpBefore`
 * she had (#85). Every damage source calls it where it hits: shots (combat.ts stepShots, for the
 * life that fired; the CI drone's, #84, are shots too) and the refactor bomb (pickups/bomb.ts). A
 * new damage source that is not a shot must call it too, or its damage is never paid (queen.ts
 * payQueen). Here, not in queen.ts, so combat.ts and bomb.ts import nothing that imports the
 * simulation.
 */
export function creditQueen(p: Player, b: Bug, dmg: number, hpBefore: number): void {
  if (b.kind === "queen") p.queenDmg += Math.min(dmg, hpBefore);
}

export const queen: BugKindDef = {
  id: "queen",
  phases: QUEEN_PHASES,
  radius: QUEEN_RADIUS,
  // Set at her arrival (queen.ts queenHp); never spawned with this.
  hp: 1,
  // The reward (queen.ts payQueen) replaces kill points.
  points: 0,
  // Never from the mix (a share of 0); queen.ts places her. At most one, ever.
  spawn: { unlockWave: QUEEN_EVERY_WAVES, share: () => 0, maxPerArena: 1 },
  boss: true,
  staysOnContact: true,
  launches: [
    { kind: "crawler", speed: 0, count: BROOD_COUNT, capAt: BROOD_CAP },
    { kind: "glob", speed: GLOB_SPEED, count: RING_COUNT, capAt: MAX_BUGS_PER_ARENA },
  ],
  step(b) {
    let ring = false;
    b.phaseTicks++;
    if (b.phase === DRIFT) {
      drift(b);
      if (b.phaseTicks >= DRIFT_TICKS) {
        b.phase = TELL;
        b.phaseTicks = 0;
      }
    } else {
      b.vx = 0;
      b.vy = 0;
      if (b.phaseTicks >= TELL_TICKS) {
        const dx = b.dx * RING_C - b.dy * RING_S;
        b.dy = b.dx * RING_S + b.dy * RING_C;
        b.dx = dx;
        b.phase = DRIFT;
        b.phaseTicks = 0;
        ring = true;
      }
    }
    if (b.travel > 0) b.travel--;
    if (ring) return STEP_LAUNCH_ALT;
    if (b.travel <= 0) {
      b.travel = BROOD_TICKS;
      return STEP_LAUNCH;
    }
  },
};
