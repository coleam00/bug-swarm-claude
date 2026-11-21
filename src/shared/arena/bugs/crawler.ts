// The crawler (#55): the base kind. It walks straight at the nearest player who is up.
import { DT, MAX_BUGS_PER_ARENA } from "../constants";
import type { BugKindDef } from "./kind";

/** Collision radius, units. */
export const CRAWLER_RADIUS = 12;
/** Speed, units per second, straight at the nearest player who is up (not down). */
export const CRAWLER_SPEED = 160;

export const crawler: BugKindDef = {
  id: "crawler",
  phases: ["chase"],
  radius: CRAWLER_RADIUS,
  hp: 1,
  points: 10,
  // The base kind: every spawn the mix does not give another kind.
  spawn: { unlockWave: 1, share: () => 1, maxPerArena: MAX_BUGS_PER_ARENA },
  step(b, target) {
    if (!target) {
      b.vx = 0;
      b.vy = 0;
      return;
    }
    const dx = target.x - b.x;
    const dy = target.y - b.y;
    const d = Math.hypot(dx, dy);
    const step = Math.min(d, CRAWLER_SPEED * DT);
    if (d > 0) {
      b.vx = (dx / d) * CRAWLER_SPEED;
      b.vy = (dy / d) * CRAWLER_SPEED;
      b.x += (dx / d) * step;
      b.y += (dy / d) * step;
    }
  },
};
