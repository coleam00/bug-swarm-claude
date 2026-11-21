import { describe, expect, test } from "bun:test";
import { DT, HITS_PER_LIFE, INVULN_S, MAX_SPEED, PLAYER_RADIUS, RESPAWN_DELAY_S, SPAWN_MARGIN, WORLD_H, WORLD_W } from "./constants";
import { arenaWith, bleedNow, downNow, hold, placeBug, stepQuiet } from "./testkit";
import {
  clampInput,
  createArena,
  joinPlayer,
  leavePlayer,
  noInput,
  stepArena,
  stepPlayer,
  wrapAngle,
  type Input,
} from "./sim";

const input = (mx: number, my: number, aim = 0): Input => ({ seq: 1, mx, my, aim, fire: false, dash: false });

function body(x = 1200, y = 1200, vx = 0, vy = 0) {
  return { x, y, vx, vy };
}

describe("movement", () => {
  test("from rest, a held move reaches full speed in 3 steps and stays there", () => {
    const p = body();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      stepPlayer(p, 1, 0);
      seen.push(p.vx);
    }
    expect(seen).toEqual([120, 240, 300, 300, 300, 300]);
    expect(p.vy).toBe(0);
  });

  test("releasing stops in 4 steps, sliding 18 units", () => {
    const p = body(1000, 1000, MAX_SPEED, 0);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      stepPlayer(p, 0, 0);
      seen.push(p.vx);
    }
    expect(seen.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([210, 120, 30, 0, 0]);
    expect(p.x - 1000).toBeCloseTo(18, 9);
  });

  test("a full reversal takes 5 steps (0.25 s)", () => {
    const p = body(1000, 1000, MAX_SPEED, 0);
    let steps = 0;
    while (p.vx > -MAX_SPEED) {
      stepPlayer(p, -1, 0);
      steps++;
    }
    expect(steps).toBe(5);
  });

  test("a diagonal input is clamped to length 1, so speed caps at MAX_SPEED", () => {
    const i = clampInput(input(1, 1));
    expect(Math.hypot(i.mx, i.my)).toBeCloseTo(1, 12);
    const p = body();
    for (let n = 0; n < 10; n++) stepPlayer(p, i.mx, i.my);
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(MAX_SPEED, 9);
  });

  test("a short move is kept as it is (a half-pushed stick moves at half speed)", () => {
    const i = clampInput(input(0.5, 0));
    expect(i.mx).toBe(0.5);
    const p = body();
    for (let n = 0; n < 10; n++) stepPlayer(p, i.mx, i.my);
    expect(p.vx).toBe(MAX_SPEED / 2);
  });
});

describe("walls", () => {
  test("a wall stops the player at its radius and zeroes the velocity into it", () => {
    const p = body(PLAYER_RADIUS + 5, 1200, -MAX_SPEED, 0);
    stepPlayer(p, -1, 0);
    expect(p.x).toBe(PLAYER_RADIUS);
    expect(p.vx).toBe(0);
    for (let n = 0; n < 5; n++) stepPlayer(p, -1, 0);
    expect(p.x).toBe(PLAYER_RADIUS);
  });

  test("pushing into a wall diagonally slides along it", () => {
    const p = body(PLAYER_RADIUS, 1200);
    const i = clampInput(input(-1, 1));
    for (let n = 0; n < 10; n++) stepPlayer(p, i.mx, i.my);
    expect(p.x).toBe(PLAYER_RADIUS);
    expect(p.y).toBeGreaterThan(1250);
  });

  test("every wall holds", () => {
    const corners: [number, number, number, number][] = [
      [-1, -1, PLAYER_RADIUS, PLAYER_RADIUS],
      [1, -1, WORLD_W - PLAYER_RADIUS, PLAYER_RADIUS],
      [1, 1, WORLD_W - PLAYER_RADIUS, WORLD_H - PLAYER_RADIUS],
      [-1, 1, PLAYER_RADIUS, WORLD_H - PLAYER_RADIUS],
    ];
    for (const [mx, my, ex, ey] of corners) {
      const p = body();
      const i = clampInput(input(mx, my));
      for (let n = 0; n < 400; n++) stepPlayer(p, i.mx, i.my);
      expect([p.x, p.y]).toEqual([ex, ey]);
      expect([p.vx, p.vy]).toEqual([0, 0]);
    }
  });
});

describe("input clamping", () => {
  test("NaN and infinite values act as no input", () => {
    const i = clampInput(input(NaN, Infinity, NaN));
    expect([i.mx, i.my, i.aim]).toEqual([0, 0, 0]);
    const p = body();
    stepPlayer(p, i.mx, i.my);
    expect(p).toEqual(body());
  });

  test("aim wraps to (-pi, pi]", () => {
    expect(wrapAngle(0.5)).toBe(0.5);
    expect(wrapAngle(Math.PI)).toBe(Math.PI);
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(2 * Math.PI + 0.25)).toBeCloseTo(0.25, 12);
    expect(wrapAngle(-2 * Math.PI - 0.25)).toBeCloseTo(-0.25, 12);
    expect(clampInput(input(0, 0, 7)).aim).toBeCloseTo(7 - 2 * Math.PI, 12);
  });
});

describe("arena", () => {
  test("joins get distinct ids and spawn in bounds, the same for the same seed", () => {
    const a = createArena(42);
    const b = createArena(42);
    for (let i = 0; i < 20; i++) {
      joinPlayer(a, `p${i}`, i % 2 ? "tabs" : "spaces");
      joinPlayer(b, `p${i}`, i % 2 ? "tabs" : "spaces");
    }
    expect(new Set(a.players.map((p) => p.id)).size).toBe(20);
    for (const p of a.players) {
      expect(p.x).toBeGreaterThanOrEqual(SPAWN_MARGIN);
      expect(p.x).toBeLessThanOrEqual(WORLD_W - SPAWN_MARGIN);
      expect(p.y).toBeGreaterThanOrEqual(SPAWN_MARGIN);
      expect(p.y).toBeLessThanOrEqual(WORLD_H - SPAWN_MARGIN);
    }
    expect(a.players).toEqual(b.players);
    expect(createArena(43).players).toEqual([]);
    const c = createArena(43);
    joinPlayer(c, "p0", "spaces");
    expect(c.players[0]!.x).not.toBe(a.players[0]!.x);
  });

  test("leave removes only that player, and ids are never reused", () => {
    const a = createArena(1);
    const p1 = joinPlayer(a, "one", "tabs");
    const p2 = joinPlayer(a, "two", "spaces");
    expect(leavePlayer(a, p1.id)).toEqual({ life: { id: p1.id, score: 0, kills: 0, ticks: 0 } });
    expect(leavePlayer(a, p1.id)).toBeNull();
    expect(a.players.map((p) => p.id)).toEqual([p2.id]);
    expect(joinPlayer(a, "three", "tabs").id).toBe(3);
  });

  test("stepArena moves every player with its own input and counts the tick", () => {
    const a = createArena(7);
    const p1 = joinPlayer(a, "one", "tabs");
    const p2 = joinPlayer(a, "two", "spaces");
    const x1 = p1.x;
    const y2 = p2.y;
    p1.input = clampInput(input(1, 0, 1));
    p2.input = clampInput(input(0, -1, -2));
    stepArena(a);
    stepArena(a);
    expect(a.tick).toBe(2);
    expect(p1.x - x1).toBeCloseTo((120 + 240) * 0.05, 9);
    expect(y2 - p2.y).toBeCloseTo((120 + 240) * 0.05, 9);
    expect([p1.aim, p2.aim]).toEqual([1, -2]);
    expect(noInput().mx).toBe(0);
  });
});

describe("lives", () => {
  test("a bug touching you costs a hit and is gone; you are untouchable for INVULN_S; the life ends once", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.score = 40;
    p.kills = 4;
    p.streak = 6;
    placeBug(a, 1210, 1200);
    stepQuiet(a);
    expect(a.events.hitsTaken).toEqual([p.id]);
    expect([p.hits, a.bugs.length, p.streak]).toEqual([1, 0, 6]);
    // A second bug arriving inside the protection does nothing...
    placeBug(a, 1210, 1200);
    const protectedTicks = Math.round(INVULN_S / DT) - 1;
    for (let i = 0; i < protectedTicks; i++) {
      stepQuiet(a);
      expect(a.events.hitsTaken).toEqual([]);
      a.bugs[0]!.x = p.x + 10;
      a.bugs[0]!.y = p.y;
    }
    // ...and lands once it runs out.
    stepQuiet(a);
    expect(a.events.hitsTaken).toEqual([p.id]);
    p.invulnTicks = 0;
    placeBug(a, p.x + 10, p.y);
    stepQuiet(a);
    // The third hit puts you down (downs.test.ts); bleeding out ends the life once.
    expect(p.hits).toBe(HITS_PER_LIFE);
    bleedNow(a, p);
    expect(p.alive).toBe(false);
    expect(a.events.livesEnded).toEqual([{ id: p.id, score: 40, kills: 4, ticks: a.tick - 1 }]);
    placeBug(a, p.x, p.y);
    stepQuiet(a, 5);
    expect(a.events.livesEnded).toEqual([]);
    expect(p.hits).toBe(HITS_PER_LIFE);
  });

  test("an out player does not move or fire, and respawns on a dash press 0.8 s after going out, not before", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.hits = HITS_PER_LIFE - 1;
    p.score = 70;
    placeBug(a, 1210, 1200);
    stepQuiet(a);
    bleedNow(a, p);
    expect(p.alive).toBe(false);
    const outAt = a.tick - 1;
    const delay = Math.round(RESPAWN_DELAY_S / DT);
    while (a.tick - outAt < delay) {
      hold(p, { mx: 1, fire: true, dash: true });
      stepQuiet(a);
      expect(p.alive).toBe(false);
      expect([p.x, p.y]).toEqual([1210 - 10, 1200]);
      expect(a.events.shotsFired).toEqual([]);
    }
    hold(p, { dash: false });
    stepQuiet(a, 3);
    expect(p.alive).toBe(false);
    hold(p, { dash: true });
    stepQuiet(a);
    expect(p.alive).toBe(true);
    expect([p.hits, p.score, p.kills, p.streak, p.heat]).toEqual([0, 0, 0, 0, 0]);
    expect(p.invulnTicks).toBeGreaterThan(0);
    expect(p.lifeStartTick).toBe(a.tick - 1);
  });

  test("leaving ends an alive life and returns it; the step's own list is untouched", () => {
    const { a, ps } = arenaWith([1200, 1200], [1800, 1800]);
    const [p1, p3] = [ps[0]!, ps[1]!];
    p3.score = 15;
    downNow(a, p3);
    bleedNow(a, p3);
    stepQuiet(a, 8);
    p1.score = 25;
    p1.kills = 2;
    expect(leavePlayer(a, p1.id)).toEqual({ life: { id: p1.id, score: 25, kills: 2, ticks: 10 } });
    expect(a.events.livesEnded).toEqual([]);
    expect(leavePlayer(a, p3.id)).toEqual({ life: null });
  });

  test("the same seed and inputs give the same arena after 2000 ticks", () => {
    const run = () => {
      const a = createArena(77);
      const p1 = joinPlayer(a, "one", "tabs");
      const p2 = joinPlayer(a, "two", "spaces");
      for (let t = 0; t < 2000; t++) {
        p1.input = clampInput({ seq: t, mx: Math.cos(t / 40), my: Math.sin(t / 40), aim: t / 30, fire: t % 30 < 15, dash: t % 50 === 0 });
        p2.input = clampInput({ seq: t, mx: -1, my: 0.3, aim: -t / 25, fire: true, dash: t % 70 === 0 });
        stepArena(a);
      }
      return JSON.stringify(a);
    };
    const first = run();
    expect(run()).toBe(first);
    expect(JSON.parse(first).bugs.length + JSON.parse(first).nextBugId).toBeGreaterThan(10);
  });
});
