// The arena simulation (release 2): pure and deterministic. The server steps it as the authority;
// the browser runs `stepPlayer` to predict its own robot. No clock, no Math.random, no DOM: time
// comes in as the fixed step and randomness from the arena's seeded generator.
import type { Team } from "../../server/rules";
import {
  ACCEL,
  DT,
  FRICTION,
  MAX_SPEED,
  PLAYER_RADIUS,
  SPAWN_MARGIN,
  WORLD_H,
  WORLD_W,
} from "./constants";
import { createRng, nextRandom, type Rng } from "./rng";

/** One player's input for one tick. `fire` and `dash` are carried but unused until later items. */
export type Input = {
  /** Sequence number, rising by one per input; the server echoes the last one it applied. */
  seq: number;
  /** Move vector, clamped to length 1. */
  mx: number;
  my: number;
  /** Aim angle, radians, in (-pi, pi]. */
  aim: number;
  fire: boolean;
  dash: boolean;
};

export type Player = {
  /** Entity id, unique within its arena. */
  id: number;
  name: string;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  /** The input applied each tick until a newer one arrives. */
  input: Input;
  /** Ticks since the last new input (the server zeroes a stale move). */
  idleTicks: number;
};

export type ArenaState = {
  tick: number;
  rng: Rng;
  players: Player[];
  nextId: number;
};

export function noInput(seq = 0): Input {
  return { seq, mx: 0, my: 0, aim: 0, fire: false, dash: false };
}

export function createArena(seed: number): ArenaState {
  return { tick: 0, rng: createRng(seed), players: [], nextId: 1 };
}

/** Adds a player at a random spot at least SPAWN_MARGIN from every wall. */
export function joinPlayer(state: ArenaState, name: string, team: Team): Player {
  const x = SPAWN_MARGIN + nextRandom(state.rng) * (WORLD_W - 2 * SPAWN_MARGIN);
  const y = SPAWN_MARGIN + nextRandom(state.rng) * (WORLD_H - 2 * SPAWN_MARGIN);
  const p: Player = { id: state.nextId++, name, team, x, y, vx: 0, vy: 0, aim: 0, input: noInput(), idleTicks: 0 };
  state.players.push(p);
  return p;
}

/** Removes a player. False if there was none with that id. */
export function leavePlayer(state: ArenaState, id: number): boolean {
  const i = state.players.findIndex((p) => p.id === id);
  if (i < 0) return false;
  state.players.splice(i, 1);
  return true;
}

/** Wraps an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  if (a > -Math.PI && a <= Math.PI) return a;
  const t = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
  return t === -Math.PI ? Math.PI : t;
}

/**
 * Makes an input safe to step, in place: a non-finite move or aim becomes 0, a move longer than
 * 1 is scaled to length 1, and the aim is wrapped to (-pi, pi]. Returns the same object.
 */
export function clampInput(input: Input): Input {
  if (!Number.isFinite(input.mx)) input.mx = 0;
  if (!Number.isFinite(input.my)) input.my = 0;
  if (!Number.isFinite(input.aim)) input.aim = 0;
  const len = Math.hypot(input.mx, input.my);
  if (len > 1) {
    input.mx /= len;
    input.my /= len;
  }
  input.aim = wrapAngle(input.aim);
  input.fire = input.fire === true;
  input.dash = input.dash === true;
  return input;
}

/** Moves `v` toward `target` by at most `step` (a vector step), writing into `out`. */
function approach(vx: number, vy: number, tx: number, ty: number, step: number, out: { x: number; y: number }): void {
  const dx = tx - vx;
  const dy = ty - vy;
  const d = Math.hypot(dx, dy);
  if (d <= step) {
    out.x = tx;
    out.y = ty;
  } else {
    out.x = vx + (dx / d) * step;
    out.y = vy + (dy / d) * step;
  }
}

const scratch = { x: 0, y: 0 };

/**
 * THE movement step, used by the server and by the browser's prediction: velocity moves toward
 * the move vector times MAX_SPEED by at most ACCEL * dt while a move is held, else toward rest by
 * at most FRICTION * dt; then the position moves; then the walls hold the player inside and stop
 * the velocity pushing into them. `mx, my` must already be clamped (clampInput).
 */
export function stepPlayer(
  p: { x: number; y: number; vx: number; vy: number },
  mx: number,
  my: number,
  dt: number = DT,
): void {
  if (mx !== 0 || my !== 0) approach(p.vx, p.vy, mx * MAX_SPEED, my * MAX_SPEED, ACCEL * dt, scratch);
  else approach(p.vx, p.vy, 0, 0, FRICTION * dt, scratch);
  p.vx = scratch.x;
  p.vy = scratch.y;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  const R = PLAYER_RADIUS;
  if (p.x < R) {
    p.x = R;
    if (p.vx < 0) p.vx = 0;
  } else if (p.x > WORLD_W - R) {
    p.x = WORLD_W - R;
    if (p.vx > 0) p.vx = 0;
  }
  if (p.y < R) {
    p.y = R;
    if (p.vy < 0) p.vy = 0;
  } else if (p.y > WORLD_H - R) {
    p.y = WORLD_H - R;
    if (p.vy > 0) p.vy = 0;
  }
}

/** Advances the arena one fixed step: every player moves with its current input. */
export function stepArena(state: ArenaState): void {
  for (const p of state.players) {
    stepPlayer(p, p.input.mx, p.input.my);
    p.aim = p.input.aim;
  }
  state.tick++;
}
