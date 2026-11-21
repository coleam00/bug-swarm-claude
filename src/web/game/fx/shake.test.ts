import { describe, expect, test } from "bun:test";
import { createRng } from "../rng";
import { HIT_SHAKE, SHAKE_SECONDS, createShake, kick, shakeStrength, updateShake } from "./shake";

const DT = 1 / 60;

describe("screen shake", () => {
  test("a kick shakes within its strength, then settles to exactly zero", () => {
    const s = createShake();
    const rng = createRng(1);
    kick(s, HIT_SHAKE);
    updateShake(s, DT, rng);
    expect(s.offsetX !== 0 || s.offsetY !== 0).toBe(true);
    expect(Math.abs(s.offsetX)).toBeLessThanOrEqual(HIT_SHAKE);
    expect(Math.abs(s.offsetY)).toBeLessThanOrEqual(HIT_SHAKE);
    for (let t = DT; t < SHAKE_SECONDS + DT; t += DT) updateShake(s, DT, rng);
    expect(s.offsetX).toBe(0);
    expect(s.offsetY).toBe(0);
    expect(shakeStrength(s)).toBe(0);
  });

  test("a smaller kick does not weaken a running shake, a bigger one does take over", () => {
    const s = createShake();
    kick(s, HIT_SHAKE);
    kick(s, 2);
    expect(shakeStrength(s)).toBe(HIT_SHAKE);
    kick(s, 12);
    expect(shakeStrength(s)).toBe(12);
  });
});
