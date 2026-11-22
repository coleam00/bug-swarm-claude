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

/** The largest radius of any kind, units: for checks that hold for every kind (spawn clamps, view). */
export const MAX_BUG_RADIUS = Math.max(...BUG_KINDS.map((k) => BUG_DEFS[k].radius));
