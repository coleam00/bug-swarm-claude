// The invisibility cloak (#132, asked for by chat on the stream): for CLOAK_S the bugs stop
// targeting you. Its effect's one hook point is bugs/index.ts chooseTarget, where each bug is
// handed the player it goes for: a cloaked player is skipped, so crawlers, a dasher's lock and a
// spitter's aim all go for the nearest uncloaked player who is up, or no one. Contact still
// hurts: a bug that walks into a cloaked player still costs a hit (the stepper's contact pass is
// untouched), so it is a dodge tool, not invincibility.
import { DT, PICKUP_IDS } from "../constants";
import type { Player } from "../sim";
import type { PickupDef } from "./kind";

/** How long the cloak lasts, seconds. */
export const CLOAK_S = 10;
/** How long it lies on the floor, seconds. */
export const CLOAK_FLOOR_S = 12;

export const cloak: PickupDef = {
  id: "cloak",
  label: "Cloak!",
  // Each kind's pickup chance, split evenly over the 5 pickups (#132, #78's rule): crawler 3.75%,
  // dasher and spitter 7.5%, beetle 15% in all; 0.75%, 1.5% and 3% each (see shield.ts).
  drop: { crawler: 0.0075, dasher: 0.015, spitter: 0.015, glob: 0, beetle: 0.03, queen: 0 },
  floorTicks: Math.round(CLOAK_FLOOR_S / DT),
  durationTicks: Math.round(CLOAK_S / DT),
};

/** The cloak's index in a player's effects (PICKUP_IDS). */
export const CLOAK = PICKUP_IDS.indexOf("cloak");

/** The effect: true while `p` is cloaked, so no bug picks them as its target. */
export function cloaked(p: Player): boolean {
  return p.effect[CLOAK]! > 0;
}
