// What a pickup is (#73, architecture.md "Pickups (the recipe)"). Each pickup is one file in this
// folder exporting a PickupDef, listed in registry.ts, plus the plain functions that are its effect,
// which the simulation calls at the effect's one hook point. The stepper (index.ts) drops, ages and
// hands out every pickup the same way; a pickup only says how often it drops, how long it lies on
// the floor and how long its effect lasts.
import type { BugKind, PickupId } from "../constants";

export type PickupDef = {
  id: PickupId;
  /** The floating label over whoever takes it, e.g. "Test shield!". Shared, so the browser and tests read one string. */
  label: string;
  /**
   * The chance, 0 to 1, that a kill of each bug kind drops this pickup. A Record over BUG_KINDS, so
   * a new kind does not compile until every pickup has its number. A kind's chances summed over
   * every pickup are at most 1 (registry.test.ts).
   */
  drop: Record<BugKind, number>;
  /** Ticks it lies on the floor before it goes. */
  floorTicks: number;
  /**
   * Ticks its effect lasts once taken (a shield also ends when it blocks a hit). 0 for an instant
   * pickup (the refactor bomb, #78): its effect happens at the take, it sets no effects bit and
   * shows no HUD timer.
   */
  durationTicks: number;
};
