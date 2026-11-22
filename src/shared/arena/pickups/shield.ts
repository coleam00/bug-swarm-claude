// The test shield (#73): a bubble that blocks the next hit. It lasts until it blocks one or
// SHIELD_S pass. Its effect's one hook point is sim.ts strikePlayer, every hit's entry.
import { DT, PICKUP_IDS } from "../constants";
import type { Player } from "../sim";
import type { PickupDef } from "./kind";

/** How long an unused shield lasts, seconds. */
export const SHIELD_S = 10;
/** How long it lies on the floor, seconds. */
export const SHIELD_FLOOR_S = 12;

export const shield: PickupDef = {
  id: "shield",
  label: "Test shield!",
  // Each kind's pickup chance, split evenly over the 4 pickups (#84, #78's rule: each kind's total
  // unchanged): crawler 1.5%, dasher and spitter 3% in all, 0.375% and 0.75% each (half the item's
  // starting 3% and 6%, set by the late-joiner gate, #73; the spitter, #72, drops as the dasher does).
  // A glob is a shot in flight and drops nothing. A beetle (#80) takes 8 shots and drops twice what a
  // dasher does: 6% in all, 1.5% each.
  drop: { crawler: 0.00375, dasher: 0.0075, spitter: 0.0075, glob: 0, beetle: 0.015 },
  floorTicks: Math.round(SHIELD_FLOOR_S / DT),
  durationTicks: Math.round(SHIELD_S / DT),
};

const SHIELD = PICKUP_IDS.indexOf("shield");

/** The effect: if `p` has a shield, it is spent on this hit and the hit is blocked (true). */
export function shieldBlocks(p: Player): boolean {
  if (p.effect[SHIELD]! <= 0) return false;
  p.effect[SHIELD] = 0;
  return true;
}
