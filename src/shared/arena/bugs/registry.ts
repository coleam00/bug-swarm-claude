// Every bug kind, by id (#65). The Record makes TypeScript demand an entry for each id in
// constants.ts BUG_KINDS, so a kind cannot be named without being defined.
import { BUG_KINDS, type BugKind } from "../constants";
import { beetle } from "./beetle";
import { crawler } from "./crawler";
import { dasher } from "./dasher";
import { glob } from "./glob";
import type { BugKindDef } from "./kind";
import { spitter } from "./spitter";

export const BUG_DEFS: Record<BugKind, BugKindDef> = { crawler, dasher, spitter, glob, beetle };

export function bugDef(kind: BugKind): BugKindDef {
  return BUG_DEFS[kind];
}

/** The base kind: what a spawn is when the mix picks no other. */
export const BASE_KIND: BugKind = BUG_KINDS[0];

/**
 * The largest radius of any kind but a boss (#85), units: for checks that hold for every spawned
 * kind (spawn clamps, view). A boss is placed by its own code and drawn from the snapshot's own
 * field, so its size moves none of them (a 15-unit spitter alone moved the late gate, #72).
 */
export const MAX_BUG_RADIUS = Math.max(...BUG_KINDS.filter((k) => !BUG_DEFS[k].boss).map((k) => BUG_DEFS[k].radius));
