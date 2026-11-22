// The bug-kind registry (#65): every kind id has a definition the stepper can use.
import { describe, expect, test } from "bun:test";
import { BUG_KINDS } from "../constants";
import { BASE_KIND, MAX_BUG_RADIUS, bugDef } from "./registry";

describe("bug kinds", () => {
  test("every kind's definition carries its own id, phases, a positive radius, hit points and points", () => {
    for (const k of BUG_KINDS) {
      const d = bugDef(k);
      expect(d.id).toBe(k);
      expect(d.phases.length).toBeGreaterThan(0);
      expect(d.radius).toBeGreaterThan(0);
      expect(d.hp).toBeGreaterThan(0);
      // A boss's kill pays its own reward (#85, the hive queen: queen.ts), not kind points.
      if (d.boss) expect(d.points).toBe(0);
      else expect(d.points).toBeGreaterThan(0);
      expect(d.spawn.unlockWave).toBeGreaterThanOrEqual(1);
      expect(d.spawn.maxPerArena).toBeGreaterThan(0);
    }
  });

  test("the base kind is the first id and spawns from wave 1; MAX_BUG_RADIUS covers every kind but a boss", () => {
    expect(BASE_KIND).toBe(BUG_KINDS[0]);
    expect(bugDef(BASE_KIND).spawn.unlockWave).toBe(1);
    for (const k of BUG_KINDS) if (!bugDef(k).boss) expect(bugDef(k).radius).toBeLessThanOrEqual(MAX_BUG_RADIUS);
    // A boss is placed by its own code, never spawned (#85): its size must not move the spawn checks.
    expect(MAX_BUG_RADIUS).toBe(12);
    for (const k of BUG_KINDS) if (bugDef(k).boss) expect(bugDef(k).spawn.share(600)).toBe(0);
  });
});
