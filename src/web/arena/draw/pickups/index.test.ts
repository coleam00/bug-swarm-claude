// Every pickup can be drawn (#73): a glow the palette has, and a floor pickup's blink. (That each
// id has an entry, tsc checks: PICKUP_DRAW is a Record over PICKUP_IDS.)
import { describe, expect, test } from "bun:test";
import { PICKUP_BLINK_S, PICKUP_IDS } from "../../../../shared/arena/constants";
import { PALETTE } from "../../../game/look";
import { PICKUP_DRAW } from "./index";
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
