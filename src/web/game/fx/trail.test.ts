import { describe, expect, test } from "bun:test";
import { TRAIL_POINTS, TRAIL_SECONDS, createTrail, trailSlot, updateTrail, type Trail } from "./trail";

/** Points still young enough to draw, as render.ts decides. */
function visible(t: Trail): number {
  let n = 0;
  for (let k = 0; k < t.count; k++) if (t.age[trailSlot(t, k)]! < TRAIL_SECONDS) n++;
  return n;
}

const DT = 1 / 60;

describe("robot trail", () => {
  test("a moving robot leaves points, capped at TRAIL_POINTS, newest first", () => {
    const t = createTrail();
    for (let i = 0; i < 30; i++) updateTrail(t, 100 + i * 4, 50, DT);
    expect(t.count).toBe(TRAIL_POINTS);
    expect(t.x[trailSlot(t, 0)]).toBe(100 + 29 * 4);
    expect(t.x[trailSlot(t, 1)]).toBe(100 + 28 * 4);
    expect(visible(t)).toBe(TRAIL_POINTS);
  });

  test("a robot standing still adds nothing, and its trail ages out", () => {
    const t = createTrail();
    for (let i = 0; i < 5; i++) updateTrail(t, 100 + i * 4, 50, DT);
    expect(t.count).toBe(5);
    for (let i = 0; i < 30; i++) updateTrail(t, 116, 50, DT); // 0.5 s still
    expect(t.count).toBe(5);
    expect(visible(t)).toBe(0);
    expect(30 * DT).toBeGreaterThan(TRAIL_SECONDS);
  });

  test("a tiny move is not a new point", () => {
    const t = createTrail();
    updateTrail(t, 100, 100, DT);
    updateTrail(t, 101, 100, DT);
    expect(t.count).toBe(1);
  });
});
