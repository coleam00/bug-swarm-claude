// The prediction contract: the browser's replay must land where the server's stepping does,
// using the same shared sim. The server here is the real shared simulation.
import { describe, expect, test } from "bun:test";
import { DASH_COOLDOWN_TICKS, PLAYER_RADIUS } from "../../shared/arena/constants";
import { encodeSnapshotPlayers } from "../../shared/arena/protocol";
import { ROBOT_RADIUS } from "../game/config";
import { clampInput, createArena, joinPlayer, stepArena, type Input, type Player } from "../../shared/arena/sim";
import { MAX_PENDING, createPredictor, decayCorrection, predictLocal, predictedAt, reconcile, resetPredictor, SNAP_DISTANCE } from "./predict";

/** A wandering input sequence: turns, stops and diagonals. */
function inputs(n: number): Input[] {
  const out: Input[] = [];
  for (let i = 1; i <= n; i++) {
    const a = i * 0.37;
    const stop = i % 11 < 2;
    out.push(clampInput({ seq: i, mx: stop ? 0 : Math.cos(a) * 1.3, my: stop ? 0 : Math.sin(a), aim: a, fire: false, dash: false }));
  }
  return out;
}

/** The player as a snapshot carries it: quantized to 0.01. */
function quantized(p: Player): [number, number, number, number] {
  const row = (JSON.parse(encodeSnapshotPlayers([p])) as number[][])[0]!;
  return [row[1]!, row[2]!, row[3]!, row[4]!];
}

describe("prediction", () => {
  test("replaying unacknowledged inputs from a snapshot lands on the server's state", () => {
    const seq = inputs(40);
    const arena = createArena(3);
    const server = joinPlayer(arena, "srv", "tabs");
    const client = createPredictor();
    resetPredictor(client, server.x, server.y);
    const history: [number, number, number, number][] = [];
    for (const input of seq) {
      predictLocal(client, input);
      server.input = input;
      stepArena(arena);
      history.push(quantized(server));
    }
    const final = { x: server.x, y: server.y };
    // A snapshot from when the server had applied input 34: 6 inputs still in flight.
    const k = 34;
    const [x, y, vx, vy] = history[k - 1]!;
    reconcile(client, x, y, vx, vy, 0, 0, k);
    expect(client.pending.map((i) => i.seq)).toEqual([35, 36, 37, 38, 39, 40]);
    expect(Math.abs(client.x - final.x)).toBeLessThan(0.05);
    expect(Math.abs(client.y - final.y)).toBeLessThan(0.05);
  });

  test("when the server missed an input, the next snapshot corrects the prediction and the jump fades", () => {
    const seq = inputs(20);
    const arena = createArena(9);
    const server = joinPlayer(arena, "srv", "tabs");
    const client = createPredictor();
    resetPredictor(client, server.x, server.y);
    for (const input of seq) {
      predictLocal(client, input);
      if (input.seq !== 10) server.input = input; // input 10 lost: the server repeats 9
      stepArena(arena);
    }
    const before = Math.hypot(client.x - server.x, client.y - server.y);
    expect(before).toBeGreaterThan(0.1);
    const [x, y, vx, vy] = quantized(server);
    reconcile(client, x, y, vx, vy, 0, 0, 20);
    expect(client.pending).toEqual([]);
    expect(Math.abs(client.x - server.x)).toBeLessThan(0.05);
    expect(Math.abs(client.y - server.y)).toBeLessThan(0.05);
    // Drawn where it was, then fading to the corrected spot.
    const out = { x: 0, y: 0 };
    predictedAt(client, 1, out);
    expect(Math.hypot(out.x - client.x, out.y - client.y)).toBeCloseTo(before, 1);
    for (let i = 0; i < 60; i++) decayCorrection(client, 1 / 60);
    predictedAt(client, 1, out);
    expect(Math.hypot(out.x - client.x, out.y - client.y)).toBeLessThan(0.01);
  });

  test("a correction moves nothing on screen at the moment it lands, at any point between steps", () => {
    const p = createPredictor();
    resetPredictor(p, 500, 500);
    for (let seq = 1; seq <= 4; seq++) predictLocal(p, clampInput({ seq, mx: 1, my: 0.5, aim: 0, fire: false, dash: false }));
    const before = { x: 0, y: 0 };
    const after = { x: 0, y: 0 };
    for (const alpha of [0, 0.3, 0.7]) {
      const q = structuredClone(p);
      predictedAt(q, alpha, before);
      // The server has you 4 units back and 2 up after input 2; inputs 3 and 4 replay from there.
      reconcile(q, 500 + 6 + 18 - 4, 500 + 3 + 9 + 2, 240, 120, 0, 0, 2);
      predictedAt(q, alpha, after);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  test("at most MAX_PENDING unacknowledged inputs are kept, the oldest dropped", () => {
    const p = createPredictor();
    resetPredictor(p, 500, 500);
    for (let seq = 1; seq <= MAX_PENDING + 5; seq++) predictLocal(p, clampInput({ seq, mx: 0, my: 0, aim: 0, fire: false, dash: false }));
    expect(p.pending.length).toBe(MAX_PENDING);
    expect(p.pending[0]!.seq).toBe(6);
  });

  test("a huge correction snaps instead of sliding across the arena", () => {
    const p = createPredictor();
    resetPredictor(p, 100, 100);
    predictLocal(p, clampInput({ seq: 1, mx: 1, my: 0, aim: 0, fire: false, dash: false }));
    reconcile(p, 100 + SNAP_DISTANCE * 3, 100, 0, 0, 0, 0, 1);
    expect([p.offX, p.offY]).toEqual([0, 0]);
    const out = { x: 0, y: 0 };
    predictedAt(p, 0.5, out);
    expect(out).toEqual({ x: 100 + SNAP_DISTANCE * 3, y: 100 });
  });

  test("drawing between steps lerps from the previous predicted position", () => {
    const p = createPredictor();
    resetPredictor(p, 500, 500);
    predictLocal(p, clampInput({ seq: 1, mx: 1, my: 0, aim: 0, fire: false, dash: false }));
    const out = { x: 0, y: 0 };
    predictedAt(p, 0.5, out);
    expect(out.x).toBeCloseTo(503, 9); // 120 u/s for 0.05 s = 6 units over the step
    expect(out.y).toBe(500);
  });
});

describe("predicting a dash", () => {
  /** Inputs 1 to n, moving right and slightly down, with a dash press on `press` only. */
  const run = (n: number, press: number) => {
    const out: Input[] = [];
    for (let i = 1; i <= n; i++) out.push(clampInput({ seq: i, mx: 1, my: 0.3, aim: 0, fire: false, dash: i === press }));
    return out;
  };
  /** A server player past its spawn lock, and a predictor started where it is. */
  const pair = () => {
    const arena = createArena(5);
    const server = joinPlayer(arena, "srv", "tabs");
    server.dashCooldown = 0;
    server.invulnTicks = 0;
    const client = createPredictor();
    resetPredictor(client, server.x, server.y);
    return { arena, server, client };
  };
  type Snap = { row: [number, number, number, number]; dk: number; dc: number };
  const snap = (p: Player): Snap => ({ row: quantized(p), dk: p.dashTicks, dc: p.dashCooldown });

  test("your dash moves you at once, and replays from a snapshot taken before the press land on the server's state", () => {
    const { arena, server, client } = pair();
    const history: Snap[] = [];
    for (const input of run(14, 8)) {
      predictLocal(client, input);
      server.input = input;
      stepArena(arena);
      history.push(snap(server));
    }
    expect(server.dashTicks).toBe(0);
    expect(client.dashStart).toBe(true);
    // A snapshot from input 6, two before the press: the replay runs the dash again.
    client.dashStart = false;
    const s = history[5]!;
    reconcile(client, ...s.row, s.dk, s.dc, 6);
    expect(Math.abs(client.x - server.x)).toBeLessThan(0.05);
    expect(Math.abs(client.y - server.y)).toBeLessThan(0.05);
    expect(client.dashCooldown).toBe(server.dashCooldown);
    expect(Math.hypot(client.offX, client.offY)).toBeLessThan(0.05);
    // A replay does not start the afterimage again.
    expect(client.dashStart).toBe(false);
  });

  test("a snapshot acking the press, mid-dash, leaves nothing to correct", () => {
    const { arena, server, client } = pair();
    const history: Snap[] = [];
    for (const input of run(12, 5)) {
      predictLocal(client, input);
      server.input = input;
      stepArena(arena);
      history.push(snap(server));
    }
    const s = history[5]!; // input 6: one dash tick in
    expect(s.dk).toBe(2);
    reconcile(client, ...s.row, s.dk, s.dc, 6);
    expect(Math.abs(client.x - server.x)).toBeLessThan(0.05);
    expect(Math.hypot(client.offX, client.offY)).toBeLessThan(0.05);
  });

  test("a dash the server refused (its cooldown still running) is corrected back", () => {
    const { arena, server, client } = pair();
    server.dashCooldown = 20; // the server knows of a dash this browser missed
    for (const input of run(6, 3)) {
      predictLocal(client, input);
      server.input = input;
      stepArena(arena);
    }
    expect([server.dashCooldown, client.dashCooldown]).toEqual([14, DASH_COOLDOWN_TICKS - 3]);
    expect(Math.abs(client.x - server.x)).toBeGreaterThan(100);
    reconcile(client, ...quantized(server), server.dashTicks, server.dashCooldown, 6);
    expect(Math.abs(client.x - server.x)).toBeLessThan(0.05);
    expect([client.dashTicks, client.dashCooldown]).toEqual([0, server.dashCooldown]);
  });
});

test("an arena robot is release 1's robot size, so the reused sprites fit it", () => {
  expect(PLAYER_RADIUS).toBe(ROBOT_RADIUS);
});
