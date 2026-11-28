// The test shield (#73): a bubble that blocks the next hit. It lasts until it blocks one or
// SHIELD_S pass. Its effect's one hook point is sim.ts strikePlayer, every hit's entry. A player's
// first life in a session also starts with it up (#90, FIRST_LIFE_SHIELD_S).
import { DT, PICKUP_IDS } from "../constants";
import type { Player } from "../sim";
import type { PickupDef } from "./kind";

/** How long an unused shield lasts, seconds. */
export const SHIELD_S = 10;
/** How long it lies on the floor, seconds. */
export const SHIELD_FLOOR_S = 12;
/**
 * The catch-up mechanic (#90, owner ruling): a player's first life in a session (Player.firstLife,
 * a join, a reconnect included) spawns with the shield up, the same effect and bubble as the pickup,
 * spent on the first hit it blocks (sim.ts startLife). It lasts this long, seconds: longer than a
 * usual 1 to 4 minute life, so in practice until that hit. The pickup's SHIELD_S would be spent
 * before it mattered: a first life's pressure starts FIRST_LIFE_EASY_S late, so no bug arrives in it.
 */
export const FIRST_LIFE_SHIELD_S = 300;
export const FIRST_LIFE_SHIELD_TICKS = Math.round(FIRST_LIFE_SHIELD_S / DT);

export const shield: PickupDef = {
  id: "shield",
  label: "Test shield!",
  // Each kind's pickup chance, split evenly over the 4 pickups (#84, #78's rule): crawler 3.75%,
  // dasher and spitter 7.5%, beetle 15% in all; 0.9375%, 1.875% and 3.75% each. That is #90's x2.5
  // of the numbers #73 had halved for the late-joiner gate, set by measurement so an aimer takes 2 to
  // 3 pickups a life (`bun run skill`). The spitter (#72) drops as the dasher does; a beetle (#80)
  // takes 8 shots and drops twice what a dasher does. A glob is a shot in flight and drops nothing.
  drop: { crawler: 0.009375, dasher: 0.01875, spitter: 0.01875, glob: 0, beetle: 0.0375, queen: 0, golden: 0 },
  floorTicks: Math.round(SHIELD_FLOOR_S / DT),
  durationTicks: Math.round(SHIELD_S / DT),
};

/** The shield's index in a player's effects (PICKUP_IDS). */
export const SHIELD = PICKUP_IDS.indexOf("shield");

/** The effect: if `p` has a shield, it is spent on this hit and the hit is blocked (true). */
export function shieldBlocks(p: Player): boolean {
  if (p.effect[SHIELD]! <= 0) return false;
  p.effect[SHIELD] = 0;
  return true;
}
