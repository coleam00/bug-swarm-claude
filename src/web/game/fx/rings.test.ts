import { describe, expect, test } from "bun:test";
import { RING_CAPACITY, RING_S, createRings, ringAt, spawnRing, updateRings, type RingAt } from "./rings";

describe("rings", () => {
  test("a ring grows from 0 to its radius over RING_S, fading as 1 - k², then is over", () => {
    const at: RingAt = { radius: -1, alpha: -1 };
    expect(ringAt(0, 350, at)).toBe(true);
    expect(at).toEqual({ radius: 0, alpha: 1 });
    expect(ringAt(RING_S / 2, 350, at)).toBe(true);
    expect(at.radius).toBeCloseTo(175, 6);
    expect(at.alpha).toBeCloseTo(0.75, 6);
    expect(ringAt(RING_S - 1e-6, 350, at)).toBe(true);
    expect(at.radius).toBeCloseTo(350, 2);
    expect(at.alpha).toBeCloseTo(0, 3);
    expect(ringAt(RING_S, 350, at)).toBe(false);
    expect(ringAt(-0.01, 350, at)).toBe(false);
  });

  test("the pool counts live rings, frees them at RING_S and overwrites the oldest when full", () => {
    const r = createRings();
    expect(r.live).toBe(0);
    spawnRing(r, 10, 20, 350);
    expect([r.live, r.x[0], r.y[0], r.radius[0], r.age[0]]).toEqual([1, 10, 20, 350, 0]);
    updateRings(r, RING_S / 2);
    expect(r.live).toBe(1);
    updateRings(r, RING_S / 2);
    expect(r.live).toBe(0);
    for (let i = 0; i < RING_CAPACITY + 2; i++) spawnRing(r, i, 0, 350);
    expect(r.live).toBe(RING_CAPACITY);
    // The two oldest were overwritten: the pool holds the newest RING_CAPACITY.
    expect([...r.x].sort((a, b) => a - b)).toEqual(Array.from({ length: RING_CAPACITY }, (_, i) => i + 2));
  });
});
