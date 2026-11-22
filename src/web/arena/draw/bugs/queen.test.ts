// The hive queen's look (#85): her tell's glow and swell over its 1 s, and her reach for culling.
import { describe, expect, test } from "bun:test";
import { DRIFT, QUEEN_RADIUS, TELL, TELL_TICKS } from "../../../../shared/arena/bugs/queen";
import { DT } from "../../../../shared/arena/constants";
import { QUEEN_REACH, queenLook } from "./queen";

const look = () => ({ glow: 0, swell: 0 });

describe("queen look", () => {
  test("drifting: no glow, her abdomen breathing within 4%", () => {
    for (let t = 0; t < 3; t += 0.1) {
      const l = queenLook(DRIFT, t, t, look());
      expect(l.glow).toBe(0);
      expect(l.swell).toBeGreaterThanOrEqual(1);
      expect(l.swell).toBeLessThanOrEqual(1.04);
    }
  });

  test("telling: the glow grows from 0.3 to full and the abdomen swells over the 1 s, pulsing only in its last 0.2 s", () => {
    const tell = TELL_TICKS * DT;
    expect(tell).toBeCloseTo(1, 9);
    expect(queenLook(TELL, 0, 0, look()).glow).toBeCloseTo(0.3, 9);
    expect(queenLook(TELL, 0.4, 0, look()).glow).toBeCloseTo(0.58, 9);
    expect(queenLook(TELL, 0.4, 0, look()).swell).toBeCloseTo(1.06, 9);
    let prev = -1;
    for (let s = 0; s <= 0.8; s += 0.05) {
      const g = queenLook(TELL, s, 0, look()).glow;
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
    for (let s = 0.81; s <= 1; s += 0.01) {
      const g = queenLook(TELL, s, 0, look()).glow;
      expect(g).toBeGreaterThanOrEqual(0.5 * (0.3 + 0.7 * (s / tell)) - 1e-9);
      expect(g).toBeLessThanOrEqual(1);
    }
    expect(queenLook(TELL, 1, 0, look()).swell).toBeCloseTo(1.15, 9);
  });

  test("everything of her lies within QUEEN_REACH of her centre, which is more than her collision radius", () => {
    expect(QUEEN_REACH).toBeGreaterThan(QUEEN_RADIUS * 2);
    expect(QUEEN_REACH).toBeLessThan(300);
  });
});
