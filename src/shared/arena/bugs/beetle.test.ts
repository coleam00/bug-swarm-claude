// The beetle (#80), by stepping the arena with hand-placed players and bugs: it turns slowly toward
// its target and walks only where it faces, its shell blocks shots from the front and not from the
// side or behind, two players from two sides kill it, and its spawn rules, contact and kill.
import { describe, expect, test } from "bun:test";
import { mult } from "../combat";
import { DT, SHOT_RADIUS, WAVE_S } from "../constants";
import { createArena, joinPlayer, stepArena, type ArenaState, type Bug, type Player, type ShotEnded } from "../sim";
import { arenaWith, hold, placeBug, placePickup, stepQuiet } from "../testkit";
import { BEETLE_FROM_S, BEETLE_SHARE_MAX, NEW, WALK, beetleShare } from "./beetle";
import { bugDef } from "./registry";

const BEETLE = "beetle" as const;

/** The item's numbers, written out so a test fails if a constant drifts from them. */
const ITEM_HP = 8;
const ITEM_POINTS = 60;
const ITEM_UNLOCK_WAVE = 4;
/** The starting numbers this item settled on (architecture.md "Built so far (#80)"). */
const TURN_RATE = 0.9;
const SPEED = 80;
const CAP = 3;

/** A beetle at (x, y) already walking, facing the unit (dx, dy). */
function beetleAt(a: ArenaState, x: number, y: number, dx: number, dy: number): Bug {
  const b = placeBug(a, x, y, BEETLE);
  b.phase = WALK;
  b.dx = dx;
  b.dy = dy;
  return b;
}

const facing = (b: Bug) => Math.atan2(b.dy, b.dx);

/**
 * `p` fires `shots` shots at beetle `b`, which is held where it is and facing (fx, fy) before
 * every step (its own step still turns it one tick toward its target before the shots fly);
 * steps until every shot has ended. Returns the shots' ends.
 */
function shootHeld(a: ArenaState, p: Player, b: Bug, fx: number, fy: number, shots = ITEM_HP): ShotEnded[] {
  const x = b.x;
  const y = b.y;
  const ended: ShotEnded[] = [];
  let fired = 0;
  for (let t = 0; t < 200 && (fired < shots || a.shots.length > 0); t++) {
    hold(p, { aim: Math.atan2(y - p.y, x - p.x), fire: fired < shots });
    b.x = x;
    b.y = y;
    b.dx = fx;
    b.dy = fy;
    stepQuiet(a);
    fired += a.events.shotsFired.length;
    ended.push(...a.events.shotsEnded);
    if (p.lockTicks > 0) throw new Error("the gun locked");
  }
  expect(fired).toBe(shots);
  return ended;
}

describe("beetle turning and walking", () => {
  test("its first step faces it at its target and starts it walking", () => {
    const { a } = arenaWith([1200, 1200]);
    const b = placeBug(a, 1200, 1500, BEETLE);
    expect(b.phase).toBe(NEW);
    stepQuiet(a);
    expect(b.phase).toBe(WALK);
    expect(b.dx).toBeCloseTo(0, 9);
    expect(b.dy).toBeCloseTo(-1, 9);
    // It never counts ticks in its phase, so its row's ticksIn stays 0.
    stepQuiet(a, 10);
    expect(b.phaseTicks).toBe(0);
  });

  test(`it turns toward a target 90 degrees off at ${TURN_RATE} rad/s, no faster`, () => {
    const { a } = arenaWith([1500, 1200]);
    // Facing up (-y), its target to its right (+x), 300 units away.
    const b = beetleAt(a, 1200, 1200, 0, -1);
    stepQuiet(a, Math.round(1 / DT));
    expect(facing(b) - -Math.PI / 2).toBeCloseTo(TURN_RATE, 6);
    // Still short of facing its target.
    const toTarget = Math.atan2(1200 - b.y, 1500 - b.x);
    expect(toTarget - facing(b)).toBeGreaterThan(0.4);
    expect(Math.hypot(b.dx, b.dy)).toBeCloseTo(1, 9);
  });

  test(`with its target dead ahead it walks along its facing at ${SPEED} u/s`, () => {
    const { a } = arenaWith([1500, 1200]);
    const b = beetleAt(a, 1000, 1200, 1, 0);
    stepQuiet(a, 10);
    expect(b.x).toBeCloseTo(1000 + SPEED * 10 * DT, 6);
    expect(b.y).toBeCloseTo(1200, 9);
    expect(b.vx).toBeCloseTo(SPEED, 6);
  });

  test("with its target behind it, it stands and turns; it walks again once it faces them", () => {
    const { a } = arenaWith([1500, 1200]);
    const b = beetleAt(a, 1000, 1200, -1, 0);
    // In 1 s it turns 0.9 rad of the 3.14: its target is still more than 90 degrees off.
    stepQuiet(a, Math.round(1 / DT));
    expect(b.x).toBe(1000);
    expect(b.y).toBe(1200);
    // After 3 s it has turned more than 90 degrees and is moving toward them.
    stepQuiet(a, Math.round(2 / DT));
    expect(b.x).toBeGreaterThan(1000);
  });

  test("with no one up it stands, keeping its facing", () => {
    const a = createArena(1);
    const b = beetleAt(a, 1000, 1200, 0, 1);
    stepQuiet(a, 20);
    expect([b.x, b.y, b.dx, b.dy]).toEqual([1000, 1200, 0, 1]);
  });
});

describe("beetle shell", () => {
  test(`${ITEM_HP} shots at its shell do no damage, every one blocked; the streak grows, nothing scores`, () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const b = beetleAt(a, 1400, 1200, -1, 0);
    let blocks = 0;
    const ended: ShotEnded[] = [];
    // Counting the blocks event by event as it goes.
    const x = b.x;
    let fired = 0;
    for (let t = 0; t < 200 && (fired < ITEM_HP || a.shots.length > 0); t++) {
      hold(p, { aim: 0, fire: fired < ITEM_HP });
      b.x = x;
      stepQuiet(a);
      fired += a.events.shotsFired.length;
      ended.push(...a.events.shotsEnded);
      blocks += a.events.shellBlocks.filter((o) => o === p.id).length;
    }
    expect(ended.length).toBe(ITEM_HP);
    expect(ended.every((e) => e.hit && e.blocked)).toBe(true);
    expect(blocks).toBe(ITEM_HP);
    expect(b.hp).toBe(ITEM_HP);
    expect(a.bugs).toContain(b);
    expect([p.streak, p.score, p.kills]).toEqual([ITEM_HP, 0, 0]);
  });

  for (const [name, fx, fy] of [
    ["from its side", 0, 1],
    ["from behind", 1, 0],
  ] as const) {
    test(`${ITEM_HP} shots ${name} kill it, scoring ${ITEM_POINTS} times the streak multiplier`, () => {
      const { a, ps } = arenaWith([1200, 1200]);
      const p = ps[0]!;
      const b = beetleAt(a, 1400, 1200, fx, fy);
      const ended = shootHeld(a, p, b, fx, fy);
      expect(ended.filter((e) => e.blocked)).toEqual([]);
      expect(a.bugs).not.toContain(b);
      expect([p.kills, p.streak, p.score]).toEqual([1, ITEM_HP, ITEM_POINTS * mult(ITEM_HP)]);
    });
  }

  /**
   * One shot of `p`'s flying along +x or -x past beetle `b`, `off` units to the side of its centre,
   * starting 40 units from it (no spread); one step; returns how it ended (null: still flying).
   */
  function grazing(a: ArenaState, p: Player, b: Bug, from: 1 | -1, off: number): ShotEnded | null {
    a.shots.push({ id: a.nextShotId++, owner: p.id, life: p.lifeStartTick, x: b.x - from * 40, y: b.y + off, dx: from, dy: 0, travelled: 0, pierce: 1, laser: false, hitA: 0, hitB: 0, hits: 0 });
    stepQuiet(a);
    return a.events.shotsEnded[0] ?? null;
  }

  test("the shell blocks at the edge of the circle shots meet (its radius plus SHOT_RADIUS), as it is drawn", () => {
    const edge = bugDef(BEETLE).radius + SHOT_RADIUS;
    // From the front, 2 units inside the edge: blocked; 2 outside: it flies on.
    for (const [off, blocked] of [
      [edge - 2, true],
      [edge + 2, false],
    ] as const) {
      const { a, ps } = arenaWith([1200, 1200]);
      const b = beetleAt(a, 1300, 1200, -1, 0);
      const end = grazing(a, ps[0]!, b, 1, off);
      expect(end?.blocked ?? false).toBe(blocked);
      expect(b.hp).toBe(ITEM_HP);
    }
    // From behind, 2 units inside the edge: it hurts.
    const { a, ps } = arenaWith([1200, 1200]);
    const b = beetleAt(a, 1300, 1200, -1, 0);
    const end = grazing(a, ps[0]!, b, -1, edge - 2);
    expect(end).toEqual(expect.objectContaining({ hit: true, blocked: false }));
    expect(b.hp).toBe(ITEM_HP - 1);
  });

  test("a review laser shot stops on the shell: the bug it pierced first stays hit, the beetle is not", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    placePickup(a, 1200, 1200, "laser");
    stepQuiet(a);
    const crawler = placeBug(a, 1300, 1200);
    const b = beetleAt(a, 1450, 1200, -1, 0);
    hold(p, { aim: 0, fire: true });
    stepQuiet(a);
    hold(p, {});
    const ended: ShotEnded[] = [...a.events.shotsEnded];
    let laserHits = a.events.laserHits.length;
    for (let i = 0; i < 30 && ended.length === 0; i++) {
      b.x = 1450;
      stepQuiet(a);
      ended.push(...a.events.shotsEnded);
      laserHits += a.events.laserHits.length;
    }
    expect(a.bugs).not.toContain(crawler);
    expect(b.hp).toBe(ITEM_HP);
    expect(laserHits).toBe(1);
    expect(ended).toEqual([expect.objectContaining({ hit: true, blocked: true })]);
    // It ended at the beetle, not flying on to its range.
    expect(ended[0]!.travelled).toBeLessThan(1450 - 1200);
    expect(a.shots).toEqual([]);
  });

  test("two players, one at its front and one behind it, both firing: the one behind kills it, the front one's hits are all blocked", () => {
    // It turns toward the nearer one, in front, and walks at them; the other shoots its back.
    const { a, ps } = arenaWith([1250, 1200], [1650, 1200]);
    const [front, back] = [ps[0]!, ps[1]!];
    front.invulnTicks = 1e9;
    const b = placeBug(a, 1400, 1200, BEETLE);
    const ended: ShotEnded[] = [];
    const frontShots = new Set<number>();
    let t = 0;
    for (; t < 100 && a.bugs.includes(b); t++) {
      hold(front, { aim: Math.atan2(b.y - front.y, b.x - front.x), fire: front.heat < 0.7 });
      hold(back, { aim: Math.atan2(b.y - back.y, b.x - back.x), fire: back.heat < 0.7 });
      stepQuiet(a);
      for (const s of a.events.shotsFired) if (s.owner === front.id) frontShots.add(s.id);
      ended.push(...a.events.shotsEnded);
    }
    expect(a.bugs).not.toContain(b);
    // Fast: inside 2 s.
    expect(t * DT).toBeLessThan(2);
    expect(back.kills).toBe(1);
    expect(front.kills).toBe(0);
    expect(front.score).toBe(0);
    expect(front.streak).toBeGreaterThan(0);
    const frontHits = ended.filter((e) => frontShots.has(e.id) && e.hit);
    expect(frontHits.length).toBeGreaterThan(0);
    expect(frontHits.every((e) => e.blocked)).toBe(true);
    expect(ended.filter((e) => !frontShots.has(e.id) && e.blocked)).toEqual([]);
  });
});

describe("beetle spawns", () => {
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

  test(`waves 1 to ${ITEM_UNLOCK_WAVE - 1} spawn no beetle, however old the life`, () => {
    expect(bugDef(BEETLE).spawn.unlockWave).toBe(ITEM_UNLOCK_WAVE);
    const a = createArena(4);
    joinPlayer(a, "a", "tabs").lifeStartTick = -Math.round(200 / DT);
    let n = 0;
    let all = 0;
    stepSpawning(
      a,
      Math.round(((ITEM_UNLOCK_WAVE - 1) * WAVE_S - 1) / DT),
      (b) => {
        all++;
        if (b.kind === BEETLE) n++;
      },
      true,
    );
    expect(all).toBeGreaterThan(300);
    expect(n).toBe(0);
  });

  test(`no beetle spawns for a life under ${BEETLE_FROM_S} s of pressure age; then its share grows to its cap`, () => {
    expect(beetleShare(BEETLE_FROM_S - 0.1)).toBe(0);
    expect(beetleShare(BEETLE_FROM_S)).toBeCloseTo(0.05, 9);
    expect(beetleShare(1000)).toBe(BEETLE_SHARE_MAX);
    const a = createArena(5);
    a.tick = Math.round((5 * WAVE_S) / DT);
    const p = joinPlayer(a, "a", "tabs");
    p.firstLife = false;
    p.lifeStartTick = a.tick;
    let young = 0;
    let all = 0;
    stepSpawning(
      a,
      Math.round((BEETLE_FROM_S - 1) / DT),
      (b) => {
        all++;
        if (b.kind === BEETLE) young++;
      },
      true,
    );
    expect(all).toBeGreaterThan(50);
    expect(young).toBe(0);
    let old = 0;
    all = 0;
    p.lifeStartTick = a.tick - Math.round(300 / DT);
    stepSpawning(
      a,
      Math.round(60 / DT),
      (b) => {
        all++;
        if (b.kind !== BEETLE) return;
        old++;
        expect(b.hp).toBe(ITEM_HP);
      },
      true,
    );
    expect(all).toBeGreaterThan(400);
    expect(Math.abs(old / all - BEETLE_SHARE_MAX)).toBeLessThan(0.05);
  });

  test(`an arena never holds more than ${CAP} beetles`, () => {
    const a = createArena(7);
    a.tick = Math.round((5 * WAVE_S) / DT);
    for (let i = 0; i < 20; i++) joinPlayer(a, `p${i}`, "tabs").lifeStartTick = a.tick - Math.round(300 / DT);
    let most = 0;
    for (let t = 0; t < 20 / DT; t++) {
      stepSpawning(a, 1, () => {});
      most = Math.max(most, a.bugs.filter((b) => b.kind === BEETLE).length);
    }
    expect(most).toBe(CAP);
  });
});
