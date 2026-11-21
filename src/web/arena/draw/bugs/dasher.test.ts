// How a dasher's phases read on screen (#65): the pure part of its drawing.
import { describe, expect, test } from "bun:test";
import { APPROACH, DASHER_RADIUS, LUNGE, LUNGE_DIST, RECOVER, TELL, TELL_S } from "../../../../shared/arena/bugs/dasher";
import { WORLD_W } from "../../../../shared/arena/constants";
import { dasherLook, lungeReach, type DasherLook } from "./dasher";

const out: DasherLook = { along: 0, across: 0, alpha: 0, glow: 0, line: 0, streak: 0 };
const at = (phase: number, s: number) => ({ ...dasherLook(phase, s, out) });

describe("dasher look", () => {
  test("approaching: lean, no glow, no line", () => {
    const l = at(APPROACH, 3);
    expect(l.across).toBeLessThan(1);
    expect([l.along, l.alpha, l.glow, l.line, l.streak]).toEqual([1, 1, 0, 0, 0]);
  });

  test("the tell crouches, glows and draws its line, all growing over the tell", () => {
    const start = at(TELL, 0);
    const mid = at(TELL, TELL_S / 2);
    const end = at(TELL, TELL_S - 0.001);
    expect(start.glow).toBeCloseTo(0.4, 9);
    expect(start.line).toBeCloseTo(0.35, 9);
    expect(start.along).toBe(1);
    expect(mid.glow).toBeGreaterThan(start.glow);
    expect(mid.line).toBeGreaterThan(start.line);
    expect(end.line).toBeCloseTo(1, 2);
    // Crouched: about 15% shorter along its line and 10% wider across it.
    expect(end.along).toBeCloseTo(0.85, 2);
    expect(end.across / start.across).toBeCloseTo(1.1, 2);
    // Pulsing in the last quarter second: the glow dips and comes back.
    const pulse = [0.46, 0.5, 0.54, 0.58, 0.62, 0.66].map((s) => at(TELL, s).glow);
    expect(Math.min(...pulse)).toBeLessThan(0.8);
    expect(Math.max(...pulse)).toBeGreaterThan(0.9);
  });

  test("the lunge stretches along its line with a streak; the recover is faint", () => {
    const l = at(LUNGE, 0.2);
    expect(l.along).toBeCloseTo(1.3, 9);
    expect([l.streak, l.line]).toEqual([1, 0]);
    expect(at(RECOVER, 0.5).alpha).toBeCloseTo(0.6, 9);
  });

  test("the aim line ends where the lunge will: LUNGE_DIST on open floor, earlier at a wall", () => {
    expect(lungeReach(1200, 1200, 1, 0)).toBe(LUNGE_DIST);
    expect(lungeReach(WORLD_W - 200, 1200, 1, 0)).toBeCloseTo(200 - DASHER_RADIUS, 9);
    expect(lungeReach(100, 100, -Math.SQRT1_2, -Math.SQRT1_2)).toBeCloseTo((100 - DASHER_RADIUS) / Math.SQRT1_2, 9);
  });
});
