// The review laser (#73): for LASER_S your shots pierce, each hitting up to LASER_PIERCE bugs and
// ending on the last, and are drawn as a longer, brighter beam. Its effect's one hook point is
// combat.ts: fireShot stamps a shot with laserPierce, and stepShots walks the pierce.
import { DT, PICKUP_IDS } from "../constants";
import type { Player } from "../sim";
import type { PickupDef } from "./kind";

/** How long the laser lasts, seconds. */
export const LASER_S = 4;
/** How long it lies on the floor, seconds. */
export const LASER_FLOOR_S = 12;
/**
 * The most bugs one laser shot hits; it ends on the last. A shot remembers the ids it already hit
 * in two fields (sim.ts Shot hitA, hitB), so this is at most 3 (laser.test.ts checks it).
 */
export const LASER_PIERCE = 3;

export const laser: PickupDef = {
  id: "laser",
  label: "Review laser!",
  // Each kind's pickup chance, split evenly over the 5 pickups (#132, #78's rule): crawler 3.75%,
  // dasher and spitter 7.5%, beetle 15% in all; 0.75%, 1.5% and 3% each. That is #90's x2.5
  // of the numbers #73 had halved for the late-joiner gate, set by measurement so an aimer takes 2 to
  // 3 pickups a life (`bun run skill`). The spitter (#72) drops as the dasher does; a beetle (#80)
  // takes 8 shots and drops twice what a dasher does. A glob is a shot in flight and drops nothing.
  drop: { crawler: 0.0075, dasher: 0.015, spitter: 0.015, glob: 0, beetle: 0.03, queen: 0 },
  floorTicks: Math.round(LASER_FLOOR_S / DT),
  durationTicks: Math.round(LASER_S / DT),
};

const LASER = PICKUP_IDS.indexOf("laser");

/** The effect: how many bugs a shot `p` fires now may hit (LASER_PIERCE with the laser, else 1). */
export function laserPierce(p: Player): number {
  return p.effect[LASER]! > 0 ? LASER_PIERCE : 1;
}
