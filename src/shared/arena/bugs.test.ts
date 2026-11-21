import { describe, expect, test } from "bun:test";
import { CRAWLER_SPEED, DT, MAX_BUGS_PER_ARENA, SPAWN_BASE_PER_S, SPAWN_DIST_MAX, SPAWN_MAX_PER_S, WAVE_S } from "./constants";
import { inView, spawnRate } from "./bugs";
import { createArena, joinPlayer, stepArena, wave, type ArenaState, type Bug } from "./sim";
import { arenaWith, placeBug, stepQuiet } from "./testkit";

/** Steps with every player untouchable and standing still; returns how many bugs spawned. */
function stepSpawning(a: ArenaState, ticks: number, onSpawn?: (bug: Bug) => void): number {
  let spawned = 0;
  for (let t = 0; t < ticks; t++) {
    const before = a.nextBugId;
    for (const p of a.players) p.invulnTicks = 1e9;
    stepArena(a);
    for (const b of a.bugs) if (b.id >= before) onSpawn?.(b);
    spawned += a.nextBugId - before;
  }
  return spawned;
}

describe("personal spawn budget", () => {
  test("a new life brings 0.3 bugs a second, rising with its age to a ceiling", () => {
    expect(spawnRate(0)).toBe(SPAWN_BASE_PER_S);
    expect(spawnRate(60)).toBeGreaterThan(spawnRate(30));
    expect(spawnRate(10_000)).toBe(SPAWN_MAX_PER_S);
    const { a } = arenaWith([1200, 1200]);
    // The integral of the rate over the first 10 s.
    let owed = 0;
    for (let t = 0; t < 10 / DT; t++) owed += spawnRate(t * DT) * DT;
    expect(Math.abs(stepSpawning(a, 10 / DT) - owed)).toBeLessThanOrEqual(1);
  });

  test("two players with lives of different ages bring different pressure", () => {
    const { a, ps } = arenaWith([400, 400], [2000, 2000]);
    ps[1]!.lifeStartTick = -Math.round(100 / DT);
    const near = [0, 0];
    stepSpawning(a, 10 / DT, (b) => {
      const d0 = Math.hypot(b.x - ps[0]!.x, b.y - ps[0]!.y);
      near[d0 <= SPAWN_DIST_MAX + 10 ? 0 : 1]!++;
    });
    expect(near[0]).toBeLessThanOrEqual(7);
    expect(near[1]).toBeGreaterThan(near[0]! * 5);
  });

  test("the wave counter shows the arena's age but never changes spawn volume", () => {
    const early = createArena(9);
    const late = createArena(9);
    late.tick = Math.round((5 * WAVE_S) / DT);
    joinPlayer(early, "a", "tabs");
    joinPlayer(late, "a", "tabs");
    expect(wave(early.tick)).toBe(1);
    expect(wave(late.tick)).toBe(6);
    expect(stepSpawning(late, 30 / DT)).toBe(stepSpawning(early, 30 / DT));
    expect(late.bugs.map((b) => [b.x, b.y])).toEqual(early.bugs.map((b) => [b.x, b.y]));
  });

  test("bugs spawn out of every alive player's view, including a player in a corner", () => {
    const { a, ps } = arenaWith([100, 100], [1200, 1200], [2300, 1200]);
    ps[0]!.lifeStartTick = -Math.round(200 / DT);
    let checked = 0;
    stepSpawning(a, 30 / DT, (b) => {
      // Where it spawned: it has already taken its first chase step.
      for (const p of ps) expect(inView(p, b.x - b.vx * DT, b.y - b.vy * DT)).toBe(false);
      checked++;
    });
    expect(checked).toBeGreaterThan(50);
  });

  test("the view square covers what the camera shows at a wall", () => {
    // A 16:9 view is 800 x 450; in a corner the camera stops at the wall plus 60 units.
    expect(inView({ x: 0, y: 0 }, -50, -50)).toBe(true);
    expect(inView({ x: 0, y: 0 }, 735, 735)).toBe(true);
    expect(inView({ x: 1200, y: 1200 }, 1200 + 460, 1200)).toBe(false);
  });

  test("an arena never holds more than MAX_BUGS_PER_ARENA bugs", () => {
    const a = createArena(3);
    for (let i = 0; i < 20; i++) joinPlayer(a, `p${i}`, "tabs").lifeStartTick = -Math.round(300 / DT);
    let most = 0;
    for (let t = 0; t < 30 / DT; t++) {
      stepSpawning(a, 1);
      most = Math.max(most, a.bugs.length);
    }
    expect(most).toBe(MAX_BUGS_PER_ARENA);
  });
});

describe("crawlers", () => {
  test("a crawler chases the nearest alive player", () => {
    const { a, ps } = arenaWith([1000, 1200], [1600, 1200]);
    const b = placeBug(a, 1400, 1200);
    stepQuiet(a);
    expect([b.vx, b.vy]).toEqual([CRAWLER_SPEED, 0]);
    expect(b.target).toBe(ps[1]!.id);
    ps[1]!.alive = false;
    stepQuiet(a);
    expect(b.vx).toBe(-CRAWLER_SPEED);
    expect(b.target).toBe(ps[0]!.id);
    ps[0]!.alive = false;
    stepQuiet(a);
    expect([b.vx, b.vy, b.target]).toEqual([0, 0, 0]);
  });
});
