import { describe, expect, test } from "bun:test";
import {
  CRAWLER_SPEED,
  DT,
  MAX_BUGS_PER_ARENA,
  SPAWN_BASE_PER_S,
  SPAWN_DIST_MAX,
  SPAWN_MAX_PER_S,
  SPAWN_PROTECT_S,
  WAVE_S,
  WORLD_H,
  WORLD_W,
} from "./constants";
import { inView, pressureAge, spawnRate } from "./bugs";
import { POLICIES, createMemory, createObservation, observe, type PolicyInput } from "./policies";
import { createRng } from "./rng";
import { clampInput, createArena, joinPlayer, stepArena, wave, type ArenaState, type Bug } from "./sim";
import { arenaWith, placeBug, stepQuiet } from "./testkit";

/** The item's numbers (#58), written out so a test fails if a constant drifts from them. */
const ITEM_EASY_S = 10;
const ITEM_PROTECT_S = 2;

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
    // The integral of the rate over the first 30 s of a first life (held back 10 s).
    let owed = 0;
    for (let t = 0; t < 30 / DT; t++) owed += spawnRate(Math.max(0, t * DT - ITEM_EASY_S)) * DT;
    expect(Math.abs(stepSpawning(a, 30 / DT) - owed)).toBeLessThanOrEqual(1);
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

describe("fair drop-in: personal pacing", () => {
  test("pressure follows the life's age, held back 10 s on the first life only", () => {
    const first = { lifeStartTick: 100, firstLife: true };
    const later = { lifeStartTick: 100, firstLife: false };
    const at = (s: number) => 100 + Math.round(s / DT);
    expect(pressureAge(first, at(5))).toBe(0);
    expect(pressureAge(first, at(ITEM_EASY_S))).toBe(0);
    expect(pressureAge(first, at(ITEM_EASY_S + 20))).toBeCloseTo(20, 9);
    expect(pressureAge(later, at(5))).toBeCloseTo(5, 9);
    expect(pressureAge(later, at(30))).toBeCloseTo(30, 9);
  });

  test("a newcomer joining an arena aimer bots have played for 10 minutes meets the same pressure as one joining at the start, or alone", () => {
    // What the sim itself charges the newcomer each tick: their budget is zeroed before each step
    // (so nothing spawns for them and the step's whole growth stays in it), and read after. They
    // cannot be hit, so all three records run the full 30 s.
    const record = (warmTicks: number, botCount = 3): number[] => {
      const a = createArena(21);
      const bots = Array.from({ length: botCount }, (_, i) => i).map((i) => ({
        id: joinPlayer(a, `bot ${i}`, "tabs").id,
        rng: createRng(100 + i),
        mem: createMemory(),
        obs: createObservation(),
        out: { mx: 0, my: 0, aim: 0, fire: false, dash: false } as PolicyInput,
      }));
      const drive = () => {
        for (const b of bots) {
          observe(a, b.id, WORLD_W, WORLD_H, b.obs);
          POLICIES.aimer(b.obs, b.mem, b.rng, b.out);
          a.players.find((q) => q.id === b.id)!.input = clampInput({ seq: 0, ...b.out });
        }
      };
      for (let t = 0; t < warmTicks; t++) {
        drive();
        stepArena(a);
      }
      const p = joinPlayer(a, "new", "tabs");
      const rates: number[] = [];
      for (let t = 0; t < 600 && p.alive; t++) {
        drive();
        p.budget = 0;
        p.invulnTicks = 1e9; // kept alive by the hit timer, which neither pressure nor targeting reads
        stepArena(a);
        rates.push(p.budget);
      }
      return rates;
    };
    const early = record(0);
    const late = record(Math.round(600 / DT));
    const alone = record(0, 0);
    const easy = Math.round(ITEM_EASY_S / DT);
    // The late arena is busy, but the newcomer's own pressure is the same, tick by tick: no boost
    // from the arena's age, its crowd or its bugs.
    expect([early.length, late.length, alone.length]).toEqual([600, 600, 600]);
    expect(late).toEqual(early.slice(0, late.length));
    expect(early).toEqual(alone.slice(0, early.length));
    // And it is the curve: the base rate through the first life's easy 10 s, rising after.
    expect(late[0]).toBeCloseTo(spawnRate(0) * DT, 12);
    expect(late.slice(0, easy)).toEqual(Array(easy).fill(late[0]));
    expect(late[late.length - 1]).toBeGreaterThan(late[0]!);
  });

  test("bugs chasing someone else are not redirected at a protected newcomer, until protection ends", () => {
    const { a, ps } = arenaWith([300, 1200]);
    const A = ps[0]!;
    const b = placeBug(a, 1300, 1200);
    stepQuiet(a);
    expect(b.target).toBe(A.id);
    const B = joinPlayer(a, "new", "spaces");
    B.x = b.x + 50;
    B.y = 1200;
    const protect = Math.round(ITEM_PROTECT_S / DT);
    for (let t = 0; t < protect; t++) {
      stepQuiet(a);
      expect(b.target).toBe(A.id);
    }
    expect(B.protectTicks).toBe(0);
    stepQuiet(a);
    expect(b.target).toBe(B.id);
  });

  test("a protected newcomer's own spawns chase them; with only protected players alive, bugs take the nearest", () => {
    const { a, ps } = arenaWith([100, 100]);
    const B = joinPlayer(a, "new", "spaces");
    B.x = 1800;
    B.y = 1800;
    B.lifeStartTick = -Math.round(100 / DT); // enough pressure to spawn inside the protection
    let own = 0;
    for (let t = 0; t < Math.round(SPAWN_PROTECT_S / DT) - 1; t++) {
      const before = a.nextBugId;
      stepArena(a);
      for (const bug of a.bugs) {
        if (bug.id < before || Math.hypot(bug.x - B.x, bug.y - B.y) > SPAWN_DIST_MAX + 10) continue;
        expect(bug.target).toBe(B.id);
        own++;
      }
    }
    expect(B.protectTicks).toBeGreaterThan(0);
    expect(own).toBeGreaterThan(0);
    ps[0]!.alive = false;
    const stray = placeBug(a, 1000, 1000);
    stepQuiet(a);
    expect(stray.target).toBe(B.id);
  });
});
