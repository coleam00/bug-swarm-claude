// How a spitter's tell reads on screen (#72): the pure part of its drawing.
import { describe, expect, test } from "bun:test";
import { KEEP, SPIT, TELL, TELL_S } from "../../../../shared/arena/bugs/spitter";
import { EDGE_INSET, EDGE_RANGE, edgeMark, spitterLook, type EdgeMark, type SpitterLook } from "./spitter";

const out: SpitterLook = { scale: 0, glow: 0 };
const at = (phase: number, s: number) => ({ ...spitterLook(phase, s, out) });

describe("spitter look", () => {
  test("keeping its distance: its own size, no glow", () => {
    expect(at(KEEP, 2)).toEqual({ scale: 1, glow: 0 });
  });

  test("the tell swells it past 1.5x and lights its glow, growing all the way", () => {
    const start = at(TELL, 0);
    const mid = at(TELL, TELL_S / 2);
    const end = at(TELL, TELL_S - 0.001);
    expect(start.scale).toBe(1);
    expect(start.glow).toBeCloseTo(0.3, 9);
    expect(mid.scale).toBeGreaterThan(start.scale);
    expect(mid.glow).toBeGreaterThan(start.glow);
    expect(end.scale).toBeGreaterThanOrEqual(1.5);
    // Pulsing in the last 0.2 s: the glow dips and comes back.
    const pulse = [0.62, 0.66, 0.7, 0.74, 0.78].map((s) => at(TELL, s).glow);
    expect(Math.min(...pulse)).toBeLessThan(0.8);
    expect(Math.max(...pulse)).toBeGreaterThan(0.9);
  });

  test("the spit snaps it small and it grows back", () => {
    expect(at(SPIT, 0).scale).toBeCloseTo(0.85, 9);
    expect(at(SPIT, 0.3).scale).toBeCloseTo(1, 9);
  });
});

describe("spitter edge mark", () => {
  const m: EdgeMark = { x: 0, y: 0, angle: 0 };
  // A portrait phone's screen, world units: about 370 across and 800 down.
  const [L, T, R, B] = [1015, 800, 1385, 1600];

  test("none for a spitter on screen, or more than EDGE_RANGE off it", () => {
    expect(edgeMark(L, T, R, B, 1200, 1200, EDGE_INSET, m)).toBe(false);
    expect(edgeMark(L, T, R, B, R + EDGE_RANGE + 1, 1200, EDGE_INSET, m)).toBe(false);
  });

  test("one just off the side of a portrait screen is marked at that edge, pointing at it", () => {
    expect(edgeMark(L, T, R, B, 1200 + 300, 1200, EDGE_INSET, m)).toBe(true);
    expect(m.x).toBeCloseTo(R - EDGE_INSET, 9);
    expect(m.y).toBeCloseTo(1200, 9);
    expect(m.angle).toBeCloseTo(0, 9);
    // Up and to the left: on the screen, inset, along the line from the centre toward it.
    expect(edgeMark(L, T, R, B, L - 300, T - 300, EDGE_INSET, m)).toBe(true);
    expect(m.x).toBeGreaterThanOrEqual(L + EDGE_INSET);
    expect(m.y).toBeGreaterThanOrEqual(T + EDGE_INSET);
    expect(Math.min(m.x - L, m.y - T)).toBeCloseTo(EDGE_INSET, 9);
    expect(m.angle).toBeCloseTo(Math.atan2(T - 300 - 1200, L - 300 - 1200), 9);
  });
});
