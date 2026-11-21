import { describe, expect, test } from "bun:test";
import { BARREL, DT, HEAT_LOCK_S, HITS_PER_LIFE, KILL_POINTS, SHOT_RANGE, SHOT_SPEED, SHOT_SPREAD } from "./constants";
import { mult, segmentHit, shotTravelAt } from "./combat";
import { leavePlayer } from "./sim";
import { arenaWith, hold, placeBug, stepQuiet } from "./testkit";

const PER_TICK = SHOT_SPEED * DT;

describe("shots", () => {
  test("a held fire shoots from the barrel along the aim, and a shot flies 45 units a tick", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    hold(p, { aim: 0.5, fire: true });
    stepQuiet(a);
    const fired = a.events.shotsFired[0]!;
    expect(fired.owner).toBe(p.id);
    expect(fired.x).toBeCloseTo(1200 + Math.cos(0.5) * BARREL, 9);
    expect(fired.y).toBeCloseTo(1200 + Math.sin(0.5) * BARREL, 9);
    expect(Math.abs(fired.angle - 0.5)).toBeLessThanOrEqual(SHOT_SPREAD);
    const s = a.shots[0]!;
    expect(s.travelled).toBe(PER_TICK);
    expect(s.x).toBeCloseTo(fired.x + Math.cos(fired.angle) * PER_TICK, 9);
    hold(p, { aim: 0.5 });
    stepQuiet(a);
    expect(a.shots[0]!.travelled).toBe(2 * PER_TICK);
    expect(shotTravelAt(1, 1)).toBe(PER_TICK);
    expect(shotTravelAt(1, 2)).toBe(2 * PER_TICK);
    expect(shotTravelAt(1, 100)).toBe(SHOT_RANGE);
  });

  test("a shot hits the nearer of two bugs in its line, which dies and scores; the farther lives", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const near = placeBug(a, 1300, 1200);
    const far = placeBug(a, 1340, 1200);
    hold(p, { fire: true });
    stepQuiet(a);
    hold(p, {});
    let ended = a.events.shotsEnded.slice();
    for (let i = 0; i < 5 && ended.length === 0; i++) {
      stepQuiet(a);
      ended = a.events.shotsEnded.slice();
    }
    expect(ended).toMatchObject([{ id: 1, hit: true }]);
    // It ends where it met the bug's edge, not at the end of its step.
    expect(ended[0]!.travelled).toBeLessThan(PER_TICK * 2);
    expect(a.events.kills).toEqual([expect.objectContaining({ bug: near.id, by: p.id, points: KILL_POINTS })]);
    expect(a.bugs.map((b) => b.id)).toEqual([far.id]);
    expect([p.score, p.kills, p.streak]).toEqual([KILL_POINTS, 1, 1]);
  });

  test("a bug already over the barrel is hit at once (the swept test counts a start inside)", () => {
    expect(segmentHit(0, 0, 1, 0, 45, 5, 0, 15)).toBe(0);
    expect(segmentHit(0, 0, 1, 0, 45, 50, 0, 15)).toBeCloseTo(35, 9);
    expect(segmentHit(0, 0, 1, 0, 45, 70, 0, 15)).toBe(-1);
    expect(segmentHit(0, 0, 1, 0, 45, -30, 0, 15)).toBe(-1);
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.invulnTicks = 100;
    placeBug(a, 1200 + BARREL + 14, 1200);
    hold(p, { fire: true });
    stepQuiet(a);
    expect(a.events.shotsEnded).toEqual([{ id: 1, hit: true, travelled: 0 }]);
    expect(a.bugs).toEqual([]);
  });

  test("a shot that reaches its range is a miss, and a miss resets the streak", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.streak = 7;
    hold(p, { fire: true });
    stepQuiet(a);
    hold(p, {});
    const ticks = Math.ceil(SHOT_RANGE / PER_TICK);
    // The firing step was the first of `ticks`; the last one ends it.
    for (let i = 2; i < ticks; i++) {
      stepQuiet(a);
      expect(a.events.shotsEnded).toEqual([]);
    }
    expect(p.streak).toBe(7);
    stepQuiet(a);
    expect(a.events.shotsEnded).toEqual([{ id: 1, hit: false, travelled: SHOT_RANGE }]);
    expect(a.shots).toEqual([]);
    expect(p.streak).toBe(0);
  });

  test("a shot never hits a player (no friendly fire)", () => {
    const { a, ps } = arenaWith([1000, 1200], [1100, 1200]);
    const [p1, p2] = [ps[0]!, ps[1]!];
    hold(p1, { fire: true });
    let ended = 0;
    for (let i = 0; i < 60; i++) {
      stepQuiet(a);
      for (const e of a.events.shotsEnded) {
        expect(e.hit).toBe(false);
        ended++;
      }
    }
    expect(ended).toBeGreaterThan(0);
    expect([p2.hits, p2.alive, p1.hits]).toEqual([0, true, 0]);
  });

  test("a shot that reaches a wall ends there as a miss", () => {
    const { a, ps } = arenaWith([2300, 1200]);
    const p = ps[0]!;
    p.streak = 3;
    hold(p, { fire: true });
    stepQuiet(a);
    hold(p, {});
    // 2320 at the barrel, 2365 after the firing step, past the wall at 2400 on the next.
    stepQuiet(a);
    expect(a.events.shotsEnded).toMatchObject([{ id: 1, hit: false }]);
    expect(a.events.shotsEnded[0]!.travelled).toBeLessThan(SHOT_RANGE);
    expect(p.streak).toBe(0);
  });

  test("a shot whose owner left flies on: its kill scores nothing for anyone", () => {
    const { a, ps } = arenaWith([1200, 1200], [2200, 1200]);
    const [p1, p2] = [ps[0]!, ps[1]!];
    placeBug(a, 1400, 1200);
    hold(p1, { fire: true });
    stepQuiet(a);
    leavePlayer(a, p1.id);
    stepQuiet(a, 4);
    expect(a.bugs).toEqual([]);
    expect(p2.score).toBe(0);
  });

  test("a shot in flight when its owner's life ends scores nothing (the life is saved as it ended)", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    placeBug(a, 1500, 1200);
    hold(p, { fire: true });
    stepQuiet(a);
    hold(p, {});
    // The life ends on the next tick, with the shot still flying at the bug.
    p.hits = HITS_PER_LIFE - 1;
    placeBug(a, 1180, 1200);
    stepQuiet(a);
    expect(a.events.livesEnded).toEqual([{ id: p.id, score: 0, kills: 0, ticks: 1 }]);
    let kill = null;
    for (let i = 0; i < 20 && !kill; i++) {
      stepQuiet(a);
      kill = a.events.kills[0] ?? null;
    }
    expect(kill).toMatchObject({ by: 0, points: 0 });
    expect([p.score, p.kills, p.streak]).toEqual([0, 0, 0]);
  });
});

describe("heat", () => {
  test("a held trigger locks after about 2.5 s, then cannot fire for HEAT_LOCK_S", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    hold(p, { fire: true });
    let t = 0;
    while (p.lockTicks === 0) {
      stepQuiet(a);
      t++;
    }
    expect(t * DT).toBeGreaterThanOrEqual(2.3);
    expect(t * DT).toBeLessThanOrEqual(2.7);
    expect(p.heat).toBe(1);
    const lock = Math.round(HEAT_LOCK_S / DT);
    for (let i = 0; i < lock; i++) {
      stepQuiet(a);
      expect(a.events.shotsFired).toEqual([]);
    }
    expect(p.heat).toBe(0);
    stepQuiet(a);
    expect(a.events.shotsFired.length).toBe(1);
  });

  test("bursts of 0.5 s on and 0.5 s off for 60 s never lock", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    let shots = 0;
    for (let t = 0; t < 60 / DT; t++) {
      hold(p, { fire: t % 20 < 10 });
      stepQuiet(a);
      shots += a.events.shotsFired.length;
      expect(p.lockTicks).toBe(0);
    }
    expect(shots).toBeGreaterThan(150);
  });

  test("tapping fire faster than the gun cools still overheats it", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    let locked = false;
    for (let t = 0; t < 10 / DT && !locked; t++) {
      hold(p, { fire: t % 3 === 0 });
      stepQuiet(a);
      locked = p.lockTicks > 0;
    }
    expect(locked).toBe(true);
  });

  test("heat cools only while fire is released", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    hold(p, { fire: true });
    stepQuiet(a, 10);
    const hot = p.heat;
    expect(hot).toBeGreaterThan(0);
    hold(p, {});
    stepQuiet(a, 5);
    expect(p.heat).toBeLessThan(hot);
  });
});

describe("streak", () => {
  test("the multiplier steps at 5, 10 and 20 hits in a row", () => {
    expect([0, 1, 4, 5, 9, 10, 19, 20, 99].map(mult)).toEqual([1, 1, 1, 1.5, 1.5, 2, 2, 3, 3]);
  });

  test("a kill scores 10, 15, 20 and 30 on the 1st, 5th, 10th and 20th hit in a row", () => {
    for (const [before, points] of [
      [0, 10],
      [4, 15],
      [9, 20],
      [19, 30],
    ] as const) {
      const { a, ps } = arenaWith([1200, 1200]);
      const p = ps[0]!;
      p.streak = before;
      placeBug(a, 1290, 1200);
      hold(p, { fire: true });
      stepQuiet(a);
      hold(p, {});
      stepQuiet(a, 3);
      expect([p.score, p.streak]).toEqual([points, before + 1]);
    }
  });
});
