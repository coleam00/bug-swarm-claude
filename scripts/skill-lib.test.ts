import { describe, expect, test } from "bun:test";
import {
  fillBeatable,
  formatDropIn,
  formatFill,
  formatSkill,
  gatePasses,
  idleGate,
  judge,
  lateGate,
  parseSkillArgs,
  playLife,
  pickupStats,
  playNewcomer,
  quantile,
  runDropIn,
  runFill,
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
    expect(formatSkill(r).find((l) => l.startsWith("gate:"))).toContain("PASS");
    expect(by("dasher").medianDashes).toBeGreaterThan(0);
    // Every kind is in the mix of a life that lasts: dasher bugs spawn from 30 s and land hits.
    for (const n of ["mover", "aimer", "dasher"]) expect(by(n).medianSpawned.dasher).toBeGreaterThan(0);
    expect(by("aimer").medianTouches.dasher).toBeGreaterThan(0);
    expect(by("idle").medianSpawned.dasher).toBe(0);
  });

  test("on 8 seeds the fill bot is good but beatable: above 2x the mover's median score, below the aimer's", () => {
    const f = runFill(8, 180, runSkill(8, 180));
    expect(f.lives).toBe(8);
    expect(f.medianScore).toBeGreaterThan(2 * f.mover);
    expect(f.medianScore).toBeLessThan(f.aimer);
    expect(fillBeatable(f)).toBe(true);
    expect(formatFill(f)).toContain("between them");
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

  test("idle, mover and aimer never dash in a life; the dasher does, and its life differs from the aimer's", () => {
    for (const policy of ["idle", "mover", "aimer"] as const) {
      for (const seed of [0, 1, 2]) expect(playLife(policy, seed, 60).dashes).toBe(0);
    }
    // Seed 4: one where a bug gets within dashing range in 120 s (#58's gentle first life and spawn
    // picker leave seed 1 with no close call, so the dasher there plays exactly as the aimer).
    const dasher = playLife("dasher", 4, 120);
    const aimer = playLife("aimer", 4, 120);
    expect(dasher.dashes).toBeGreaterThan(0);
    expect([dasher.score, dasher.seconds]).not.toEqual([aimer.score, aimer.seconds]);
  });

  test("pickups are counted a life: the aimer takes some on 16 seeds, its shields block and its lasers hit; the idle takes none", () => {
    // 16 seeds, not 8: at #73's drop chances a shield block is rare (1 in 16 lives here), and the
    // spitter (#72) moved the seeded lives so the first 8 hold none.
    const r = runSkill(16, 180);
    const by = (n: string) => r.policies.find((p) => p.policy === n)!;
    const aim = by("aimer").pickups.mean;
    expect(aim.taken.shield + aim.taken.laser).toBeGreaterThan(0);
    expect(aim.laserHits).toBeGreaterThan(0);
    expect(aim.blocks).toBeGreaterThan(0);
    // A block is never a hit landed: the counts come from different events.
    expect(by("idle").pickups.mean).toEqual({ taken: { shield: 0, laser: 0 }, blocks: 0, laserHits: 0 });
    // One life's counts replay exactly.
    expect(playLife("aimer", 5, 120).pickups).toEqual(playLife("aimer", 5, 120).pickups);
  });

  test("bugs with a shell are counted a life (#80): an aimer's shots blocked by a shell on seeds 1 and 7, none for the idle", () => {
    const blocks = [1, 7].map((seed) => playLife("aimer", seed, 180).shells.blocks);
    expect(blocks.every((b) => b > 0)).toBe(true);
    expect(playLife("idle", 1, 180).shells).toEqual({ kills: 0, blocks: 0 });
  });

  test("pickupStats: the median and mean of each count", () => {
    const c = (shield: number, laser: number, blocks: number, laserHits: number) => ({ taken: { shield, laser }, blocks, laserHits });
    expect(pickupStats([c(0, 1, 0, 3), c(2, 1, 1, 0), c(1, 4, 0, 6)])).toEqual({
      median: c(1, 1, 0, 3),
      mean: c(1, 2, 1 / 3, 3),
    });
  });

  test("quantiles and arguments", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBe(0);
    expect(parseSkillArgs([])).toEqual({ seeds: 30, lateSeeds: 240, max: 300 });
    expect(parseSkillArgs(["--seeds", "8", "--late-seeds", "12", "--max", "60"])).toEqual({ seeds: 8, lateSeeds: 12, max: 60 });
    expect(parseSkillArgs(["--late-seeds", "0"])).toBe(USAGE);
    expect(parseSkillArgs(["--seeds", "0"])).toBe(USAGE);
    expect(parseSkillArgs(["--nope"])).toBe(USAGE);
  });
});
