// Prediction and reconciliation of your own robot. Each local 50 ms step runs the shared
// movement step (src/shared/arena/sim.ts stepMover, the dash included) with the input it sends, so
// you move and dash at once; each snapshot resets to the server's state at the last input it applied (`ack`) and
// replays the inputs it has not applied yet. The jump that leaves is drawn away over about
// 100 ms (a visual offset), not snapped. Pure: no clock, no DOM.
import { stepMover, type Input, type Mover } from "../../shared/arena/sim";

/** Unacknowledged inputs kept for replay; older ones are dropped (the server has long applied them). */
export const MAX_PENDING = 64;
/** The visual offset left by a correction fades with this time constant, seconds. */
export const CORRECTION_SECONDS = 0.1;
/** A correction bigger than this, units, is snapped (a respawn, a long stall), not smoothed. */
export const SNAP_DISTANCE = 200;

/** Your robot as predicted: position, velocity and dash state (Mover), plus what drawing needs. */
export type Predictor = Mover & {
  /** A local step started a dash since the renderer last looked (it clears this). */
  dashStart: boolean;
  /** The dash bit of the last input the server acknowledged: the edge the replay starts from. */
  ackDash: boolean;
  /** The position before the last local step, for drawing between steps. */
  prevX: number;
  prevY: number;
  /** Drawn on top of the position, fading to 0 after a correction. */
  offX: number;
  offY: number;
  /** Inputs sent and not yet acknowledged, oldest first. */
  pending: Input[];
};

export function createPredictor(): Predictor {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    dashTicks: 0,
    dashCooldown: 0,
    dashWas: false,
    dashStart: false,
    ackDash: false,
    prevX: 0,
    prevY: 0,
    offX: 0,
    offY: 0,
    pending: [],
  };
}

/**
 * Starts over at a known state (a join or a respawn): the server's position and velocity, and its
 * dash ticks and cooldown from your numbers (`me.dk`, `me.dc`; a new life starts with the spawn lock).
 */
export function resetPredictor(p: Predictor, x: number, y: number, vx = 0, vy = 0, dashTicks = 0, dashCooldown = 0): void {
  p.x = p.prevX = x;
  p.y = p.prevY = y;
  p.vx = vx;
  p.vy = vy;
  p.dashTicks = dashTicks;
  p.dashCooldown = dashCooldown;
  p.dashWas = false;
  p.dashStart = false;
  p.ackDash = false;
  p.offX = p.offY = 0;
  p.pending.length = 0;
}

/** One local step with `input` (already clamped: sim.ts clampInput), kept for replay. */
export function predictLocal(p: Predictor, input: Input): void {
  p.pending.push(input);
  if (p.pending.length > MAX_PENDING) p.pending.shift();
  p.prevX = p.x;
  p.prevY = p.y;
  const before = p.dashTicks;
  stepMover(p, input);
  if (p.dashTicks > before) p.dashStart = true;
}

const body: Mover = { x: 0, y: 0, vx: 0, vy: 0, dashTicks: 0, dashCooldown: 0, dashWas: false };

/**
 * A snapshot says where the server has you after applying input `ack`: your position, velocity,
 * dash ticks left (`dk`) and cooldown (`dc`). Drop the inputs it has applied, start from its
 * state, replay the rest, and turn the difference into a fading offset. A dash the server refused
 * (its cooldown had not run out) is undone here like any other correction.
 */
export function reconcile(p: Predictor, x: number, y: number, vx: number, vy: number, dk: number, dc: number, ack: number): void {
  let drop = 0;
  while (drop < p.pending.length && p.pending[drop]!.seq <= ack) drop++;
  if (drop > 0) {
    p.ackDash = p.pending[drop - 1]!.dash;
    p.pending.splice(0, drop);
  }
  body.x = x;
  body.y = y;
  body.vx = vx;
  body.vy = vy;
  body.dashTicks = dk;
  body.dashCooldown = dc;
  body.dashWas = p.ackDash;
  for (const input of p.pending) stepMover(body, input);
  const dx = p.x - body.x;
  const dy = p.y - body.y;
  p.x = body.x;
  p.y = body.y;
  p.vx = body.vx;
  p.vy = body.vy;
  p.dashTicks = body.dashTicks;
  p.dashCooldown = body.dashCooldown;
  p.dashWas = body.dashWas;
  // Keep the in-between position consistent with the move, so drawing between steps doesn't jump.
  p.prevX -= dx;
  p.prevY -= dy;
  p.offX += dx;
  p.offY += dy;
  if (Math.hypot(p.offX, p.offY) > SNAP_DISTANCE) {
    p.offX = p.offY = 0;
    p.prevX = p.x;
    p.prevY = p.y;
  }
}

/** Fades the correction offset over `dt` seconds of frame time. */
export function decayCorrection(p: Predictor, dt: number): void {
  const k = Math.exp(-dt / CORRECTION_SECONDS);
  p.offX *= k;
  p.offY *= k;
  if (Math.abs(p.offX) < 1e-3) p.offX = 0;
  if (Math.abs(p.offY) < 1e-3) p.offY = 0;
}

/** Where to draw you, `alpha` (0..1) of the way through the current local step, into `out`. */
export function predictedAt(p: Predictor, alpha: number, out: { x: number; y: number }): void {
  out.x = p.prevX + (p.x - p.prevX) * alpha + p.offX;
  out.y = p.prevY + (p.y - p.prevY) * alpha + p.offY;
}
