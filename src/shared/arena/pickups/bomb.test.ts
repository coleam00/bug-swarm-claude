// The refactor bomb by stepping (#78): taken, it goes off at once around the taker, clearing
// crawlers and dashers within BOMB_RADIUS (and hitting other kinds for BOMB_DAMAGE), its kills
// scoring for the taker at their multiplier without touching the streak.
import { describe, expect, test } from "bun:test";
import { bugDef } from "../bugs/registry";
import { mult } from "../combat";
import { nextRandom } from "../rng";
import { arenaWith, effectOf, nextDrop, placeBug, placePickup, stepQuiet } from "../testkit";
import { BOMB_CLEARS, BOMB_DAMAGE, BOMB_RADIUS, bomb } from "./bomb";
import { stepPickups } from "./index";
import { shield } from "./shield";

describe("the refactor bomb", () => {
  test("is taken like any pickup and lasts nothing: no effect, so no effects bit and no HUD timer", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    placePickup(a, 1200, 1200, "bomb");
    stepQuiet(a);
    expect(a.floor).toEqual([]);
    expect(a.events.pickups).toEqual([{ player: p.id, kind: "bomb" }]);
    expect(bomb.durationTicks).toBe(0);
    expect(effectOf(p, "bomb")).toBe(0);
  });

  test("taken, it kills the crawlers and dashers near the taker in that step; those farther off live", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    // Bugs walk toward the player before pickups are stepped, so the near ones are well inside
    // the radius and the far one well outside it (the exact edge is the next test's).
    const near = placeBug(a, 1200 + BOMB_RADIUS - 60, 1200);
    const dash = placeBug(a, 1200, 1200 - (BOMB_RADIUS - 60), "dasher");
    const far = placeBug(a, 1200 + BOMB_RADIUS + 60, 1200);
    expect(dash.hp).toBe(bugDef("dasher").hp);
    placePickup(a, 1200, 1200, "bomb");
    nextDrop(a, 0.5, true);
    stepQuiet(a);
    expect(a.events.kills.map((k) => k.bug)).toEqual([near.id, dash.id]);
    // The dead leave in the same step (no step of theirs can hit anyone), the far one is untouched.
    expect(a.bugs.map((b) => b.id)).toEqual([far.id]);
    expect(far.hp).toBe(bugDef("crawler").hp);
    expect(a.events.bombKills).toEqual([p.id, p.id]);
  });

  test("its edge is the item's 350 units, centre to centre", () => {
    expect(BOMB_RADIUS).toBe(350);
    const { a, ps } = arenaWith([1200, 1200]);
    const inside = placeBug(a, 1200 + 349, 1200);
    const edge = placeBug(a, 1200, 1200 + 350);
    const outside = placeBug(a, 1200 - 351, 1200);
    // Pickups stepped alone (no bug steps first), so the bugs are where they were placed.
    placePickup(a, 1200, 1200, "bomb");
    nextDrop(a, 0.5, true);
    stepPickups(a);
    expect(a.events.pickups).toEqual([{ player: ps[0]!.id, kind: "bomb" }]);
    expect([inside.hp, edge.hp, outside.hp]).toEqual([0, 0, 1]);
    expect(a.events.kills.map((k) => k.bug)).toEqual([inside.id, edge.id]);
  });

  test("the kinds it does not clear lose the item's 4 hit points, and die and score at 0: a spitter and a glob today", () => {
    expect(BOMB_DAMAGE).toBe(4);
    expect(BOMB_CLEARS).toEqual({ crawler: true, dasher: true, spitter: false, glob: false, beetle: false, queen: false });
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    // A spitter with more hit points than any has (none has more than 3 today) keeps the rest.
    const tough = placeBug(a, 1300, 1200, "spitter");
    tough.hp = BOMB_DAMAGE + 2;
    const spitter = placeBug(a, 1100, 1200, "spitter");
    const glob = placeBug(a, 1200, 1100, "glob");
    expect([spitter.hp, glob.hp]).toEqual([bugDef("spitter").hp, bugDef("glob").hp]);
    placePickup(a, 1200, 1200, "bomb");
    nextDrop(a, 0.5, true);
    stepPickups(a);
    expect(tough.hp).toBe(2);
    expect(a.bugs).toEqual([tough]);
    expect(a.events.kills.map((k) => k.bug)).toEqual([spitter.id, glob.id]);
    expect(p.score).toBe(bugDef("spitter").points + bugDef("glob").points);
  });

  test("its kills score for the taker at the current multiplier; the streak neither grows nor resets", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.streak = 10;
    p.score = 100;
    p.kills = 3;
    placeBug(a, 1300, 1200);
    placeBug(a, 1200, 1300);
    placeBug(a, 1100, 1100, "dasher");
    placePickup(a, 1200, 1200, "bomb");
    nextDrop(a, 0.5, true);
    stepQuiet(a);
    const want = (2 * bugDef("crawler").points + bugDef("dasher").points) * mult(10);
    expect(mult(10)).toBe(2);
    expect(p.score).toBe(100 + want);
    expect(p.kills).toBe(6);
    expect(p.streak).toBe(10);
    expect(a.events.kills.every((k) => k.by === p.id)).toBe(true);
    expect(a.events.kills.reduce((s, k) => s + k.points, 0)).toBe(want);
  });

  test("each of its kills draws one drop, landing on the floor this step", () => {
    const { a } = arenaWith([1200, 1200]);
    placeBug(a, 1300, 1200);
    placeBug(a, 1100, 1200);
    placePickup(a, 1200, 1200, "bomb");
    // The first draw drops a shield, the next misses (any number at least 0.5 does).
    nextDrop(a, shield.drop.crawler);
    const rng = { state: a.dropRng.state };
    nextRandom(rng);
    nextRandom(rng);
    stepQuiet(a);
    expect(a.events.kills.length).toBe(2);
    expect(a.dropRng.state).toBe(rng.state);
    const k = a.events.kills[0]!;
    expect(a.floor.map((f) => [f.kind, f.x, f.y])).toEqual([["shield", k.x, k.y]]);
  });

  test("two bombs taken in one step never kill a bug twice", () => {
    const { a, ps } = arenaWith([1100, 1200], [1400, 1200]);
    const [p, q] = ps as [(typeof ps)[0], (typeof ps)[0]];
    const shared = placeBug(a, 1250, 1300);
    const qOnly = placeBug(a, 1600, 1250);
    placePickup(a, 1100, 1200, "bomb");
    placePickup(a, 1400, 1200, "bomb");
    nextDrop(a, 0.5, true);
    stepQuiet(a);
    expect(a.events.pickups.map((x) => x.player)).toEqual([p.id, q.id]);
    expect(a.events.kills.map((k) => [k.bug, k.by])).toEqual([
      [shared.id, p.id],
      [qOnly.id, q.id],
    ]);
    expect([p.kills, q.kills]).toEqual([1, 1]);
    expect(a.bugs).toEqual([]);
  });
});
