// Pickups by stepping (#73): drops from kills, the floor's cap and expiry, who takes one, and
// effects ending with the life or a down.
import { describe, expect, test } from "bun:test";
import { MAX_PICKUPS_PER_ARENA, PICKUP_RADIUS, PLAYER_RADIUS, WORLD_W } from "../constants";
import { endLife, stepArena } from "../sim";
import { arenaWith, downNow, effectOf, hold, nextDrop, placeBug, placePickup, stepQuiet } from "../testkit";
import { dropFor, stepPickups } from "./index";
import { laser } from "./laser";
import { pickupDef } from "./registry";
import { shield } from "./shield";

/** Kills one crawler at (x, y) with a shot from a player at (x - 100, y) aiming right, its drop draw a miss. */
function killOne(x = 1300, y = 1200) {
  const { a, ps } = arenaWith([x - 100, y]);
  const p = ps[0]!;
  const bug = placeBug(a, x, y);
  nextDrop(a, 0.5, true);
  hold(p, { fire: true });
  for (let i = 0; i < 6 && a.events.kills.length === 0; i++) {
    stepQuiet(a);
    hold(p, {});
  }
  return { a, p, bug };
}

describe("drops", () => {
  test("a draw picks the pickups in PICKUP_IDS order by their chances for the kill's kind, else nothing", () => {
    expect(dropFor("crawler", 0)).toBe("shield");
    expect(dropFor("crawler", shield.drop.crawler - 1e-9)).toBe("shield");
    expect(dropFor("crawler", shield.drop.crawler)).toBe("laser");
    expect(dropFor("crawler", shield.drop.crawler + laser.drop.crawler - 1e-9)).toBe("laser");
    expect(dropFor("crawler", shield.drop.crawler + laser.drop.crawler)).toBeNull();
    expect(dropFor("dasher", shield.drop.dasher + laser.drop.dasher / 2)).toBe("laser");
    expect(dropFor("dasher", shield.drop.dasher + laser.drop.dasher)).toBeNull();
  });

  test("a kill whose draw lands drops a pickup at the kill, lying for its floor time", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    placeBug(a, 1300, 1200);
    nextDrop(a, shield.drop.crawler);
    hold(p, { fire: true });
    stepQuiet(a);
    hold(p, {});
    for (let i = 0; i < 6 && a.events.kills.length === 0; i++) stepQuiet(a);
    const kill = a.events.kills[0]!;
    expect(a.floor).toEqual([{ id: 1, kind: "shield", x: kill.x, y: kill.y, ticksLeft: shield.floorTicks }]);
  });

  test("a kill whose draw misses drops nothing, and every kill draws exactly one number", () => {
    const { a, bug } = killOne();
    expect(a.events.kills.map((k) => k.bug)).toEqual([bug.id]);
    expect(a.floor).toEqual([]);
    // Two kills in one step, one by nobody (a shot from a life that is over): two draws.
    const { a: b } = arenaWith([200, 200]);
    nextDrop(b, 0.5, true);
    const before = b.dropRng.state;
    b.events.kills.push({ bug: 1, by: 1, x: 1000, y: 1000, points: 10, kind: "crawler" });
    b.events.kills.push({ bug: 2, by: 0, x: 1100, y: 1000, points: 0, kind: "dasher" });
    stepPickups(b);
    const twice = { state: before };
    // mulberry32 adds 0x6d2b79f5 per draw.
    twice.state = (twice.state + 0x6d2b79f5) | 0;
    twice.state = (twice.state + 0x6d2b79f5) | 0;
    expect(b.dropRng.state).toBe(twice.state);
  });

  test("drops never draw from the arena's generator, so spawns and spread replay as with no pickups", () => {
    const { a } = arenaWith([200, 200]);
    nextDrop(a, 0.001);
    const rng = a.rng.state;
    a.events.kills.push({ bug: 1, by: 1, x: 1000, y: 1000, points: 10, kind: "crawler" });
    stepPickups(a);
    expect(a.floor.length).toBe(1);
    expect(a.rng.state).toBe(rng);
  });

  test("a drop at a wall lands inside it", () => {
    const { a } = arenaWith([1200, 1200]);
    nextDrop(a, 0.001);
    a.events.kills.push({ bug: 1, by: 1, x: WORLD_W + 5, y: 3, points: 10, kind: "crawler" });
    stepPickups(a);
    expect([a.floor[0]!.x, a.floor[0]!.y]).toEqual([WORLD_W - PICKUP_RADIUS, PICKUP_RADIUS]);
  });

  test(`at most ${MAX_PICKUPS_PER_ARENA} lie on the floor: a drop past the cap is lost, not queued`, () => {
    const { a } = arenaWith([200, 200]);
    for (let i = 0; i < MAX_PICKUPS_PER_ARENA; i++) placePickup(a, 1000 + i * 50, 1000, "laser");
    nextDrop(a, 0.001);
    const before = a.dropRng.state;
    a.events.kills.push({ bug: 1, by: 1, x: 1500, y: 1500, points: 10, kind: "crawler" });
    stepPickups(a);
    expect(a.floor.length).toBe(MAX_PICKUPS_PER_ARENA);
    expect(a.floor.every((f) => f.kind === "laser")).toBe(true);
    expect(a.dropRng.state).not.toBe(before);
    // Nothing queued: once one goes, the next quiet steps drop nothing.
    a.floor.pop();
    stepQuiet(a, 3);
    expect(a.floor.length).toBe(MAX_PICKUPS_PER_ARENA - 1);
  });
});

describe("the floor", () => {
  test("a pickup lies for exactly its floor time (12 s), then goes", () => {
    const { a } = arenaWith([200, 200]);
    placePickup(a, 1500, 1500, "shield");
    expect(shield.floorTicks).toBe(240);
    stepQuiet(a, shield.floorTicks - 1);
    expect(a.floor.length).toBe(1);
    expect(a.floor[0]!.ticksLeft).toBe(1);
    stepQuiet(a);
    expect(a.floor).toEqual([]);
  });

  test("a player who is up touching it takes it: the effect runs its full duration, and the event says who took what", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    placePickup(a, 1200 + PLAYER_RADIUS + PICKUP_RADIUS + 1, 1200, "laser");
    stepQuiet(a);
    expect(a.floor.length).toBe(1);
    expect(effectOf(p, "laser")).toBe(0);
    placePickup(a, 1200 + PLAYER_RADIUS + PICKUP_RADIUS - 1, 1200, "laser");
    stepQuiet(a);
    expect(a.events.pickups).toEqual([{ player: p.id, kind: "laser" }]);
    expect(a.floor.map((f) => f.id)).toEqual([1]);
    expect(effectOf(p, "laser")).toBe(laser.durationTicks);
    stepQuiet(a);
    expect(effectOf(p, "laser")).toBe(laser.durationTicks - 1);
    // Taking another refreshes it.
    placePickup(a, 1200, 1200, "laser");
    stepQuiet(a);
    expect(effectOf(p, "laser")).toBe(laser.durationTicks);
  });

  test("two players on one pickup: the first in the list takes it", () => {
    const { a, ps } = arenaWith([1200, 1200], [1210, 1200]);
    placePickup(a, 1205, 1200, "shield");
    stepQuiet(a);
    expect(a.events.pickups).toEqual([{ player: ps[0]!.id, kind: "shield" }]);
    expect(effectOf(ps[1]!, "shield")).toBe(0);
  });

  test("a downed player cannot take one, and going down clears every effect", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    placePickup(a, 1200, 1200, "laser");
    stepQuiet(a);
    expect(effectOf(p, "laser")).toBeGreaterThan(0);
    downNow(a, p);
    expect(p.down).toBe(true);
    expect(effectOf(p, "laser")).toBe(0);
    placePickup(a, p.x, p.y, "laser");
    stepQuiet(a);
    expect(a.floor.length).toBe(1);
    expect(effectOf(p, "laser")).toBe(0);
  });

  test("a life ending clears its effects, and a player out takes nothing", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    placePickup(a, 1200, 1200, "shield");
    stepQuiet(a);
    expect(effectOf(p, "shield")).toBe(pickupDef("shield").durationTicks);
    endLife(a, p);
    expect(effectOf(p, "shield")).toBe(0);
    placePickup(a, 1200, 1200, "shield");
    stepArena(a);
    expect(a.floor.length).toBe(1);
  });
});
