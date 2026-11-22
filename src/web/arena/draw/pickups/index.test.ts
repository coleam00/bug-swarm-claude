// Every pickup can be drawn (#73): a glow the palette has, and a floor pickup's blink. (That each
// id has an entry, tsc checks: PICKUP_DRAW is a Record over PICKUP_IDS.)
import { describe, expect, test } from "bun:test";
import { DT, PICKUP_BLINK_S, PICKUP_IDS } from "../../../../shared/arena/constants";
import { DRONE_ORBIT, DRONE_SPIN, droneAngle } from "../../../../shared/arena/pickups/drone";
import { arenaWith, placeBug, stepQuiet } from "../../../../shared/arena/testkit";
import { PALETTE } from "../../../game/look";
import { PICKUP_DRAW } from "./index";
import { droneSpot } from "./drone";
import { PICKUP_BLINK_HZ, PICKUP_BLINK_LOW, floorAlpha } from "./kind";

describe("pickup draws", () => {
  test("every pickup's glow is a palette colour, and the glows differ", () => {
    for (const id of PICKUP_IDS) expect(PALETTE[PICKUP_DRAW[id].glow]).toBeDefined();
    expect(new Set(PICKUP_IDS.map((id) => PICKUP_DRAW[id].glow)).size).toBe(PICKUP_IDS.length);
  });

  test("a floor pickup is solid until its last 3 s, then blinks at 5 Hz", () => {
    expect(floorAlpha(12)).toBe(1);
    expect(floorAlpha(PICKUP_BLINK_S + 0.01)).toBe(1);
    // Half a blink is 0.1 s: low, then full, then low.
    const half = 1 / (PICKUP_BLINK_HZ * 2);
    expect(floorAlpha(half * 0.5)).toBe(PICKUP_BLINK_LOW);
    expect(floorAlpha(half * 1.5)).toBe(1);
    expect(floorAlpha(half * 2.5)).toBe(PICKUP_BLINK_LOW);
    // Over its last 3 s it is low about half the time.
    let low = 0;
    for (let i = 0; i < 300; i++) if (floorAlpha((i + 0.5) / 100) < 1) low++;
    expect(low).toBe(150);
  });
});

describe("the CI drone's look (#84)", () => {
  test("it is drawn on its orbit where the simulation fires from: the holder plus DRONE_ORBIT at droneAngle", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.effect[PICKUP_IDS.indexOf("drone")] = 240;
    placeBug(a, 1500, 1200);
    stepQuiet(a);
    const f = a.events.shotsFired[0]!;
    expect(f.drone).toBe(true);
    // A shot reported in the snapshot of tick a.tick is drawn at its origin at drawing time a.tick - 1.
    const out = { x: 0, y: 0 };
    droneSpot(p.x, p.y, p.id, a.tick - 1, out);
    expect(out.x).toBeCloseTo(f.x, 9);
    expect(out.y).toBeCloseTo(f.y, 9);
    expect(Math.hypot(out.x - p.x, out.y - p.y)).toBeCloseTo(DRONE_ORBIT, 9);
    // Between ticks it moves smoothly along the orbit, DRONE_SPIN radians a second.
    const half = { x: 0, y: 0 };
    droneSpot(0, 0, p.id, 10.5, half);
    expect(Math.atan2(half.y, half.x)).toBeCloseTo(Math.atan2(Math.sin(droneAngle(10.5, p.id)), Math.cos(droneAngle(10.5, p.id))), 9);
    expect(droneAngle(11, 1) - droneAngle(10, 1)).toBeCloseTo(DRONE_SPIN * DT, 9);
  });
});
