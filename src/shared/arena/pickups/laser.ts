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
  // Each kind's pickup chance, split evenly over the 3 pickups (#78): crawler 1.5%, dasher and spitter
  // 3% in all (half the item's starting 3% and 6%, set by the late-joiner gate, #73; the spitter, #72,
  // drops as the dasher does). A glob is a shot in flight and drops nothing. A beetle (#80) takes 8
  // shots and drops twice what a dasher does: 6% in all.
  drop: { crawler: 0.005, dasher: 0.01, spitter: 0.01, glob: 0, beetle: 0.02 },
  floorTicks: Math.round(LASER_FLOOR_S / DT),
  durationTicks: Math.round(LASER_S / DT),
};

const LASER = PICKUP_IDS.indexOf("laser");

/** The effect: how many bugs a shot `p` fires now may hit (LASER_PIERCE with the laser, else 1). */
export function laserPierce(p: Player): number {
  return p.effect[LASER]! > 0 ? LASER_PIERCE : 1;
}
