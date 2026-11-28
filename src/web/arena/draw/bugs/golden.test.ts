// The golden bug's look (#122): its glow's pulse and its trail of twinkling sparkles.
import { describe, expect, test } from "bun:test";
import { GOLDEN_RADIUS } from "../../../../shared/arena/bugs/golden";
import { PULSE_HZ, SPARKLES, SPARKLE_HZ, goldenPulse, sparkleAt, type Sparkle } from "./golden";

const sp = (): Sparkle => ({ back: 0, side: 0, half: 0, alpha: 0 });

describe("golden look", () => {
  test("the glow pulses between 0.55 and 1 at 2 Hz", () => {
    let lo = 1;
    let hi = 0;
    for (let t = 0; t < 2; t += 0.01) {
      const g = goldenPulse(t);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
      expect(goldenPulse(t + 1 / PULSE_HZ)).toBeCloseTo(g, 9);
    }
    expect(lo).toBeCloseTo(0.55, 2);
    expect(hi).toBeCloseTo(1, 2);
  });

  test("its sparkles trail behind it, each further back, never on its body, twinkling and never invisible", () => {
    for (let t = 0; t < 3; t += 0.05) {
      let back = 0;
      for (let k = 0; k < SPARKLES; k++) {
        const s = sparkleAt(k, t, sp());
        expect(s.back).toBeGreaterThan(back);
        expect(s.back).toBeGreaterThan(GOLDEN_RADIUS);
        back = s.back;
        expect(Math.abs(s.side)).toBeLessThanOrEqual(GOLDEN_RADIUS * 0.6 + 1e-9);
        expect(s.half).toBeGreaterThan(0);
        expect(s.half).toBeLessThanOrEqual(GOLDEN_RADIUS);
        expect(s.alpha).toBeGreaterThan(0);
        expect(s.alpha).toBeLessThanOrEqual(1);
      }
    }
  });

  test("each sparkle twinkles at SPARKLE_HZ, a third of a cycle from the next", () => {
    const a = sparkleAt(0, 0.1, sp());
    const b = sparkleAt(0, 0.1 + 1 / SPARKLE_HZ, sp());
    expect(b.half).toBeCloseTo(a.half, 9);
    expect(b.alpha).toBeCloseTo(a.alpha, 9);
    // Sparkle 1 is where sparkle 0 was a third of a cycle later, before its own size and fade.
    const s0 = sparkleAt(0, 0.1 + 1 / (3 * SPARKLE_HZ), sp());
    const s1 = sparkleAt(1, 0.1, sp());
    expect(s1.half / 0.8).toBeCloseTo(s0.half, 9);
  });
});
