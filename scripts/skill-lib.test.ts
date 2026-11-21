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
    expect(formatSkill(r).at(-1)).toContain("PASS");
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

  test("quantiles and arguments", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBe(0);
    expect(parseSkillArgs([])).toEqual({ seeds: 30, max: 300 });
    expect(parseSkillArgs(["--seeds", "8", "--max", "60"])).toEqual({ seeds: 8, max: 60 });
    expect(parseSkillArgs(["--seeds", "0"])).toBe(USAGE);
    expect(parseSkillArgs(["--nope"])).toBe(USAGE);
  });
});
