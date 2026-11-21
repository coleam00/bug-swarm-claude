import { describe, expect, test } from "bun:test";
import { formatSkill, gatePasses, judge, parseSkillArgs, playLife, quantile, runSkill, USAGE } from "./skill-lib";

describe("bun run skill", () => {
  test("on 8 seeds the aimer out-scores the mover at least 2x, and neither median is degenerate", () => {
    const r = runSkill(8, 180);
    const by = (n: string) => r.policies.find((p) => p.policy === n)!;
    expect(r.pass).toBe(true);
    expect(r.trivial).toBe(false);
    expect(by("mover").medianScore).toBeGreaterThan(0);
    // Lives end on their own: the gate is not measuring the cap.
    expect(by("mover").capped).toBe(0);
    expect(by("aimer").capped).toBeLessThan(8);
    expect(by("idle").medianScore).toBe(0);
    expect(formatSkill(r).find((l) => l.startsWith("gate:"))).toContain("PASS");
    expect(formatSkill(r).find((l) => l.startsWith("dasher vs aimer:"))).toBeDefined();
  });

  test("the gate is 2x: an aimer at 19 against a mover at 10 fails, at 20 it passes", () => {
    expect(gatePasses(19, 10)).toBe(false);
    expect(gatePasses(20, 10)).toBe(true);
    expect(gatePasses(5, 0)).toBe(true);
    expect(gatePasses(0, 0)).toBe(false);
    const report = (aimer: number, mover: number) =>
      judge([
        { policy: "idle", medianScore: 0 },
        { policy: "mover", medianScore: mover },
        { policy: "aimer", medianScore: aimer },
      ]);
    expect(report(190, 100)).toEqual({ ratio: 1.9, pass: false, trivial: false });
    expect(report(200, 100)).toEqual({ ratio: 2, pass: true, trivial: false });
    expect(report(50, 0)).toEqual({ ratio: Infinity, pass: true, trivial: true });
  });

  test("a life replays exactly from its seed", () => {
    expect(playLife("aimer", 3, 60)).toEqual(playLife("aimer", 3, 60));
    expect(playLife("mover", 3, 60)).not.toEqual(playLife("mover", 4, 60));
  });

  test("the dash changes nothing for the policies that never dash in a life: lives as measured before #60", () => {
    // Captured on the commit before the dash existed (seeds 0 to 3, 60 s). The dash draws no
    // randomness, so these must not move.
    const before = {
      idle: [[0, 0, 9.9], [0, 0, 10], [0, 0, 10.15], [0, 0, 10.35]],
      mover: [[90, 9, 40.55], [120, 12, 45.6], [90, 9, 36.35], [70, 7, 30.25]],
      aimer: [[995, 99, 60], [1005, 98, 60], [970, 97, 60], [985, 98, 60]],
    } as const;
    for (const [policy, lives] of Object.entries(before)) {
      lives.forEach(([score, kills, seconds], seed) => {
        const l = playLife(policy as keyof typeof before, seed, 60);
        expect([l.score, l.kills, l.dashes]).toEqual([score, kills, 0]);
        expect(l.seconds).toBeCloseTo(seconds, 9);
      });
    }
  });

  test("the dasher dashes, and replays exactly from its seed", () => {
    const l = playLife("dasher", 1, 120);
    expect(l.dashes).toBeGreaterThan(0);
    expect(playLife("dasher", 1, 120)).toEqual(l);
  });

  test("quantiles and arguments", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBe(0);
    expect(parseSkillArgs([])).toEqual({ seeds: 30, max: 300 });
    expect(parseSkillArgs(["--seeds", "8", "--max", "60"])).toEqual({ seeds: 8, max: 60 });
    expect(parseSkillArgs(["--seeds", "0"])).toBe(USAGE);
    expect(parseSkillArgs(["--nope"])).toBe(USAGE);
  });
});
