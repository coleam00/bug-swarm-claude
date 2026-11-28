// The bug-kind seam's #85 growth, by stepping, before any kind uses it: a launch of several bugs
// spread round the turn with a cap per launch, the second launch (STEP_LAUNCH_ALT), a kind that
// stays on contact, and the spawn cap held back while a hive queen is staged. Each test patches a
// stock kind's definition for its own duration and puts it back, so no test-only kind is listed.
import { afterEach, describe, expect, test } from "bun:test";
import { DT, MAX_BUGS_PER_ARENA, PICKUP_IDS, QUEEN_RESERVE, WAVE_S } from "../constants";
import { createArena, joinPlayer, stepArena } from "../sim";
import { arenaWith, placeBug, stepQuiet } from "../testkit";
import { GLOB_MAX_PER_ARENA, GLOB_RADIUS } from "./glob";
import { STEP_LAUNCH, STEP_LAUNCH_ALT, type BugKindDef } from "./kind";
import { BUG_DEFS } from "./registry";
import { spawnCap } from "./index";

const original = { ...BUG_DEFS.crawler };
afterEach(() => {
  BUG_DEFS.crawler = { ...original };
});

/** Makes the crawler stand still and return `result` from every step, with `patch` applied. */
function patchCrawler(result: number | undefined, patch: Partial<BugKindDef>): void {
  BUG_DEFS.crawler = { ...original, ...patch, step: () => result as never };
}

describe("launches (#85)", () => {
  test("a launch of 3 leaves the first along (dx, dy) exactly and the others a third of a turn apart", () => {
    patchCrawler(STEP_LAUNCH, { launches: [{ kind: "glob", speed: 300, count: 3, capAt: MAX_BUGS_PER_ARENA }] });
    const { a, ps } = arenaWith([200, 200]);
    ps[0]!.invulnTicks = 1e9;
    const c = placeBug(a, 1200, 1200);
    c.dx = 0.6;
    c.dy = 0.8;
    stepQuiet(a);
    const globs = a.bugs.filter((b) => b.kind === "glob");
    expect(globs).toHaveLength(3);
    expect([globs[0]!.dx, globs[0]!.dy]).toEqual([0.6, 0.8]);
    const off = original.radius + GLOB_RADIUS;
    for (let i = 0; i < 3; i++) {
      const g = globs[i]!;
      const angle = Math.atan2(0.8, 0.6) + (i * 2 * Math.PI) / 3;
      expect(g.dx).toBeCloseTo(Math.cos(angle), 12);
      expect(g.dy).toBeCloseTo(Math.sin(angle), 12);
      expect(g.x).toBeCloseTo(1200 + g.dx * off, 9);
      expect(g.y).toBeCloseTo(1200 + g.dy * off, 9);
      expect([g.vx, g.vy].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([Math.round(g.dx * 300 * 1e9) / 1e9, Math.round(g.dy * 300 * 1e9) / 1e9]);
    }
  });

  test("a launch stops at its cap on the arena's bugs and at the launched kind's own cap", () => {
    patchCrawler(STEP_LAUNCH, { launches: [{ kind: "glob", speed: 300, count: 12, capAt: 10 }] });
    const { a, ps } = arenaWith([200, 200]);
    ps[0]!.invulnTicks = 1e9;
    placeBug(a, 1200, 1200);
    for (let i = 0; i < 5; i++) placeBug(a, 2000, 300 + i * 30, "spitter");
    stepQuiet(a);
    // 6 bugs before; the launch fills to 10, then stops, and the crawler goes on launching nothing.
    expect(a.bugs.filter((b) => b.kind === "glob")).toHaveLength(4);
    expect(a.bugs).toHaveLength(10);

    BUG_DEFS.crawler = { ...BUG_DEFS.crawler, launches: [{ kind: "glob", speed: 300, count: 12, capAt: MAX_BUGS_PER_ARENA }] };
    for (let i = 0; i < 4; i++) stepQuiet(a);
    expect(a.bugs.filter((b) => b.kind === "glob").length).toBeLessThanOrEqual(GLOB_MAX_PER_ARENA);
  });

  test("STEP_LAUNCH_ALT launches the second entry, not the first", () => {
    patchCrawler(STEP_LAUNCH_ALT, {
      launches: [
        { kind: "glob", speed: 300, count: 5, capAt: MAX_BUGS_PER_ARENA },
        { kind: "dasher", speed: 0, count: 2, capAt: MAX_BUGS_PER_ARENA },
      ],
    });
    const { a, ps } = arenaWith([200, 200]);
    ps[0]!.invulnTicks = 1e9;
    const c = placeBug(a, 1200, 1200);
    c.dx = 1;
    stepQuiet(a);
    expect(a.bugs.map((b) => b.kind).sort()).toEqual(["crawler", "dasher", "dasher"]);
    const d = a.bugs.filter((b) => b.kind === "dasher");
    expect([d[0]!.vx, d[0]!.vy, d[1]!.dx]).toEqual([0, 0, -1]);
  });
});

describe("stays on contact (#85)", () => {
  test("it strikes every player it touches in one step and is kept; a repeat hit waits out the untouchable time", () => {
    patchCrawler(undefined, { staysOnContact: true });
    const { a, ps } = arenaWith([1200, 1200], [1210, 1200], [1600, 1200]);
    const c = placeBug(a, 1205, 1200);
    stepQuiet(a);
    expect(a.events.touches.map((t) => t.player)).toEqual([ps[0]!.id, ps[1]!.id]);
    expect(a.bugs).toContain(c);
    expect([ps[0]!.hits, ps[1]!.hits, ps[2]!.hits]).toEqual([1, 1, 0]);
    const untouchable = ps[0]!.invulnTicks;
    stepQuiet(a, untouchable - 1);
    expect(ps[0]!.hits).toBe(1);
    stepQuiet(a, 2);
    expect(ps[0]!.hits).toBe(2);
  });

  test("without it, a touch spends the bug and strikes one player", () => {
    const { a, ps } = arenaWith([1200, 1200], [1210, 1200]);
    const c = placeBug(a, 1205, 1200);
    c.target = 0;
    stepQuiet(a);
    expect(a.events.touches).toHaveLength(1);
    expect(a.bugs).not.toContain(c);
    expect(ps[0]!.hits + ps[1]!.hits).toBe(1);
  });
});

describe("harmless (#122)", () => {
  test("touching players who can be hit costs no hit, raises no touch or block, and the bug stays", () => {
    patchCrawler(undefined, { harmless: true });
    const { a, ps } = arenaWith([1200, 1200], [1210, 1200]);
    // The second player holds a test shield: a touch would spend it (a block) and make them untouchable.
    ps[1]!.effect[PICKUP_IDS.indexOf("shield")] = 1e9;
    const c = placeBug(a, 1205, 1200);
    let touches = 0;
    let blocks = 0;
    for (let i = 0; i < 30; i++) {
      stepQuiet(a);
      touches += a.events.touches.length + a.events.hitsTaken.length;
      blocks += a.events.blocks.length;
    }
    expect([touches, blocks]).toEqual([0, 0]);
    expect(a.bugs).toContain(c);
    expect([ps[0]!.hits, ps[1]!.hits, ps[0]!.invulnTicks, ps[1]!.invulnTicks]).toEqual([0, 0, 0, 0]);
    expect(ps[1]!.effect[PICKUP_IDS.indexOf("shield")]).toBeGreaterThan(0);
  });
});

describe("the spawn cap (#85)", () => {
  test("it is the arena's cap with no queen staged, QUEEN_RESERVE short of it while one is", () => {
    const a = createArena(3);
    expect(spawnCap(a)).toBe(MAX_BUGS_PER_ARENA);
    a.queen.stage = 1;
    expect(spawnCap(a)).toBe(MAX_BUGS_PER_ARENA - QUEEN_RESERVE);
    a.queen.stage = 2;
    expect(spawnCap(a)).toBe(MAX_BUGS_PER_ARENA - QUEEN_RESERVE);
  });

  test("the spawn mix stops at the reduced cap while a queen is staged", () => {
    const a = createArena(5, Math.round(WAVE_S / DT));
    const p = joinPlayer(a, "a", "tabs");
    p.lifeStartTick = a.tick - Math.round(600 / DT);
    p.firstLife = false;
    a.queen.stage = 1;
    a.queen.ticksLeft = 1e9;
    for (let t = 0; t < 400; t++) {
      p.invulnTicks = 1e9;
      // Every bug stands still far from the player, so the arena only fills.
      for (const b of a.bugs) b.target = 0;
      stepArena(a);
      expect(a.bugs.length).toBeLessThanOrEqual(MAX_BUGS_PER_ARENA - QUEEN_RESERVE);
    }
    expect(a.bugs.length).toBe(MAX_BUGS_PER_ARENA - QUEEN_RESERVE);
  });
});
