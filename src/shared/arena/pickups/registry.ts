// Every pickup, by id (#73). The Record makes TypeScript demand an entry for each id in
// constants.ts PICKUP_IDS, so a pickup cannot be named without being defined.
import { PICKUP_IDS, type PickupId } from "../constants";
import { bomb } from "./bomb";
import { drone } from "./drone";
import type { PickupDef } from "./kind";
import { laser } from "./laser";
import { shield } from "./shield";

export const PICKUP_DEFS: Record<PickupId, PickupDef> = { shield, laser, bomb, drone };

export function pickupDef(id: PickupId): PickupDef {
  return PICKUP_DEFS[id];
}

/** Each pickup's floating label, by its index in PICKUP_IDS (built once, so nothing builds strings per frame). */
export const PICKUP_LABELS: readonly string[] = PICKUP_IDS.map((id) => PICKUP_DEFS[id].label);
