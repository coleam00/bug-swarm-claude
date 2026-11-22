// The hive queen's own behaviour (#85), by stepping her placed by hand: her drift toward her goal,
// her brood, her tell and ring, the caps on both, and that she never comes from the spawn mix. Her
// arrival, goal, toughness and reward are in ../queen.test.ts.
import { describe, expect, test } from "bun:test";
import { DT, MAX_BUGS_PER_ARENA, WAVE_S } from "../constants";
import { createArena, joinPlayer, stepArena, type ArenaState, type Bug } from "../sim";
import { arenaWith, placeBug, stepQuiet } from "../testkit";
import { GLOB_SPEED } from "./glob";
import { BROOD_CAP, BROOD_COUNT, BROOD_TICKS, DRIFT, DRIFT_TICKS, GOAL_NEAR, QUEEN_RADIUS, QUEEN_SPEED, RING_COUNT, RING_TURN, TELL, TELL_TICKS } from "./queen";

/** A queen at (x, y), as her arrival leaves her (queen.ts stepQueen), with her goal where she stands. */
function placeQueen(a: ArenaState, x: number, y: number): Bug {
  const q = placeBug(a, x, y, "queen");
  q.hp = 1000;
  q.dx = 1;
  q.dy = 0;
  q.travel = BROOD_TICKS;
  q.gx = x;
  q.gy = y;
  return q;
}

/** Players far away and untouchable, so nothing interferes. */
function quietArena(): ArenaState {
  const { a, ps } = arenaWith([100, 100]);
  ps[0]!.invulnTicks = 1e9;
  return a;
}

const angleOf = (b: Bug) => Math.atan2(b.dy, b.dx);
const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));

describe("drift", () => {
  test("she moves toward her goal at her speed and stops GOAL_NEAR short of it", () => {
    const a = quietArena();
    const q = placeQueen(a, 1000, 1200);
    q.gx = 1600;
    q.gy = 1200;
    stepQuiet(a);
    expect(q.x).toBeCloseTo(1000 + QUEEN_SPEED * DT, 9);
    expect(q.vx).toBeCloseTo(QUEEN_SPEED, 9);
    for (let i = 0; i < 400; i++) {
      q.gx = 1600;
      q.gy = 1200;
      stepQuiet(a);
    }
    // The ticks queen.ts writes her goal are skipped here (stage 0): she stops short and stays.
    expect(q.x).toBeCloseTo(1600 - GOAL_NEAR, 6);
  });

  test("she stands still during her tell", () => {
    const a = quietArena();
    const q = placeQueen(a, 1000, 1200);
    q.gx = 2000;
    stepQuiet(a, DRIFT_TICKS);
    expect(q.phase).toBe(TELL);
    const x = q.x;
    for (let i = 0; i < TELL_TICKS - 1; i++) {
      q.gx = 2000;
      stepQuiet(a);
      expect([q.x, q.vx, q.phase]).toEqual([x, 0, TELL]);
    }
  });
});

describe("brood", () => {
  test("BROOD_COUNT crawlers evenly round her edge, every BROOD_TICKS", () => {
    const a = quietArena();
    const q = placeQueen(a, 1200, 1200);
    const crawlers = () => a.bugs.filter((b) => b.kind === "crawler");
    stepQuiet(a, BROOD_TICKS - 1);
    expect(crawlers()).toHaveLength(0);
    stepQuiet(a);
    const brood = crawlers();
    expect(brood).toHaveLength(BROOD_COUNT);
    for (let i = 0; i < BROOD_COUNT; i++) {
      // Launched this step and not yet stepped: at her edge, 120 degrees apart, standing.
      expect(Math.hypot(brood[i]!.x - q.x, brood[i]!.y - q.y)).toBeCloseTo(QUEEN_RADIUS + 12, 6);
      expect(wrap(angleOf(brood[i]!) - angleOf(brood[0]!) - (i * 2 * Math.PI) / BROOD_COUNT)).toBeCloseTo(0, 9);
      expect(Math.hypot(brood[i]!.vx, brood[i]!.vy)).toBe(0);
    }
    for (const b of a.bugs) if (b !== q) b.hp = 0;
    stepQuiet(a);
    a.bugs = a.bugs.filter((b) => b.hp > 0);
    stepQuiet(a, BROOD_TICKS - 2);
    expect(crawlers()).toHaveLength(0);
    stepQuiet(a);
    expect(crawlers()).toHaveLength(BROOD_COUNT);
  });

  test("the brood stops while the arena holds BROOD_CAP bugs, but a ring still launches up to the arena's cap", () => {
    const a = quietArena();
    const q = placeQueen(a, 1200, 1200);
    while (a.bugs.length < BROOD_CAP) placeBug(a, 2300, 2300, "spitter").phase = 0;
    // Spitters stand far off, and none tells with nobody near.
    q.travel = 1;
    stepQuiet(a);
    expect(a.bugs.filter((b) => b.kind === "crawler")).toHaveLength(0);
    expect(a.bugs).toHaveLength(BROOD_CAP);
    q.phase = TELL;
    q.phaseTicks = TELL_TICKS - 1;
    stepQuiet(a);
    expect(a.bugs.filter((b) => b.kind === "glob")).toHaveLength(RING_COUNT);
    expect(a.bugs.length).toBe(MAX_BUGS_PER_ARENA);
  });
});

describe("tell and ring", () => {
  test("after DRIFT_TICKS she tells for TELL_TICKS, then fires RING_COUNT globs evenly round, each ring turned RING_TURN from the last", () => {
    const a = quietArena();
    const q = placeQueen(a, 1200, 1200);
    q.travel = 1e9;
    stepQuiet(a, DRIFT_TICKS - 1);
    expect(q.phase).toBe(DRIFT);
    stepQuiet(a);
    expect(q.phase).toBe(TELL);
    stepQuiet(a, TELL_TICKS - 1);
    expect(a.bugs.filter((b) => b.kind === "glob")).toHaveLength(0);
    stepQuiet(a);
    const ring = a.bugs.filter((b) => b.kind === "glob");
    expect(ring).toHaveLength(RING_COUNT);
    expect(q.phase).toBe(DRIFT);
    expect(angleOf(ring[0]!)).toBeCloseTo(RING_TURN, 9);
    for (let i = 0; i < RING_COUNT; i++) {
      expect(wrap(angleOf(ring[i]!) - RING_TURN - (i * 2 * Math.PI) / RING_COUNT)).toBeCloseTo(0, 9);
      expect(Math.hypot(ring[i]!.vx, ring[i]!.vy)).toBeCloseTo(GLOB_SPEED, 9);
    }
    // The next ring, 6 s on, is turned once more.
    for (const g of ring) g.hp = 0;
    stepQuiet(a);
    a.bugs = a.bugs.filter((b) => b.hp > 0);
    stepQuiet(a, DRIFT_TICKS + TELL_TICKS - 1);
    const next = a.bugs.filter((b) => b.kind === "glob");
    expect(next).toHaveLength(RING_COUNT);
    expect(angleOf(next[0]!)).toBeCloseTo(2 * RING_TURN, 9);
  });

  test("a brood due on a ring's tick waits one tick", () => {
    const a = quietArena();
    const q = placeQueen(a, 1200, 1200);
    q.phase = TELL;
    q.phaseTicks = TELL_TICKS - 1;
    q.travel = 1;
    stepQuiet(a);
    expect(a.bugs.filter((b) => b.kind === "glob")).toHaveLength(RING_COUNT);
    expect(a.bugs.filter((b) => b.kind === "crawler")).toHaveLength(0);
    stepQuiet(a);
    expect(a.bugs.filter((b) => b.kind === "crawler")).toHaveLength(BROOD_COUNT);
  });
});

describe("the spawn mix", () => {
  test("never makes a queen", () => {
    const a = createArena(11);
    a.tick = Math.round((12 * WAVE_S) / DT);
    joinPlayer(a, "a", "tabs").lifeStartTick = a.tick - Math.round(300 / DT);
    for (let t = 0; t < 30 / DT; t++) {
      for (const p of a.players) p.invulnTicks = 1e9;
      const before = a.nextBugId;
      stepArena(a);
      expect(a.bugs.some((b) => b.kind === "queen" && b.id >= before && b.id !== a.queen.bugId)).toBe(false);
      a.bugs = a.bugs.filter((b) => b.kind === "queen");
    }
  });
});
