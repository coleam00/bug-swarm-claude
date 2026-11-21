import { describe, expect, test } from "bun:test";
import {
  formatDropIn,
  formatSkill,
  gatePasses,
  idleGate,
  judge,
  lateGate,
  parseSkillArgs,
  playLife,
  playNewcomer,
  quantile,
  runDropIn,
  runSkill,
  USAGE,
  warmArenas,
} from "./skill-lib";

describe("bun run skill: fair drop-in", () => {
  test("the late gate is 0.8x and the idle gate 10 s, at their boundaries", () => {
    expect(lateGate(79, 100)).toBe(false);
    expect(lateGate(80, 100)).toBe(true);
    expect(lateGate(0, 0)).toBe(false);
    expect(idleGate([12, 9.9, 15])).toBe(false);
    expect(idleGate([10, 10, 30])).toBe(true);
    expect(idleGate([])).toBe(false);
  });

  test("a newcomer's life replays exactly from a warmed arena, which the play leaves untouched", () => {
    const [aged] = warmArenas(2, [0.5]);
    const before = JSON.stringify(aged);
    expect(aged!.state.tick).toBe(600);
    expect(playNewcomer(aged!, "mover", 2, 60)).toEqual(playNewcomer(aged!, "mover", 2, 60));
    expect(JSON.stringify(aged)).toBe(before);
  });

  test("a reduced run produces lives and numbers at every join age", () => {
    const r = runDropIn(2, 3, 60, [0, 1], 1);
    expect(r.idle.map((a) => a.lives)).toEqual([2, 2]);
    // The late gate plays its own seed count; the mover is reported, only the aimer gated.
    expect(r.late.map((l) => [l.policy, l.gated, l.early.lives, l.late.lives])).toEqual([
      ["mover", false, 3, 3],
      ["aimer", true, 3, 3],
    ]);
    expect(r.latePass).toBe(r.late[1]!.pass);
    for (const a of [...r.idle, ...r.late.flatMap((l) => [l.early, l.late])]) {
      for (const v of [a.median, a.p25, a.p75, a.bugsAtJoin]) expect(Number.isFinite(v)).toBe(true);
      expect(a.median).toBeGreaterThan(0);
    }
    const lines = formatDropIn(r);
    expect(lines.filter((l) => l.startsWith("gate:"))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("info: mover late"))).toHaveLength(1);
  });
});

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
    expect(parseSkillArgs([])).toEqual({ seeds: 30, lateSeeds: 60, max: 300 });
    expect(parseSkillArgs(["--seeds", "8", "--late-seeds", "12", "--max", "60"])).toEqual({ seeds: 8, lateSeeds: 12, max: 60 });
    expect(parseSkillArgs(["--late-seeds", "0"])).toBe(USAGE);
    expect(parseSkillArgs(["--seeds", "0"])).toBe(USAGE);
    expect(parseSkillArgs(["--nope"])).toBe(USAGE);
  });
});
