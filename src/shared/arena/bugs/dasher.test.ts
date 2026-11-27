// The dasher (#65), by stepping the arena with hand-placed players and bugs: its phases, the
// sidestep and the dash that beat it, its spawn rules, and what it takes to kill.
import { describe, expect, test } from "bun:test";
import { BUG_KINDS, DT, MAX_BUGS_PER_ARENA, WAVE_S } from "../constants";
import { createArena, joinPlayer, stepArena, type ArenaState, type Bug, type Kill } from "../sim";
import { arenaWith, hold, placeBug, stepQuiet } from "../testkit";
import {
  APPROACH,
  APPROACH_SPEED,
  DASHER_MAX_PER_ARENA,
  DASHER_RADIUS,
  DASHER_SHARE_MAX,
  LUNGE,
  LUNGE_DIST,
  LUNGE_SPEED,
  RECOVER,
  RECOVER_TICKS,
  TELL,
  TELL_RANGE,
  TELL_TICKS,
  dasherShare,
} from "./dasher";
import { bugDef } from "./registry";

const DASHER = BUG_KINDS[1];

/** A player at (1200, 1200) and a dasher `gap` units to its right. */
function setup(gap: number) {
  const { a, ps } = arenaWith([1200, 1200]);
  const p = ps[0]!;
  const b = placeBug(a, 1200 + gap, 1200, DASHER);
  return { a, p, b };
}

/** Steps while the dasher is in `phase` (at most `max` steps), calling `each` after every step. */
function stepWhile(a: ArenaState, b: Bug, phase: number, each?: () => void, max = 200): void {
  for (let n = 0; b.phase === phase && n < max; n++) {
    stepQuiet(a);
    each?.();
  }
}

describe("dasher phases", () => {
  test("approach: it walks at APPROACH_SPEED, and tells on the first step it starts within TELL_RANGE", () => {
    const { a, b } = setup(TELL_RANGE + 2 * APPROACH_SPEED * DT - 1);
    stepQuiet(a);
    expect([b.phase, b.vx, b.vy]).toEqual([APPROACH, -APPROACH_SPEED, 0]);
    stepQuiet(a);
    expect(b.phase).toBe(APPROACH);
    expect(b.x - 1200).toBeLessThanOrEqual(TELL_RANGE);
    const x = b.x;
    stepQuiet(a);
    expect([b.phase, b.x, b.dx, b.dy]).toEqual([TELL, x, -1, 0]);
  });

  test("tell: it stands still for TELL_TICKS steps with its line locked where the target was, though the target moves", () => {
    const { a, p, b } = setup(300);
    stepQuiet(a); // tells
    expect(b.phase).toBe(TELL);
    hold(p, { my: 1 });
    let still = 1;
    while (b.phase === TELL) {
      stepQuiet(a);
      if (b.phase === TELL) {
        still++;
        expect([b.x, b.y, b.vx, b.vy, b.dx, b.dy]).toEqual([1500, 1200, 0, 0, -1, 0]);
      }
    }
    expect(still).toBe(TELL_TICKS);
    expect(p.y).toBeGreaterThan(1300);
    expect(b.phase).toBe(LUNGE);
    expect(b.x).toBe(1500 - LUNGE_SPEED * DT);
  });

  test("control: a target standing on the line takes the hit, and the dasher is spent", () => {
    const { a, p, b } = setup(300);
    let hit = false;
    for (let t = 0; t < 60 && !hit; t++) {
      stepQuiet(a);
      hit = a.events.touches.length > 0;
    }
    expect(a.events.touches).toEqual([{ player: p.id, kind: DASHER }]);
    expect(p.hits).toBe(1);
    expect(a.bugs).not.toContain(b);
  });

  test("sidestep: a target that moves 60 units off the line during the tell is missed, and the lunge runs its full 500", () => {
    const { a, p, b } = setup(300);
    stepQuiet(a); // tells
    const startX = b.x;
    stepWhile(a, b, TELL, () => hold(p, { my: p.y - 1200 < 60 ? 1 : 0 }));
    expect(p.y - 1200).toBeGreaterThanOrEqual(60);
    stepWhile(a, b, LUNGE);
    expect(b.phase).toBe(RECOVER);
    expect(p.hits).toBe(0);
    expect(a.bugs).toContain(b);
    expect(b.x).toBeCloseTo(startX - LUNGE_DIST, 9);
    expect(b.y).toBe(1200);
  });

  test("the lunge does not turn: with the target running across it, every step stays on the locked line", () => {
    const { a, p, b } = setup(300);
    stepWhile(a, b, APPROACH);
    stepWhile(a, b, TELL);
    // The first lunge step has been taken; the target now runs across the line.
    const x0 = b.x + LUNGE_SPEED * DT;
    let n = 1;
    hold(p, { my: 1 });
    stepWhile(a, b, LUNGE, () => {
      n++;
      if (b.phase !== LUNGE) return;
      expect(b.x).toBeCloseTo(x0 - n * LUNGE_SPEED * DT, 6);
      expect(b.y).toBe(1200);
      expect([b.vx, b.vy]).toEqual([-LUNGE_SPEED, 0]);
    });
    expect(p.hits).toBe(0);
    expect(b.y).toBe(1200);
    expect(b.x).toBeCloseTo(x0 - LUNGE_DIST, 6);
  });

  test("a slanted lunge into a wall ends on the step it reaches the wall: it does not run on along the wall", () => {
    const { a, ps } = arenaWith([100, 1200]);
    ps[0]!.invulnTicks = 1e9; // so the line passes through it to the wall
    const b = placeBug(a, 300, 1000, DASHER);
    stepWhile(a, b, APPROACH);
    const sx = b.x;
    const sy = b.y;
    stepWhile(a, b, TELL);
    const [dx, dy] = [b.dx, b.dy];
    expect(dx).toBeLessThan(0);
    expect(dy).toBeGreaterThan(0);
    // Units along the locked line until its edge meets the wall x = DASHER_RADIUS: short of a full lunge.
    const toWall = (DASHER_RADIUS - sx) / dx;
    expect(toWall).toBeLessThan(LUNGE_DIST);
    const step = LUNGE_SPEED * DT;
    let ticks = 1; // the tell's last step took the first lunge step
    stepWhile(a, b, LUNGE, () => ticks++);
    expect(b.phase).toBe(RECOVER);
    // It recovers on the step whose move reaches the wall, held at the wall...
    expect(ticks).toBe(Math.ceil(toWall / step));
    expect(b.x).toBe(DASHER_RADIUS);
    // ...having gone along the line no further than that one step's overshoot.
    const yAtWall = sy + dy * toWall;
    expect(b.y).toBeGreaterThanOrEqual(yAtWall - 1e-6);
    expect(b.y - yAtWall).toBeLessThan(step * dy);
    expect([b.vx, b.vy, b.travel]).toEqual([0, 0, 0]);
  });

  test("recover: it stands RECOVER_TICKS steps, then approaches again", () => {
    const { a, b } = setup(1000);
    b.phase = RECOVER;
    let still = 0;
    while (b.phase === RECOVER) {
      stepQuiet(a);
      if (b.phase === RECOVER) {
        still++;
        expect([b.x, b.vx]).toEqual([2200, 0]);
      }
    }
    expect(still).toBe(RECOVER_TICKS);
    expect(b.phase).toBe(APPROACH);
    expect(b.x).toBeCloseTo(2200 - APPROACH_SPEED * DT, 9);
  });
});

describe("dasher spawns", () => {
  /** Steps with every player untouchable; calls `onSpawn` for each new bug; `clear` empties the arena after each step. */
  function stepSpawning(a: ArenaState, ticks: number, onSpawn: (b: Bug) => void, clear = false): void {
    for (let t = 0; t < ticks; t++) {
      const before = a.nextBugId;
      for (const p of a.players) p.invulnTicks = 1e9;
      stepArena(a);
      for (const b of a.bugs) if (b.id >= before) onSpawn(b);
      if (clear) a.bugs.length = 0;
    }
  }

  test("wave 1 spawns no dasher, however old the life", () => {
    const a = createArena(4);
    joinPlayer(a, "a", "tabs").lifeStartTick = -Math.round(200 / DT);
    let n = 0;
    let all = 0;
    stepSpawning(
      a,
      Math.round((WAVE_S - 1) / DT),
      (b) => {
        all++;
        if (b.kind === DASHER) n++;
      },
      true,
    );
    expect(all).toBeGreaterThan(100);
    expect(n).toBe(0);
  });

  test("from wave 2, a life under 30 s old gets no dasher (a late joiner's opening matches an early one's)", () => {
    const a = createArena(5);
    a.tick = Math.round((3 * WAVE_S) / DT);
    joinPlayer(a, "a", "tabs");
    let n = 0;
    let all = 0;
    stepSpawning(a, Math.round(29 / DT), (b) => {
      all++;
      if (b.kind === DASHER) n++;
    });
    expect(all).toBeGreaterThan(5);
    expect(n).toBe(0);
  });

  test("its share grows with the life's age from 15% at 30 s to a 35% cap, and holds in play; each spawns with 2 hit points", () => {
    expect(dasherShare(29.9)).toBe(0);
    expect(dasherShare(30)).toBeCloseTo(0.15, 9);
    expect(dasherShare(50)).toBeCloseTo(0.25, 9);
    expect(dasherShare(70)).toBeCloseTo(DASHER_SHARE_MAX, 9);
    expect(dasherShare(1000)).toBe(DASHER_SHARE_MAX);
    const a = createArena(6);
    a.tick = Math.round((5 * WAVE_S) / DT);
    joinPlayer(a, "a", "tabs").lifeStartTick = a.tick - Math.round(120 / DT);
    let n = 0;
    let all = 0;
    stepSpawning(
      a,
      Math.round(60 / DT),
      (b) => {
        all++;
        if (b.kind !== DASHER) return;
        n++;
        // A spawned dasher takes 2 shots (the literal: the item's rule, not the definition's copy).
        expect(b.hp).toBe(2);
      },
      true,
    );
    expect(all).toBeGreaterThan(400);
    expect(Math.abs(n / all - DASHER_SHARE_MAX)).toBeLessThan(0.07);
  });

  test("an arena never holds more than its cap of dashers", () => {
    const a = createArena(7, Math.round((5 * WAVE_S) / DT));
    for (let i = 0; i < 20; i++) joinPlayer(a, `p${i}`, "tabs").lifeStartTick = a.tick - Math.round(300 / DT);
    let most = 0;
    for (let t = 0; t < 20 / DT; t++) {
      stepSpawning(a, 1, () => {});
      let n = 0;
      for (const b of a.bugs) if (b.kind === DASHER) n++;
      most = Math.max(most, n);
    }
    expect(a.bugs.length).toBe(MAX_BUGS_PER_ARENA);
    expect(most).toBe(DASHER_MAX_PER_ARENA);
  });
});

describe("dasher kills", () => {
  test("it takes 2 shots: the first grows the streak with no kill, the second kills for 25 (times the multiplier)", () => {
    expect(bugDef(DASHER).hp).toBe(2);
    expect(bugDef(DASHER).points).toBe(25);
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const b = placeBug(a, 1290, 1200, DASHER);
    const kills: Kill[] = [];
    let ended = 0;
    for (let t = 0; t < 40 && kills.length === 0; t++) {
      hold(p, { fire: t === 0 || t === 6 });
      b.phase = RECOVER; // stands still while it is shot
      b.phaseTicks = 0;
      stepQuiet(a);
      ended += a.events.shotsEnded.length;
      if (ended === 1 && kills.length === 0) expect([b.hp, p.streak, p.score, p.kills]).toEqual([1, 1, 0, 0]);
      kills.push(...a.events.kills);
    }
    expect(kills).toEqual([expect.objectContaining({ bug: b.id, by: p.id, points: 25, kind: DASHER })]);
    expect([p.kills, p.streak, p.score]).toEqual([1, 2, 25]);
  });
});
