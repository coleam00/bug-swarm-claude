// The test shield by stepping (#73): it blocks exactly one hit, then lapses. A first life in a
// session starts with it up (#90); a respawn does not.
import { describe, expect, test } from "bun:test";
import { DT, INVULN_S, RESPAWN_DELAY_S, SPAWN_PROTECT_S } from "../constants";
import { createArena, joinPlayer } from "../sim";
import { arenaWith, bleedNow, downNow, effectOf, hold, placeBug, placePickup, stepQuiet } from "../testkit";
import { FIRST_LIFE_SHIELD_TICKS, shield } from "./shield";

const INVULN_TICKS = Math.round(INVULN_S / DT);

/** A player at (1200, 1200) holding a shield (taken from the floor in one quiet step). */
function shielded() {
  const { a, ps } = arenaWith([1200, 1200]);
  const p = ps[0]!;
  placePickup(a, 1200, 1200, "shield");
  stepQuiet(a);
  expect(effectOf(p, "shield")).toBe(shield.durationTicks);
  return { a, p };
}

describe("the test shield", () => {
  test("blocks the next contact: no hit, no touch, the bug spent, the shield gone, untouchable a moment", () => {
    const { a, p } = shielded();
    const bug = placeBug(a, 1205, 1200);
    stepQuiet(a);
    expect(a.events.blocks).toEqual([p.id]);
    expect(a.events.touches).toEqual([]);
    expect(a.events.hitsTaken).toEqual([]);
    expect(p.hits).toBe(0);
    expect(a.bugs.some((b) => b.id === bug.id)).toBe(false);
    expect(effectOf(p, "shield")).toBe(0);
    expect(p.invulnTicks).toBe(INVULN_TICKS);
  });

  test("blocks one hit only: a second bug in the same step does not land, and the next contact after the moment does", () => {
    const { a, p } = shielded();
    placeBug(a, 1205, 1200);
    const second = placeBug(a, 1195, 1200);
    stepQuiet(a);
    expect(a.events.blocks).toEqual([p.id]);
    expect(p.hits).toBe(0);
    // The second bug is still there (it could not hit an untouchable player), and lands once the moment is over.
    expect(a.bugs.some((b) => b.id === second.id)).toBe(true);
    let landed = -1;
    for (let i = 1; i <= INVULN_TICKS + 1 && landed < 0; i++) {
      // Keep it on the player.
      for (const b of a.bugs) {
        b.x = 1195;
        b.y = 1200;
      }
      stepQuiet(a);
      if (a.events.touches.length > 0) landed = i;
    }
    expect(landed).toBe(INVULN_TICKS);
    expect(a.events.blocks).toEqual([]);
    expect(p.hits).toBe(1);
  });

  test(`an unused shield lapses after ${shield.durationTicks / 20} s, and then a contact lands`, () => {
    const { a, p } = shielded();
    stepQuiet(a, shield.durationTicks - 1);
    expect(effectOf(p, "shield")).toBe(1);
    stepQuiet(a);
    expect(effectOf(p, "shield")).toBe(0);
    placeBug(a, 1205, 1200);
    stepQuiet(a);
    expect(a.events.blocks).toEqual([]);
    expect(a.events.touches.length).toBe(1);
    expect(p.hits).toBe(1);
  });
});

describe("the first-life shield (#90)", () => {
  /** A player joined to a fresh arena, stepped past spawn protection, with no bugs about. */
  function joined() {
    const a = createArena(7);
    const p = joinPlayer(a, "new", "tabs");
    expect(effectOf(p, "shield")).toBe(FIRST_LIFE_SHIELD_TICKS);
    stepQuiet(a, Math.round(SPAWN_PROTECT_S / DT));
    expect(p.protectTicks).toBe(0);
    return { a, p };
  }

  test("a join spawns with it up, longer than the pickup's, and it blocks the first hit; the next one lands", () => {
    const { a, p } = joined();
    expect(FIRST_LIFE_SHIELD_TICKS).toBeGreaterThan(shield.durationTicks);
    placeBug(a, p.x + 5, p.y);
    stepQuiet(a);
    expect(a.events.blocks).toEqual([p.id]);
    expect(p.hits).toBe(0);
    expect(effectOf(p, "shield")).toBe(0);
    stepQuiet(a, INVULN_TICKS);
    placeBug(a, p.x + 5, p.y);
    stepQuiet(a);
    expect(a.events.blocks).toEqual([]);
    expect(p.hits).toBe(1);
  });

  test("a respawn does not get it", () => {
    const { a, p } = joined();
    p.effect.fill(0);
    downNow(a, p);
    bleedNow(a, p);
    expect(p.alive).toBe(false);
    stepQuiet(a, Math.round(RESPAWN_DELAY_S / DT));
    hold(p, { dash: true });
    stepQuiet(a);
    expect([p.alive, p.firstLife]).toEqual([true, false]);
    expect(effectOf(p, "shield")).toBe(0);
  });
});
