import { describe, expect, test } from "bun:test";
import { TING_CAPACITY, TING_RING_FROM, TING_RING_S, TING_RING_TO, TING_S, createTings, spawnTing, tingLook, updateTings, type TingLook } from "./tings";

const look = (): TingLook => ({ ring: 0, ringAlpha: 0, wordAlpha: 0, rise: 0 });

describe("tings (#80)", () => {
  test("the ring grows and fades out over TING_RING_S; the word lasts TING_S", () => {
    const at0 = tingLook(0, look());
    expect([at0.ring, at0.ringAlpha, at0.wordAlpha, at0.rise]).toEqual([TING_RING_FROM, 1, 1, 0]);
    const mid = tingLook(TING_RING_S / 2, look());
    expect(mid.ring).toBeGreaterThan(TING_RING_FROM);
    expect(mid.ring).toBeLessThan(TING_RING_TO);
    expect(mid.ringAlpha).toBeCloseTo(0.5, 6);
    const ringDone = tingLook(TING_RING_S, look());
    expect(ringDone.ring).toBeCloseTo(TING_RING_TO, 6);
    expect(ringDone.ringAlpha).toBe(0);
    expect(ringDone.wordAlpha).toBe(1);
    expect(tingLook(TING_S, look()).wordAlpha).toBe(0);
  });

  test("a ting lives TING_S, then its slot is free", () => {
    const t = createTings();
    spawnTing(t, 100, 100);
    expect(t.live).toBe(1);
    updateTings(t, TING_S - 0.01);
    expect(t.live).toBe(1);
    updateTings(t, 0.02);
    expect(t.live).toBe(0);
  });

  test("a block beside a young ting restarts it rather than adding one; one further off adds its own", () => {
    const t = createTings();
    spawnTing(t, 100, 100);
    updateTings(t, 0.05);
    spawnTing(t, 110, 100);
    expect(t.live).toBe(1);
    expect(t.age[0]).toBe(0);
    spawnTing(t, 300, 100);
    expect(t.live).toBe(2);
  });

  test("a full pool reuses its oldest slot", () => {
    const t = createTings();
    for (let i = 0; i < TING_CAPACITY + 3; i++) spawnTing(t, i * 100, 0);
    expect(t.live).toBe(TING_CAPACITY);
    expect(t.x[0]).toBe(TING_CAPACITY * 100);
  });
});
