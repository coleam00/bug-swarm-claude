// The prediction contract: the browser's replay must land where the server's stepping does,
// using the same shared sim. The server here is the real shared simulation.
import { describe, expect, test } from "bun:test";
import { PLAYER_RADIUS } from "../../shared/arena/constants";
import { encodeSnapshotPlayers } from "../../shared/arena/protocol";
import { ROBOT_RADIUS } from "../game/config";
import { clampInput, createArena, joinPlayer, stepArena, type Input, type Player } from "../../shared/arena/sim";
import { createPredictor, decayCorrection, predictLocal, predictedAt, reconcile, resetPredictor, SNAP_DISTANCE } from "./predict";

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
    reconcile(client, x, y, vx, vy, k);
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
    reconcile(client, x, y, vx, vy, 20);
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

  test("a huge correction snaps instead of sliding across the arena", () => {
    const p = createPredictor();
    resetPredictor(p, 100, 100);
    predictLocal(p, clampInput({ seq: 1, mx: 1, my: 0, aim: 0, fire: false, dash: false }));
    reconcile(p, 100 + SNAP_DISTANCE * 3, 100, 0, 0, 1);
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

test("an arena robot is release 1's robot size, so the reused sprites fit it", () => {
  expect(PLAYER_RADIUS).toBe(ROBOT_RADIUS);
});
