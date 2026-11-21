import { describe, expect, test } from "bun:test";
import { HEAT_WARN } from "../../shared/arena/constants";
import type { SnapshotMe } from "../../shared/arena/protocol";
import { HIT_FLASH_S, PULSE_S, STREAK_LOST_S, createHudFx, flashOn, heatWarning, noteMe, pulseScale, resetHudFx, updateHudFx } from "./hudfx";

const me = (o: Partial<SnapshotMe> = {}): SnapshotMe => ({ sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 3, al: 1, ...o });

describe("HUD moments", () => {
  test("the multiplier pulses when it rises, and only then", () => {
    const fx = createHudFx();
    noteMe(fx, me({ st: 4 }));
    expect(fx.pulse).toBe(0);
    noteMe(fx, me({ st: 5, mu: 1.5 }));
    expect(fx.pulse).toBe(PULSE_S);
    updateHudFx(fx, PULSE_S / 2);
    expect(pulseScale(fx)).toBeCloseTo(1.35, 6);
    noteMe(fx, me({ st: 6, mu: 1.5 }));
    updateHudFx(fx, PULSE_S);
    expect(fx.pulse).toBe(0);
    expect(pulseScale(fx)).toBe(1);
  });

  test("a streak of 5 or more that resets flicks 'streak lost'; a shorter one does not", () => {
    const fx = createHudFx();
    noteMe(fx, me({ st: 4 }));
    noteMe(fx, me({ st: 0 }));
    expect(fx.lost).toBe(0);
    noteMe(fx, me({ st: 7, mu: 1.5 }));
    noteMe(fx, me({ st: 0, mu: 1 }));
    expect(fx.lost).toBe(STREAK_LOST_S);
    updateHudFx(fx, STREAK_LOST_S);
    expect(fx.lost).toBe(0);
  });

  test("losing a hit flashes and says so; the start of a new life does not", () => {
    const fx = createHudFx();
    expect(noteMe(fx, me({ hl: 3 }))).toBe(false);
    expect(noteMe(fx, me({ hl: 2 }))).toBe(true);
    expect(fx.hit).toBe(HIT_FLASH_S);
    expect(noteMe(fx, me({ hl: 0, al: 0 }))).toBe(true);
    expect(noteMe(fx, me({ hl: 3, al: 1, st: 0 }))).toBe(false);
    resetHudFx(fx);
    expect(fx.hit).toBe(0);
    // Dying with a streak is not "streak lost".
    noteMe(fx, me({ st: 9, mu: 1.5 }));
    noteMe(fx, me({ st: 0, hl: 0, al: 0 }));
    expect(fx.lost).toBe(0);
  });

  test("the heat arc warns from HEAT_WARN and while locked, flashing", () => {
    expect(heatWarning(HEAT_WARN - 0.01, false)).toBe(false);
    expect(heatWarning(HEAT_WARN, false)).toBe(true);
    expect(heatWarning(0.2, true)).toBe(true);
    const seen = new Set<boolean>();
    for (let t = 0; t < 1; t += 0.01) seen.add(flashOn(t));
    expect(seen).toEqual(new Set([true, false]));
    expect(flashOn(0)).toBe(true);
  });
});
