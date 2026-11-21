// The bug-kind registry (#65): every kind id has a definition the stepper can use.
import { describe, expect, test } from "bun:test";
import { BUG_KINDS } from "../constants";
import { BASE_KIND, BUG_DEFS, MAX_BUG_RADIUS, bugDef } from "./registry";

describe("bug kinds", () => {
  test("every id in BUG_KINDS has a definition with phases, a positive radius, hit points and points", () => {
    expect(Object.keys(BUG_DEFS).sort()).toEqual([...BUG_KINDS].sort());
    for (const k of BUG_KINDS) {
      const d = bugDef(k);
      expect(d.id).toBe(k);
      expect(d.phases.length).toBeGreaterThan(0);
      expect(d.radius).toBeGreaterThan(0);
      expect(d.hp).toBeGreaterThan(0);
      expect(d.points).toBeGreaterThan(0);
      expect(d.spawn.unlockWave).toBeGreaterThanOrEqual(1);
      expect(d.spawn.maxPerArena).toBeGreaterThan(0);
    }
  });

  test("the base kind is the first id and spawns from wave 1; MAX_BUG_RADIUS covers every kind", () => {
    expect(BASE_KIND).toBe(BUG_KINDS[0]);
    expect(bugDef(BASE_KIND).spawn.unlockWave).toBe(1);
    for (const k of BUG_KINDS) expect(bugDef(k).radius).toBeLessThanOrEqual(MAX_BUG_RADIUS);
  });
});
