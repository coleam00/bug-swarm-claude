// The dash (#60), stepped on the pure arena: distance, direction, the edge, the cooldown, the
// untouchable window, walls and the spawn lock.
import { describe, expect, test } from "bun:test";
import {
  DASH_COOLDOWN_TICKS,
  DASH_DISTANCE,
  DASH_SPAWN_LOCK_TICKS,
  DASH_TICKS,
  DT,
  HITS_PER_LIFE,
  MAX_SPEED,
  PLAYER_RADIUS,
  WORLD_W,
} from "./constants";
import { canBeHit, clampInput, createArena, joinPlayer, stepArena } from "./sim";
import { arenaWith, hold, placeBug, stepQuiet } from "./testkit";

const at = (x = 1200, y = 1200) => {
  const { a, ps } = arenaWith([x, y]);
  return { a, p: ps[0]! };
};
const speed = (p: { vx: number; vy: number }) => Math.hypot(p.vx, p.vy);

describe("dash", () => {
  test("the numbers: 220 units over 3 ticks, a 30-tick cooldown, a 10-tick spawn lock", () => {
    expect([DASH_DISTANCE, DASH_TICKS, DASH_COOLDOWN_TICKS, DASH_SPAWN_LOCK_TICKS]).toEqual([220, 3, 30, 10]);
  });

  test("a press from rest carries DASH_DISTANCE over DASH_TICKS steps along the move, then the speed is back under MAX_SPEED", () => {
    const { a, p } = at();
    hold(p, { mx: 1, dash: true });
    stepQuiet(a, DASH_TICKS);
    expect(p.x - 1200).toBeCloseTo(DASH_DISTANCE, 9);
    expect(p.y).toBe(1200);
    stepQuiet(a);
    expect(p.dashTicks).toBe(0);
    expect(speed(p)).toBeLessThanOrEqual(MAX_SPEED);
    expect(p.x - 1200).toBeLessThanOrEqual(DASH_DISTANCE + MAX_SPEED * DT + 1e-9);
  });

  test("standing still, it goes along the aim", () => {
    const { a, p } = at();
    hold(p, { aim: Math.PI / 2, dash: true });
    stepQuiet(a, DASH_TICKS);
    expect(p.x).toBeCloseTo(1200, 9);
    expect(p.y - 1200).toBeCloseTo(DASH_DISTANCE, 9);
  });

  test("a half-pushed stick still dashes the full distance", () => {
    const { a, p } = at();
    hold(p, { mx: 0.5, dash: true });
    stepQuiet(a, DASH_TICKS);
    expect(p.x - 1200).toBeCloseTo(DASH_DISTANCE, 9);
  });

  test("it is edge-triggered: held, it dashes once; released and pressed again after the cooldown, it dashes again", () => {
    const { a, p } = at(600, 1200);
    let dashes = 0;
    for (let t = 0; t < 40; t++) {
      hold(p, { mx: 1, dash: true });
      stepQuiet(a);
      if (p.dashTicks === DASH_TICKS) dashes++;
    }
    expect(dashes).toBe(1);
    hold(p, { mx: 1 });
    stepQuiet(a);
    hold(p, { mx: 1, dash: true });
    stepQuiet(a);
    expect(p.dashTicks).toBe(DASH_TICKS);
  });

  test("the cooldown: a press DASH_COOLDOWN_TICKS - 1 ticks after the last is dropped, one at DASH_COOLDOWN_TICKS dashes", () => {
    const pressAfter = (gap: number) => {
      const { a, p } = at(400, 1200);
      hold(p, { mx: 1, dash: true });
      stepQuiet(a);
      for (let t = 1; t < gap; t++) {
        hold(p, { mx: 1 });
        stepQuiet(a);
      }
      hold(p, { mx: 1, dash: true });
      stepQuiet(a);
      return p;
    };
    const early = pressAfter(DASH_COOLDOWN_TICKS - 1);
    expect(early.dashTicks).toBe(0);
    expect(speed(early)).toBeLessThanOrEqual(MAX_SPEED);
    // Dropped, not kept: it does not fire on its own once the cooldown runs out.
    const onTime = pressAfter(DASH_COOLDOWN_TICKS);
    expect(onTime.dashTicks).toBe(DASH_TICKS);
  });

  test("a dropped press is not kept for later", () => {
    const { a, p } = at(400, 1200);
    hold(p, { mx: 1, dash: true });
    stepQuiet(a);
    hold(p, { mx: 1 });
    stepQuiet(a, 5);
    hold(p, { mx: 1, dash: true });
    stepQuiet(a);
    hold(p, { mx: 1 });
    for (let t = 0; t < DASH_COOLDOWN_TICKS; t++) {
      stepQuiet(a);
      expect(p.dashTicks).toBe(0);
    }
  });

  test("a press during a dash is dropped and leaves the cooldown alone", () => {
    const { a, p } = at();
    hold(p, { mx: 1, dash: true });
    stepQuiet(a);
    hold(p, { mx: 1 });
    stepQuiet(a);
    hold(p, { my: 1, dash: true });
    stepQuiet(a);
    expect(p.dashTicks).toBe(1);
    expect(p.dashCooldown).toBe(DASH_COOLDOWN_TICKS - 2);
    expect(p.vy).toBe(0);
    expect(p.x - 1200).toBeCloseTo(DASH_DISTANCE, 9);
  });

  test("untouchable while dashing: it passes through bugs on its path, and a bug on it the tick after hits", () => {
    const { a, p } = at();
    for (let i = 1; i <= 5; i++) placeBug(a, 1200 + i * 40, 1200);
    hold(p, { mx: 1, dash: true });
    for (let t = 0; t < DASH_TICKS; t++) {
      stepQuiet(a);
      hold(p, { mx: 1 });
      expect(canBeHit(p)).toBe(false);
      expect(a.events.hitsTaken).toEqual([]);
    }
    expect(p.hits).toBe(0);
    expect(a.bugs.length).toBe(5);
    // The tick after the dash, a bug on the robot lands.
    a.bugs.length = 0;
    placeBug(a, p.x + 30, p.y);
    stepQuiet(a);
    expect(p.dashTicks).toBe(0);
    expect(a.events.hitsTaken).toEqual([p.id]);
  });

  test("the dash window is its own: it does not touch hit protection", () => {
    const { a, p } = at();
    hold(p, { mx: 1, dash: true });
    stepQuiet(a);
    expect(p.invulnTicks).toBe(0);
  });

  test("walls stop it: straight in, it ends at the wall; slanted, it slides along", () => {
    const { a, p } = at(WORLD_W - 100, 1200);
    hold(p, { mx: 1, dash: true });
    stepQuiet(a, DASH_TICKS);
    expect(p.x).toBe(WORLD_W - PLAYER_RADIUS);
    expect(p.vx).toBe(0);
    const s = at(WORLD_W - 30, 1200);
    hold(s.p, { mx: 1, my: 1, dash: true });
    stepQuiet(s.a, DASH_TICKS);
    expect(s.p.x).toBe(WORLD_W - PLAYER_RADIUS);
    expect(s.p.vx).toBe(0);
    expect(s.p.y - 1200).toBeCloseTo(DASH_DISTANCE * Math.SQRT1_2, 6);
  });

  test("the press that respawns you is not a dash, and a new life cannot dash for DASH_SPAWN_LOCK_TICKS", () => {
    const { a, p } = at();
    p.hits = HITS_PER_LIFE - 1;
    placeBug(a, 1210, 1200);
    stepQuiet(a);
    expect(p.alive).toBe(false);
    hold(p, { dash: true });
    while (!p.alive) stepQuiet(a);
    const born = a.tick;
    // Still held: no dash.
    stepQuiet(a, 2);
    expect(p.dashTicks).toBe(0);
    hold(p, {});
    stepQuiet(a);
    // A fresh press 3 ticks into the life: dropped.
    hold(p, { mx: 1, dash: true });
    stepQuiet(a);
    expect(a.tick - born).toBe(4);
    expect(p.dashTicks).toBe(0);
    hold(p, { mx: 1 });
    while (a.tick - born < DASH_SPAWN_LOCK_TICKS) stepQuiet(a);
    // The press on the 10th tick into the life dashes.
    hold(p, { mx: 1, dash: true });
    stepQuiet(a);
    expect(p.dashTicks).toBe(DASH_TICKS);
  });

  test("a new join cannot dash for DASH_SPAWN_LOCK_TICKS", () => {
    const a = createArena(3);
    const p = joinPlayer(a, "new", "tabs");
    for (let t = 1; t < DASH_SPAWN_LOCK_TICKS; t++) {
      p.input = clampInput({ seq: t, mx: 1, my: 0, aim: 0, fire: false, dash: t % 2 === 0 });
      stepArena(a);
      expect(p.dashTicks).toBe(0);
    }
    p.input = clampInput({ seq: 100, mx: 1, my: 0, aim: 0, fire: false, dash: true });
    stepArena(a);
    expect(p.dashTicks).toBe(DASH_TICKS);
  });
});
