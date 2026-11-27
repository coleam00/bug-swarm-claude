// The golden bug (#122), by stepping the simulation: how often its timer brings one and where,
// that it leaves the spawn mix alone, how it flees, that it hurts no one, what its kill pays, and
// the event that names its killer for the arena-wide banner.
import { describe, expect, test } from "bun:test";
import { mult } from "../combat";
import { BUG_KINDS, DT, MAX_BUGS_PER_ARENA, PICKUP_IDS, WORLD_H, WORLD_W } from "../constants";
import { GOLDEN_EVERY_MAX_S, GOLDEN_EVERY_MIN_S, GOLDEN_KIND, GOLDEN_SPAWN_DIST, GOLDEN_WALL_CLEAR, goldenInterval } from "../golden";
import { createRng } from "../rng";
import { createArena, endLife, joinPlayer, stepArena, type ArenaState, type Kill, type Player } from "../sim";
import { arenaWith, hold, nextDrop, placeBug, placePickup, stepQuiet } from "../testkit";
import { CRAWLER_SPEED } from "./crawler";
import { GOLDEN_LIFE_TICKS, GOLDEN_POINTS, GOLDEN_RADIUS, GOLDEN_SPEED } from "./golden";
import { bugDef } from "./registry";

/** An arena of `n` players who stand still, nobody firing. */
function heldArena(seed: number, n: number): { a: ArenaState; ps: Player[] } {
  const a = createArena(seed);
  const ps = Array.from({ length: n }, (_, i) => joinPlayer(a, `p${i}`, "tabs"));
  return { a, ps };
}

/**
 * One step with every player untouchable (so they stay up). With `quiet`, no mix spawns and every
 * bug but a golden one cleared after the step (a hive queen's brood too), so the arena never fills.
 */
function stepHeld(a: ArenaState, quiet = false): void {
  for (const p of a.players) {
    p.invulnTicks = 1e9;
    if (quiet) p.budget = 0;
  }
  stepArena(a);
  if (quiet) a.bugs = a.bugs.filter((b) => b.kind === GOLDEN_KIND);
}

/** The ids of every golden bug the timer brings in `seconds`, and the most alive at once. */
function goldenSpawns(seed: number, n: number, seconds: number): { ids: number[]; most: number; at: [number, number][] } {
  const { a } = heldArena(seed, n);
  const ids: number[] = [];
  const at: [number, number][] = [];
  let most = 0;
  for (let t = 0; t < seconds / DT; t++) {
    stepHeld(a, true);
    let alive = 0;
    for (const b of a.bugs) {
      if (b.kind !== GOLDEN_KIND) continue;
      alive++;
      if (!ids.includes(b.id)) {
        ids.push(b.id);
        at.push([b.x, b.y]);
      }
    }
    most = Math.max(most, alive);
  }
  return { ids, most, at };
}

describe("golden bug timer", () => {
  test("slots come 45 to 75 s apart, about once a minute", () => {
    const rng = createRng(5);
    let sum = 0;
    for (let i = 0; i < 2000; i++) {
      const t = goldenInterval(rng) * DT;
      expect(t).toBeGreaterThanOrEqual(GOLDEN_EVERY_MIN_S);
      expect(t).toBeLessThanOrEqual(GOLDEN_EVERY_MAX_S);
      sum += t;
    }
    expect(sum / 2000).toBeCloseTo(60, 0);
  });

  test("spawn rate by seed: 8 to 13 in 10 minutes, never 2 alive at once, and each seed replays exactly", () => {
    for (const seed of [1, 2, 3, 7, 42]) {
      const run = goldenSpawns(seed, 2, 600);
      expect(run.ids.length).toBeGreaterThanOrEqual(8);
      expect(run.ids.length).toBeLessThanOrEqual(13);
      expect(run.most).toBe(1);
      expect(goldenSpawns(seed, 2, 600)).toEqual(run);
    }
  });

  test("it leaves the spawn mix alone: the mix never picks it, and every spawn is as with no timer", () => {
    expect(bugDef(GOLDEN_KIND).spawn.share(0)).toBe(0);
    expect(bugDef(GOLDEN_KIND).spawn.share(1e6)).toBe(0);
    // The same seed with the timer held off: every other spawn is the same kind in the same place,
    // and state.rng is where it would be. (Later positions may differ: a golden bug takes a bug id,
    // and a spitter strafes by its id's parity, so its globs leave elsewhere.) One player, 100 s: the arena holds well under 150
    // when the first slot (45 to 75 s) comes.
    const spawns = (timer: boolean) => {
      const a = heldArena(11, 1).a;
      if (!timer) a.golden.nextTick = Infinity;
      const out: [string, number, number][] = [];
      let goldens = 0;
      for (let t = 0; t < 100 / DT; t++) {
        const before = a.nextBugId;
        stepHeld(a);
        for (const b of a.bugs) {
          if (b.id < before) continue;
          if (b.kind === GOLDEN_KIND) goldens++;
          // A launched glob leaves along its spitter's facing, and spitters strafe by id parity.
          else if (b.kind !== "glob") out.push([b.kind, Math.round(b.x * 1e6), Math.round(b.y * 1e6)]);
        }
      }
      return { out, goldens, rng: a.rng.state };
    };
    const on = spawns(true);
    const off = spawns(false);
    expect([on.goldens, off.goldens]).toEqual([1, 0]);
    expect(on.out.length).toBeGreaterThan(50);
    expect(on.out).toEqual(off.out);
    expect(on.rng).toBe(off.rng);
  });

  test("it appears GOLDEN_SPAWN_DIST from a player who is up (on their screen), inside the walls", () => {
    for (const seed of [1, 2, 3]) {
      const { a, ps } = heldArena(seed, 3);
      ps[0]!.x = 30;
      ps[0]!.y = 30; // in a corner: its spot is clamped inside the walls
      a.tick = a.golden.nextTick;
      stepHeld(a, true);
      const g = a.bugs.find((b) => b.kind === GOLDEN_KIND)!;
      expect(g).toBeDefined();
      // It was placed at the distance from one of them and fled one step in the same tick.
      const nearest = Math.min(...ps.map((p) => Math.hypot(p.x - g.x, p.y - g.y)));
      expect(nearest).toBeLessThanOrEqual(GOLDEN_SPAWN_DIST + GOLDEN_SPEED * DT + 1e-9);
      expect(g.x).toBeGreaterThanOrEqual(GOLDEN_RADIUS);
      expect(g.y).toBeGreaterThanOrEqual(GOLDEN_RADIUS);
      expect(g.x).toBeLessThanOrEqual(WORLD_W - GOLDEN_RADIUS);
      expect(g.y).toBeLessThanOrEqual(WORLD_H - GOLDEN_RADIUS);
    }
    // The corner player's spot keeps GOLDEN_WALL_CLEAR from both walls.
    const { a, ps } = heldArena(4, 1);
    ps[0]!.x = 30;
    ps[0]!.y = 30;
    a.tick = a.golden.nextTick;
    const before = a.nextBugId;
    stepHeld(a, true);
    const g = a.bugs.find((b) => b.id >= before && b.kind === GOLDEN_KIND)!;
    expect(Math.min(g.x, g.y)).toBeGreaterThanOrEqual(GOLDEN_WALL_CLEAR - GOLDEN_SPEED * DT);
  });

  test("a slot with nobody up, a golden bug alive or a full arena brings none, and is not queued", () => {
    // Nobody up.
    const none = heldArena(3, 1);
    endLife(none.a, none.ps[0]!);
    let slot = none.a.golden.nextTick;
    none.a.tick = slot;
    stepArena(none.a);
    expect(none.a.bugs).toHaveLength(0);
    expect(none.a.golden.nextTick).toBeGreaterThan(slot);

    // One alive already: the slot passes and the next one is scheduled.
    const { a, ps } = arenaWith([1200, 1200]);
    ps[0]!.invulnTicks = 1e9;
    a.golden.nextTick = a.tick;
    stepQuiet(a);
    expect(a.bugs.filter((b) => b.kind === GOLDEN_KIND)).toHaveLength(1);
    a.golden.nextTick = a.tick;
    stepQuiet(a);
    expect(a.bugs.filter((b) => b.kind === GOLDEN_KIND)).toHaveLength(1);
    expect(a.golden.nextTick).toBeGreaterThan(a.tick);

    // A full arena: none, and none on the next tick either (the slot is gone).
    const full = arenaWith([1200, 1200]);
    full.ps[0]!.invulnTicks = 1e9;
    for (let i = 0; i < MAX_BUGS_PER_ARENA; i++) placeBug(full.a, 2000 + (i % 10) * 20, 200 + Math.floor(i / 10) * 30);
    for (const b of full.a.bugs) b.hp = 1e9;
    full.a.golden.nextTick = full.a.tick;
    slot = full.a.tick;
    stepQuiet(full.a);
    expect(full.a.bugs.some((b) => b.kind === GOLDEN_KIND)).toBe(false);
    full.a.bugs.length = 0;
    stepQuiet(full.a);
    expect(full.a.bugs.some((b) => b.kind === GOLDEN_KIND)).toBe(false);
    expect(full.a.golden.nextTick).toBeGreaterThan(slot);
  });
});

describe("golden bug fleeing", () => {
  test("it runs straight away from the nearest player who is up at 1.1x a crawler's speed", () => {
    expect(GOLDEN_SPEED).toBeCloseTo(1.1 * CRAWLER_SPEED, 9);
    const { a, ps } = arenaWith([1200, 1200], [300, 300]);
    const g = placeBug(a, 1260, 1280, GOLDEN_KIND);
    const p = ps[0]!;
    let d = Math.hypot(g.x - p.x, g.y - p.y);
    for (let t = 0; t < 10; t++) {
      stepQuiet(a);
      const nd = Math.hypot(g.x - p.x, g.y - p.y);
      expect(nd - d).toBeCloseTo(GOLDEN_SPEED * DT, 9);
      // Still on the line from the player through where it started: (60, 80) is 3:4.
      expect((g.x - p.x) / (g.y - p.y)).toBeCloseTo(0.75, 9);
      expect(Math.hypot(g.vx, g.vy)).toBeCloseTo(GOLDEN_SPEED, 6);
      d = nd;
    }
  });

  test("against a wall it slides along it and stays inside", () => {
    const { a } = arenaWith([WORLD_W - 100, 1200]);
    const g = placeBug(a, WORLD_W - 20, 1180, GOLDEN_KIND);
    for (let t = 0; t < 40; t++) {
      stepQuiet(a);
      expect(g.x).toBeLessThanOrEqual(WORLD_W - GOLDEN_RADIUS);
    }
    expect(g.x).toBe(WORLD_W - GOLDEN_RADIUS);
    expect(g.y).toBeLessThan(1180 - 40 * 0.5 * GOLDEN_SPEED * DT);
  });

  test("with nobody up it stands, and after 20 s it leaves unscored and unnamed", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    endLife(a, ps[0]!);
    const g = placeBug(a, 1300, 1200, GOLDEN_KIND);
    stepQuiet(a);
    expect([g.x, g.y, g.vx, g.vy]).toEqual([1300, 1200, 0, 0]);
    stepQuiet(a, GOLDEN_LIFE_TICKS - 2);
    expect(a.bugs).toContain(g);
    stepQuiet(a);
    expect(a.bugs).not.toContain(g);
    expect([a.events.kills, a.events.golden]).toEqual([[], []]);
  });
});

describe("golden bug contact", () => {
  test("it never hurts anyone: overlapping a player who can be hit costs nothing, and it stays", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.effect[PICKUP_IDS.indexOf("shield")] = 1e9;
    const g = placeBug(a, 1205, 1200, GOLDEN_KIND);
    for (let t = 0; t < 20; t++) {
      g.x = p.x + 3; // held on top of them
      g.y = p.y;
      stepQuiet(a);
      expect([a.events.touches, a.events.hitsTaken, a.events.blocks]).toEqual([[], [], []]);
    }
    expect(a.bugs).toContain(g);
    expect([p.hits, p.invulnTicks]).toEqual([0, 0]);
  });
});

describe("golden bug kills", () => {
  test("it takes 2 shots and pays 100 times the multiplier to the killer, named in events.golden", () => {
    expect(bugDef(GOLDEN_KIND).hp).toBe(2);
    expect(GOLDEN_POINTS).toBe(100);
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const g = placeBug(a, 1290, 1200, GOLDEN_KIND);
    const kills: Kill[] = [];
    let named: number[] = [];
    let ended = 0;
    for (let t = 0; t < 60 && kills.length === 0; t++) {
      hold(p, { fire: t === 0 || t === 6 });
      stepQuiet(a);
      ended += a.events.shotsEnded.filter((s) => s.hit).length;
      if (ended === 1 && kills.length === 0) expect([g.hp, p.score]).toEqual([1, 0]);
      kills.push(...a.events.kills);
      if (a.events.kills.length > 0) named = [...a.events.golden];
      else expect(a.events.golden).toEqual([]);
    }
    expect(kills).toEqual([expect.objectContaining({ bug: g.id, by: p.id, points: GOLDEN_POINTS * mult(1), kind: GOLDEN_KIND })]);
    expect(p.score).toBe(100);
    expect(named).toEqual([p.id]);
  });

  test("a refactor bomb that kills it pays the taker 100 and names them in events.golden", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const g = placeBug(a, 1300, 1200, GOLDEN_KIND);
    placePickup(a, 1200, 1200, "bomb");
    nextDrop(a, 0.5, true);
    stepQuiet(a);
    expect(a.bugs).not.toContain(g);
    expect(a.events.kills).toEqual([expect.objectContaining({ bug: g.id, by: p.id, points: GOLDEN_POINTS, kind: GOLDEN_KIND })]);
    expect(a.events.golden).toEqual([p.id]);
    expect(p.score).toBe(GOLDEN_POINTS);
  });

  test("a kill by a shot whose life is over scores nothing and names no one", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const g = placeBug(a, 1500, 1200, GOLDEN_KIND);
    g.hp = 1;
    hold(p, { aim: 0, fire: true });
    stepQuiet(a);
    hold(p, {});
    endLife(a, p);
    let kill: Kill | null = null;
    for (let i = 0; i < 20 && !kill; i++) {
      stepQuiet(a);
      kill = a.events.kills[0] ?? null;
      if (kill) expect(a.events.golden).toEqual([]);
    }
    expect(kill).toMatchObject({ bug: g.id, by: 0, points: 0 });
  });

  test("its index in BUG_KINDS is after every other kind (protocol v13 appends it)", () => {
    expect(BUG_KINDS.indexOf(GOLDEN_KIND)).toBe(BUG_KINDS.length - 1);
  });
});
