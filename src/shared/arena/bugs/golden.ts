// The golden bug (#122): a rare bonus that runs away. It never hurts anyone (harmless: touching a
// player does nothing), takes 2 hits and pays 100 points (times the streak multiplier, like any
// kill) to whoever lands the killing hit. The mix never spawns it (its share is 0): its own
// arena-level timer places it (../golden.ts), at most one at a time.
// - flee: runs straight away from the nearest player who is up at GOLDEN_SPEED (no one up: it
//   stands), sliding along a wall it meets; a corner traps it. After GOLDEN_LIFE_TICKS it leaves,
//   unscored.
import { DT, WORLD_H, WORLD_W } from "../constants";
import { CRAWLER_SPEED } from "./crawler";
import { STEP_EXPIRE, type BugKindDef } from "./kind";

/** Collision radius, units: a crawler's 12 or under, so it moves no spawn clamp (MAX_BUG_RADIUS). */
export const GOLDEN_RADIUS = 11;
/** Speed, units per second: 1.4x a crawler's (224), under a player's 300, so it can be run down. */
export const GOLDEN_SPEED = 1.4 * CRAWLER_SPEED;
/** How long it stays before it leaves unscored, seconds, and in ticks. */
export const GOLDEN_LIFE_S = 20;
export const GOLDEN_LIFE_TICKS = Math.round(GOLDEN_LIFE_S / DT);
/** Its kill's points, before the streak multiplier. */
export const GOLDEN_POINTS = 100;

export const golden: BugKindDef = {
  id: "golden",
  phases: ["flee"],
  radius: GOLDEN_RADIUS,
  hp: 2,
  points: GOLDEN_POINTS,
  // Never in the mix: ../golden.ts places it on its own timer.
  spawn: { unlockWave: 1, share: () => 0, maxPerArena: 1 },
  harmless: true,
  step(b, target) {
    if (++b.phaseTicks >= GOLDEN_LIFE_TICKS) return STEP_EXPIRE;
    if (!target) {
      b.vx = 0;
      b.vy = 0;
      return;
    }
    let dx = b.x - target.x;
    let dy = b.y - target.y;
    const d = Math.hypot(dx, dy);
    if (d > 0) {
      dx /= d;
      dy /= d;
    } else {
      dx = 1;
      dy = 0;
    }
    const step = GOLDEN_SPEED * DT;
    const R = GOLDEN_RADIUS;
    const x = Math.min(WORLD_W - R, Math.max(R, b.x + dx * step));
    const y = Math.min(WORLD_H - R, Math.max(R, b.y + dy * step));
    b.vx = (x - b.x) / DT;
    b.vy = (y - b.y) / DT;
    b.x = x;
    b.y = y;
  },
};
