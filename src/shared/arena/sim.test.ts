import { describe, expect, test } from "bun:test";
import { MAX_SPEED, PLAYER_RADIUS, SPAWN_MARGIN, WORLD_H, WORLD_W } from "./constants";
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
    expect(leavePlayer(a, p1.id)).toBe(true);
    expect(leavePlayer(a, p1.id)).toBe(false);
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
