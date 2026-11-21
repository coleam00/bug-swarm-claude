// The test shield (#73): a bubble that blocks the next hit. It lasts until it blocks one or
// SHIELD_S pass. Its effect's one hook point is sim.ts strikePlayer, every hit's entry.
import { DT, PICKUP_IDS } from "../constants";
import type { Player } from "../sim";
import type { PickupDef } from "./kind";

/** How long an unused shield lasts, seconds. */
export const SHIELD_S = 20;
/** How long it lies on the floor, seconds. */
export const SHIELD_FLOOR_S = 12;

export const shield: PickupDef = {
  id: "shield",
  label: "Test shield!",
  // Half of each kind's pickup chance (crawler 3%, dasher 6%), split evenly over the pickups.
  drop: { crawler: 0.015, dasher: 0.03 },
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
