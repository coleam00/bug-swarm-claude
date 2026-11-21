// The dasher (#65): a lean, hot-pink bug whose tell reads from across a phone screen. Every player
// sees it, whoever it is aimed at: it comes from the snapshot's phase tail every socket shares.
// - tell: it crouches (shorter along its line, wider across), a pink glow grows and pulses in the
//   last quarter second, and an aim line runs the length of the lunge to a ring where it will stop.
// - lunge: stretched along its line, with a fading streak behind.
// - recover: drawn faint, legs slowed: winded.
import { DASHER_RADIUS, LUNGE, LUNGE_DIST, RECOVER, TELL, TELL_S } from "../../../../shared/arena/bugs/dasher";
import { WORLD_H, WORLD_W } from "../../../../shared/arena/constants";
import { GLOW_PINK, type BugLook } from "../../../game/look";
import type { BugsView } from "../../render";
import { drawBody } from "./body";
import type { BugDraw, BugFrame } from "./kind";

const look: BugLook = {
  radius: DASHER_RADIUS,
  shell: "#db2777",
  shine: "#f472b6",
  head: "#500724",
  legs: "#fbcfe8",
  glow: GLOW_PINK,
  legHz: 4,
  legSwing: 0.45,
  jitter: 0.06,
  jitterHz: 1.5,
};

/** Lean: its body is drawn this narrow across its heading. */
const LEAN = 0.82;
const LINE = "#ff2d95";
const LINE_CORE = "#ffd1e8";
/** The aim line's soft underlay and its core, world units wide. */
const LINE_SOFT_W = 9;
const LINE_CORE_W = 2.6;
/** The last part of the tell, seconds, in which the glow pulses at PULSE_HZ. */
const PULSE_S = 0.25;
const PULSE_HZ = 6;
const TAU = Math.PI * 2;

/** How a dasher looks at a moment: body scale along and across its line, opacity, glow and aim line strength (0 to 1). */
export type DasherLook = { along: number; across: number; alpha: number; glow: number; line: number; streak: number };

/**
 * How a dasher in phase `phase` (an index into DASHER_PHASES), `secondsIn` seconds into it, is
 * drawn, written into `out`. Pure; allocates nothing.
 * - approach: lean, no glow, no line.
 * - tell (p = how far through, 0 to 1): 15% shorter along its line and 10% wider at the end, glow
 *   from 0.4 to 1 (pulsing at PULSE_HZ in the last PULSE_S), the line from 0.35 to 1.
 * - lunge: 1.3x along its line, a streak behind.
 * - recover: at 0.6 opacity.
 */
export function dasherLook(phase: number, secondsIn: number, out: DasherLook): DasherLook {
  out.along = 1;
  out.across = LEAN;
  out.alpha = 1;
  out.glow = 0;
  out.line = 0;
  out.streak = 0;
  if (phase === TELL) {
    const p = Math.min(1, Math.max(0, secondsIn / TELL_S));
    out.along = 1 - 0.15 * p;
    out.across = LEAN * (1 + 0.1 * p);
    out.glow = 0.4 + 0.6 * p;
    const late = secondsIn - (TELL_S - PULSE_S);
    if (late > 0) out.glow *= 0.7 + 0.3 * Math.cos(TAU * PULSE_HZ * late);
    out.line = 0.35 + 0.65 * p;
  } else if (phase === LUNGE) {
    out.along = 1.3;
    out.across = LEAN * 0.9;
    out.glow = 0.5;
    out.streak = 1;
  } else if (phase === RECOVER) {
    out.alpha = 0.6;
  }
  return out;
}

/**
 * How far a lunge from (x, y) along (dx, dy) carries before a wall stops it (the simulation stops
 * it with its radius at the wall), up to LUNGE_DIST.
 */
export function lungeReach(x: number, y: number, dx: number, dy: number): number {
  const R = DASHER_RADIUS;
  let t = LUNGE_DIST;
  if (dx > 0) t = Math.min(t, (WORLD_W - R - x) / dx);
  else if (dx < 0) t = Math.min(t, (R - x) / dx);
  if (dy > 0) t = Math.min(t, (WORLD_H - R - y) / dy);
  else if (dy < 0) t = Math.min(t, (R - y) / dy);
  return Math.max(0, t);
}

const now: DasherLook = { along: 1, across: LEAN, alpha: 1, glow: 0, line: 0, streak: 0 };

/** The aim line of a dasher in its tell, under every body, drawn when any of it is in view. */
function under(f: BugFrame, view: BugsView, i: number): void {
  if (view.phase[i] !== TELL) return;
  const x = view.x[i]!;
  const y = view.y[i]!;
  const a = view.angle[i]!;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const reach = lungeReach(x, y, dx, dy);
  const ex = x + dx * reach;
  const ey = y + dy * reach;
  if (Math.max(x, ex) < f.left || Math.min(x, ex) > f.right || Math.max(y, ey) < f.top || Math.min(y, ey) > f.bottom) return;
  const lk = dasherLook(TELL, view.phaseS[i]!, now);
  const { ctx, k } = f;
  ctx.setTransform(k, 0, 0, k, f.ox, f.oy);
  ctx.lineCap = "round";
  ctx.strokeStyle = LINE;
  ctx.globalAlpha = 0.35 * lk.line;
  ctx.lineWidth = LINE_SOFT_W;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.globalAlpha = lk.line;
  ctx.strokeStyle = LINE_CORE;
  ctx.lineWidth = LINE_CORE_W;
  ctx.stroke();
  // Where it will stop.
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(ex, ey, DASHER_RADIUS + 5, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function draw(f: BugFrame, view: BugsView, i: number): void {
  const phase = view.phase[i]!;
  const lk = dasherLook(phase, view.phaseS[i]!, now);
  const { ctx, k } = f;
  const x = view.x[i]!;
  const y = view.y[i]!;
  if (lk.streak > 0) {
    // A short streak behind the lunge, fading back along its line.
    const a = view.angle[i]!;
    const bx = -Math.cos(a);
    const by = -Math.sin(a);
    ctx.setTransform(k, 0, 0, k, f.ox, f.oy);
    ctx.lineCap = "round";
    ctx.strokeStyle = LINE;
    ctx.lineWidth = DASHER_RADIUS * 1.2;
    for (let s = 0; s < 3; s++) {
      ctx.globalAlpha = 0.3 - s * 0.09;
      ctx.beginPath();
      ctx.moveTo(x + bx * (8 + s * 16), y + by * (8 + s * 16));
      ctx.lineTo(x + bx * (22 + s * 16), y + by * (22 + s * 16));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (lk.glow > 0) {
    const g = DASHER_RADIUS * 4.2;
    ctx.setTransform(k, 0, 0, k, f.ox, f.oy);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = lk.glow;
    ctx.drawImage(f.glow, x - g, y - g, g * 2, g * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  // In a phase with a locked line it faces that line exactly; walking, it wobbles like any bug.
  const angle = phase === 0 ? NaN : view.angle[i]!;
  const legs = phase === TELL ? 0 : phase === RECOVER ? 0.3 : phase === LUNGE ? 2 : 1;
  drawBody(f, look, view, i, lk.along, lk.across, lk.alpha, legs, angle);
}

export const dasherDraw: BugDraw = { look, under, draw };
