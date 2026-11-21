// The pickup registry (#73): every pickup id has a definition the stepper can use.
import { describe, expect, test } from "bun:test";
import { BUG_KINDS, PICKUP_IDS } from "../constants";
import { PICKUP_LABELS, pickupDef } from "./registry";

describe("pickups", () => {
  test("every pickup's definition carries its own id, a label, chances in [0, 1] and positive times", () => {
    for (const id of PICKUP_IDS) {
      const d = pickupDef(id);
      expect(d.id).toBe(id);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.floorTicks).toBeGreaterThan(0);
      expect(d.durationTicks).toBeGreaterThan(0);
      for (const k of BUG_KINDS) {
        expect(d.drop[k]).toBeGreaterThanOrEqual(0);
        expect(d.drop[k]).toBeLessThanOrEqual(1);
      }
    }
    expect(PICKUP_LABELS).toEqual(PICKUP_IDS.map((id) => pickupDef(id).label));
  });

  test("each bug kind's chances, summed over every pickup, are at most 1 (one draw picks at most one)", () => {
    for (const k of BUG_KINDS) {
      const sum = PICKUP_IDS.reduce((s, id) => s + pickupDef(id).drop[k], 0);
      expect(sum).toBeLessThanOrEqual(1);
    }
  });

  test("the numbers set by the late-joiner gate: a crawler kill drops a pickup 1.5% of the time, a dasher's 3%, split evenly", () => {
    const total = (k: (typeof BUG_KINDS)[number]) => PICKUP_IDS.reduce((s, id) => s + pickupDef(id).drop[k], 0);
    expect(total("crawler")).toBeCloseTo(0.015, 12);
    expect(total("dasher")).toBeCloseTo(0.03, 12);
    for (const id of PICKUP_IDS) expect(pickupDef(id).drop.crawler).toBeCloseTo(0.015 / PICKUP_IDS.length, 12);
  });
});
