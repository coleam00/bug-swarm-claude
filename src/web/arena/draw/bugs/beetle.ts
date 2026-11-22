// The beetle (#80): a big, slow, steel-blue bug with a shell over its front 120 degrees. Every
// player sees which way its shell faces: a beetle is never in phase 0 once it has stepped, so its
// facing rides every snapshot row's tail (and turns smoothly between snapshots, game.ts).
// - It is drawn on the circle shots meet (its radius plus SHOT_RADIUS, combat.ts): its body, head
//   included, inside it, broad across its line rather than long, and the shell's rim, a bright pale
//   arc over a soft steel glow round its front SHELL_HALF either side of its facing, on it. So a shot
//   that visibly reaches the rim is one the simulation blocks, and its spark lands on the rim.
// - A shot the shell blocks sparks steel-white and rings a "ting" (game.ts, tings.ts); a shot that
//   hurts it sparks yellow, as on any bug.
import { BEETLE_RADIUS, SHELL_HALF } from "../../../../shared/arena/bugs/beetle";
import { SHOT_RADIUS } from "../../../../shared/arena/constants";
import { GLOW_STEEL, PALETTE, type BugLook } from "../../../game/look";
import type { BugsView } from "../../render";
import { drawBody } from "./body";
import type { BugDraw, BugFrame } from "./kind";

const look: BugLook = {
  // Sized so the sprite's head (1.23x this, sprites.ts) reaches the hit circle and no further.
  radius: (BEETLE_RADIUS + SHOT_RADIUS) / 1.23,
  shell: "#4b6a8a",
  shine: "#9fb8d0",
  head: "#1e2a38",
  legs: "#cbd5e1",
  glow: GLOW_STEEL,
  legHz: 2,
  legSwing: 0.3,
  jitter: 0,
  jitterHz: 0,
};

/** Broad: its body is drawn this wide across its line (the sprite's shell is 0.8x its radius across). */
export const BROAD = 1.35;
/** The rim's radius, world units: the circle shots meet it at, so blocks spark on the rim. */
export const RIM_RADIUS = BEETLE_RADIUS + SHOT_RADIUS;
/**
 * How far the drawn body reaches from its centre, world units: the sprite's head along its line
 * (1.23x the look's radius, sprites.ts) and its shell across it (0.8x, times BROAD).
 */
export const BODY_REACH = Math.max(1.23 * look.radius, 0.8 * look.radius * BROAD);
const RIM = "#e0f2fe";
const RIM_GLOW = PALETTE[GLOW_STEEL];
/** The rim's soft underlay and its bright core, world units wide. */
const RIM_GLOW_W = 7;
const RIM_CORE_W = 2.6;

export type RimSpan = { start: number; end: number };

/** The rim's arc for a beetle facing `angle` (radians): SHELL_HALF either side of it, written into `out`. Pure. */
export function beetleRim(angle: number, out: RimSpan): RimSpan {
  out.start = angle - SHELL_HALF;
  out.end = angle + SHELL_HALF;
  return out;
}

const rim: RimSpan = { start: 0, end: 0 };

function draw(f: BugFrame, view: BugsView, i: number): void {
  // It faces its facing exactly: the shell is where it points.
  const phase = view.phase[i]!;
  const angle = phase === 0 ? NaN : view.angle[i]!;
  drawBody(f, look, view, i, 1, BROAD, 1, 1, angle);
  if (phase === 0) return;
  const { ctx, k } = f;
  const x = view.x[i]!;
  const y = view.y[i]!;
  beetleRim(angle, rim);
  ctx.setTransform(k, 0, 0, k, f.ox, f.oy);
  ctx.lineCap = "round";
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = RIM_GLOW;
  ctx.lineWidth = RIM_GLOW_W;
  ctx.beginPath();
  ctx.arc(x, y, RIM_RADIUS, rim.start, rim.end);
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.strokeStyle = RIM;
  ctx.lineWidth = RIM_CORE_W;
  ctx.stroke();
}

export const beetleDraw: BugDraw = { look, draw };
