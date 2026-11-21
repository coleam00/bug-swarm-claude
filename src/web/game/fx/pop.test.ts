import { describe, expect, test } from "bun:test";
import { POP_CAPACITY, POP_SECONDS, createPops, spawnPop, updatePops } from "./pop";

describe("shield pops", () => {
  test("a pop runs for POP_SECONDS, then frees its slot", () => {
    const p = createPops();
    expect(p.live).toBe(0);
    spawnPop(p, 100, 200);
    expect(p.live).toBe(1);
    expect(p.x[0]).toBe(100);
    expect(p.y[0]).toBe(200);
    updatePops(p, POP_SECONDS / 2);
    expect(p.life[0]).toBeCloseTo(POP_SECONDS / 2, 5);
    expect(p.live).toBe(1);
    updatePops(p, POP_SECONDS);
    expect(p.live).toBe(0);
    expect(p.life[0]).toBe(0);
  });

  test("a full pool overwrites the oldest pop and never grows", () => {
    const p = createPops();
    for (let i = 0; i < POP_CAPACITY + 1; i++) spawnPop(p, i, 0);
    expect(p.live).toBe(POP_CAPACITY);
    expect(p.life.length).toBe(POP_CAPACITY);
    expect(p.x[0]).toBe(POP_CAPACITY);
    expect(p.x[1]).toBe(1);
  });
});
