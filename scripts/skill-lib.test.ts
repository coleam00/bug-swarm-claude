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
  runQueen,
  runSkill,
  shellStats,
  countShells,
  USAGE,
  warmArenas,
} from "./skill-lib";
import { createArena } from "../src/shared/arena/sim";
import { QUEEN_HP_BASE, QUEEN_HP_PERSON } from "../src/shared/arena/queen";

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

describe("bun run skill: the hive queen (#85, reported, not gated)", () => {
  test("on 2 seeds, 4 aimers meet her at wave 5 with her hit points for 4 people, and the report says how long she took", () => {
    const r = runQueen(2, 4);
    expect(r.hp).toBe(QUEEN_HP_BASE + 4 * QUEEN_HP_PERSON);
    expect([r.seeds, r.aimers]).toEqual([2, 4]);
    expect(r.median).toBeGreaterThan(0);
    expect(r.p75).toBeGreaterThanOrEqual(r.median);
    // The kill is seen: not every fight runs to the cap.
    expect(r.capped).toBeLessThan(r.seeds);
    expect(runQueen(2, 4)).toEqual(r);
  });
});

describe("bun run skill", () => {
  test("a life's score is a whole number through a full 120 s aimer life (#123)", () => {
    // Before #123 seeds 1 and 5 ended at 2837.5 (a dasher at x1.5); tuning can move which seeds do.
    for (const seed of [0, 1, 2, 3, 4, 5]) expect(Number.isInteger(playLife("aimer", seed, 120).score)).toBe(true);
  });

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

  test("pickups are counted a life: the aimer takes some on 32 seeds, its shields block, its lasers hit, its bombs and drones kill; the idle takes none", () => {
    // Every first life's spawn shield (#90) blocks once, so a pickup shield's block shows as more
    // than one block a life (mean); on 32 seeds the aimer reads 1.125.
    const r = runSkill(32, 180);
    const by = (n: string) => r.policies.find((p) => p.policy === n)!;
    const aim = by("aimer").pickups.mean;
    expect(aim.taken.shield + aim.taken.laser + aim.taken.bomb).toBeGreaterThan(0);
    expect(aim.laserHits).toBeGreaterThan(0);
    expect(aim.bombKills).toBeGreaterThan(0);
    expect(aim.taken.drone).toBeGreaterThan(0);
    expect(aim.droneKills).toBeGreaterThan(0);
    expect(aim.blocks).toBeGreaterThan(1);
    expect(aim.taken.cloak).toBeGreaterThan(0);
    expect(aim.total).toBe(aim.taken.shield + aim.taken.laser + aim.taken.bomb + aim.taken.drone + aim.taken.cloak);
    // The idle takes none; its one block a life is its first life's spawn shield (#90).
    expect(by("idle").pickups.mean).toEqual({ total: 0, taken: { shield: 0, laser: 0, bomb: 0, drone: 0, cloak: 0 }, blocks: 1, laserHits: 0, bombKills: 0, droneKills: 0 });
    // One life's counts replay exactly.
    expect(playLife("aimer", 5, 120).pickups).toEqual(playLife("aimer", 5, 120).pickups);
  });

  test("bugs with a shell are counted (#80): a player's own beetle kills and shell blocks, nobody else's, no other kind", () => {
    const a = createArena(1);
    const ev = a.events;
    ev.kills.push({ bug: 1, by: 7, x: 0, y: 0, points: 60, kind: "beetle" }, { bug: 2, by: 7, x: 0, y: 0, points: 10, kind: "crawler" }, { bug: 3, by: 8, x: 0, y: 0, points: 60, kind: "beetle" });
    ev.shellBlocks.push(7, 8, 7);
    const c = { kills: 0, blocks: 0 };
    countShells(a, 7, c);
    expect(c).toEqual({ kills: 1, blocks: 2 });
    expect(shellStats([c, { kills: 0, blocks: 0 }, { kills: 2, blocks: 5 }])).toEqual({ median: { kills: 1, blocks: 2 }, mean: { kills: 1, blocks: 7 / 3 } });
  });

  test("pickupStats: the median and mean of each count", () => {
    const c = (shield: number, laser: number, bomb: number, drone: number, blocks: number, laserHits: number, bombKills: number, droneKills: number) => ({
      total: shield + laser + bomb + drone,
      taken: { shield, laser, bomb, drone, cloak: 0 },
      blocks,
      laserHits,
      bombKills,
      droneKills,
    });
    expect(pickupStats([c(0, 1, 0, 1, 0, 3, 0, 5), c(2, 1, 1, 0, 1, 0, 9, 0), c(1, 4, 2, 2, 0, 6, 3, 1)])).toEqual({
      median: c(1, 1, 1, 1, 0, 3, 3, 1),
      mean: c(1, 2, 1, 1, 1 / 3, 3, 4, 2),
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
