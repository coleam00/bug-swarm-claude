// The beetle (#80): a big, slow, steel-blue bug with a shell over its front 120 degrees. Every
// player sees which way its shell faces: a beetle is never in phase 0 once it has stepped, so its
// facing rides every snapshot row's tail (and turns smoothly between snapshots, game.ts).
// - The shell's rim: a bright pale arc over a soft steel glow, round its front SHELL_HALF either
//   side of its facing, just outside its body, so the side that blocks reads at a glance.
// - A shot the shell blocks sparks steel-white and rings a "ting" (game.ts, tings.ts); a shot that
//   hurts it sparks yellow, as on any bug.
import { BEETLE_RADIUS, SHELL_HALF } from "../../../../shared/arena/bugs/beetle";
import { GLOW_STEEL, PALETTE, type BugLook } from "../../../game/look";
import type { BugsView } from "../../render";
import { drawBody } from "./body";
import type { BugDraw, BugFrame } from "./kind";

const look: BugLook = {
  // Drawn much bigger than its 12-unit collision radius: a big, armoured bug.
  radius: BEETLE_RADIUS * 1.7,
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

/** The rim's radius, world units: just outside the drawn body. */
export const RIM_RADIUS = look.radius + 2;
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
  drawBody(f, look, view, i, 1, 1, 1, 1, angle);
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
