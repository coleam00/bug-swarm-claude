// The invisibility cloak by stepping (#132): taken, no bug chases or aims at you while it lasts
// (crawlers, a dasher's lock, a spitter's aim), contact still costs a hit, and it lapses.
import { describe, expect, test } from "bun:test";
import { DT } from "../constants";
import { APPROACH, TELL as DASHER_TELL } from "../bugs/dasher";
import { KEEP, RELOAD_TICKS, TELL as SPITTER_TELL, TELL_TICKS as SPITTER_TELL_TICKS } from "../bugs/spitter";
import type { ArenaState, Player } from "../sim";
import { arenaWith, effectOf, placeBug, placePickup, stepQuiet } from "../testkit";
import { CLOAK, cloak } from "./cloak";

/** The issue's numbers, written out so a test fails if a constant drifts from them. */
const ITEM_CLOAK_TICKS = 200; // 10 s

const cloakOn = (p: Player) => (p.effect[CLOAK] = cloak.durationTicks);

/** Makes `p`'s life `seconds` old in pressure age (not a first life, so nothing is held back). */
function aged(a: ArenaState, p: Player, seconds: number): void {
  p.firstLife = false;
  p.lifeStartTick = a.tick - Math.round(seconds / DT);
}

describe("the invisibility cloak", () => {
  test("taken from the floor it lasts 10 s, then lapses", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    placePickup(a, 1200, 1200, "cloak");
    stepQuiet(a);
    expect(cloak.durationTicks).toBe(ITEM_CLOAK_TICKS);
    expect(effectOf(p, "cloak")).toBe(ITEM_CLOAK_TICKS);
    stepQuiet(a, ITEM_CLOAK_TICKS - 1);
    expect(effectOf(p, "cloak")).toBe(1);
    stepQuiet(a);
    expect(effectOf(p, "cloak")).toBe(0);
  });

  test("a crawler between a cloaked player and an uncloaked one goes for the uncloaked one, though farther", () => {
    const { a, ps } = arenaWith([1200, 1200], [1200, 1600]);
    const [hid, seen] = [ps[0]!, ps[1]!];
    cloakOn(hid);
    const b = placeBug(a, 1200, 1300);
    stepQuiet(a);
    expect(b.target).toBe(seen.id);
    expect(b.y).toBeGreaterThan(1300);
  });

  test("with only cloaked players up, a crawler has no target and does not close in; once the cloak lapses it chases again", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    cloakOn(p);
    const b = placeBug(a, 1400, 1200);
    stepQuiet(a, 20);
    expect(b.target).toBe(0);
    expect([b.x, b.y]).toEqual([1400, 1200]);
    p.effect[CLOAK] = 1;
    stepQuiet(a); // the bugs step before the effect counts down: still cloaked in this one
    stepQuiet(a);
    expect(b.target).toBe(p.id);
    expect(b.x).toBeLessThan(1400);
  });

  test("a dasher in range does not lock on a cloaked player (and does on the same player uncloaked)", () => {
    for (const hidden of [true, false]) {
      const { a, ps } = arenaWith([1200, 1200]);
      const p = ps[0]!;
      if (hidden) cloakOn(p);
      const d = placeBug(a, 1500, 1200, "dasher");
      stepQuiet(a);
      expect(d.phase).toBe(hidden ? APPROACH : DASHER_TELL);
      expect(d.target).toBe(hidden ? 0 : p.id);
    }
  });

  test("a spitter in range does not tell at a cloaked player (and does at the same player uncloaked)", () => {
    for (const hidden of [true, false]) {
      const { a, ps } = arenaWith([1200, 1200]);
      const p = ps[0]!;
      aged(a, p, 120);
      if (hidden) cloakOn(p);
      const s = placeBug(a, 1500, 1200, "spitter");
      s.phaseTicks = RELOAD_TICKS;
      stepQuiet(a);
      expect(s.phase).toBe(hidden ? KEEP : SPITTER_TELL);
    }
  });

  test("a spitter at the end of its tell does not spit at a player who cloaked during it", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    aged(a, p, 120);
    const s = placeBug(a, 1500, 1200, "spitter");
    s.phase = SPITTER_TELL;
    s.phaseTicks = SPITTER_TELL_TICKS - 1;
    cloakOn(p);
    stepQuiet(a);
    expect(s.phase).toBe(KEEP);
    expect(a.bugs.filter((b) => b.kind === "glob")).toEqual([]);
  });

  test("contact still costs a hit: a crawler that walks into a cloaked player strikes them", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    cloakOn(p);
    placeBug(a, 1205, 1200);
    stepQuiet(a);
    expect(a.events.touches).toEqual([{ player: p.id, kind: "crawler" }]);
    expect(p.hits).toBe(1);
    expect(a.bugs).toEqual([]);
  });
});
