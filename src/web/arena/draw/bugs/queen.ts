// The hive queen (#85): a big beetle in royal amber with a swollen, striped abdomen trailing behind
// her, walking on slow legs. In her tell her abdomen glows, from 0.3 to full over the 1 s, pulsing
// in the last PULSE_S, and swells a little: the ring of globs is coming. Every player sees it
// (the snapshot's phase tail). She is drawn in `under`, with her own culling, so her abdomen never
// pops in at the screen's edge (`draw` is called only for a centre in view) and her brood walks
// over her. Her health bar, the arrow to her and her minimap mark are render.ts's, from `q`.
import { QUEEN_RADIUS, TELL, TELL_TICKS } from "../../../../shared/arena/bugs/queen";
import { DT } from "../../../../shared/arena/constants";
import { GLOW_QUEEN, PALETTE, type BugLook } from "../../../game/look";
import type { BugsView } from "../../render";
import { drawBody } from "./body";
import type { BugDraw, BugFrame } from "./kind";

const look: BugLook = {
  // Her head and thorax, drawn larger than her 40-unit collision radius; the abdomen adds the rest.
  radius: QUEEN_RADIUS + 12,
  shell: "#9a3412",
  shine: "#ffb020",
  head: "#2a0a04",
  legs: "#ffd98a",
  glow: GLOW_QUEEN,
  legHz: 0.9,
  legSwing: 0.25,
  jitter: 0.02,
  jitterHz: 0.3,
};

const TELL_S = TELL_TICKS * DT;
/** The last part of the tell, seconds, in which the glow pulses at PULSE_HZ. */
const PULSE_S = 0.2;
const PULSE_HZ = 6;
/** Her abdomen: its centre this many body radii behind hers, and its half-length and half-width. */
const ABDOMEN_BACK = 0.95;
const ABDOMEN_LONG = 0.95;
const ABDOMEN_WIDE = 0.72;
/** How far past her centre anything of her reaches, world units (her culling). */
export const QUEEN_REACH = look.radius * (ABDOMEN_BACK + ABDOMEN_LONG) * 1.25 + 20;
const ABDOMEN = "#5b1a0a";
const STRIPE = "#ffb020";
const GLOW = PALETTE[GLOW_QUEEN];
const TAU = Math.PI * 2;

/** How she looks at a moment: her abdomen's glow (0 to 1) and swell (1: as she walks). */
export type QueenLook = { glow: number; swell: number };

/**
 * How the queen in phase `phase`, `secondsIn` seconds into it, at scene time `t`, is drawn, into
 * `out`. Pure; allocates nothing.
 * - drift: no glow; her abdomen breathes slowly (swell 1 to 1.04).
 * - tell (p = how far through, 0 to 1): glow from 0.3 to 1 and swell to 1.15, the glow pulsing in
 *   the last PULSE_S.
 */
export function queenLook(phase: number, secondsIn: number, t: number, out: QueenLook): QueenLook {
  out.glow = 0;
  out.swell = 1 + 0.02 * (1 + Math.sin(t * TAU * 0.6));
  if (phase !== TELL) return out;
  const p = Math.min(1, Math.max(0, secondsIn / TELL_S));
  out.glow = 0.3 + 0.7 * p;
  out.swell = 1 + 0.15 * p;
  const late = secondsIn - (TELL_S - PULSE_S);
  if (late > 0) out.glow *= 0.75 + 0.25 * Math.cos(TAU * PULSE_HZ * late);
  return out;
}

const now: QueenLook = { glow: 0, swell: 1 };

function under(f: BugFrame, view: BugsView, i: number): void {
  const x = view.x[i]!;
  const y = view.y[i]!;
  if (x + QUEEN_REACH < f.left || x - QUEEN_REACH > f.right || y + QUEEN_REACH < f.top || y - QUEEN_REACH > f.bottom) return;
  const lk = queenLook(view.phase[i]!, view.phaseS[i]!, f.t, now);
  const { ctx, k } = f;
  const R = look.radius;
  const a = view.heading[i]!;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // A soft royal glow under all of her, stronger in her tell.
  ctx.setTransform(k, 0, 0, k, f.ox, f.oy);
  ctx.globalCompositeOperation = "lighter";
  const g = R * (3.2 + 0.8 * lk.glow);
  ctx.globalAlpha = 0.25 + 0.6 * lk.glow;
  ctx.drawImage(f.glow, x - c * R * 0.6 - g, y - s * R * 0.6 - g, g * 2, g * 2);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  // The abdomen, behind her along her heading, with amber stripes across it.
  const bx = x - c * R * ABDOMEN_BACK;
  const by = y - s * R * ABDOMEN_BACK;
  ctx.setTransform(k * c, k * s, -k * s, k * c, k * bx + f.ox, k * by + f.oy);
  const long = R * ABDOMEN_LONG * lk.swell;
  const wide = R * ABDOMEN_WIDE * lk.swell;
  ctx.fillStyle = ABDOMEN;
  ctx.beginPath();
  ctx.ellipse(0, 0, long, wide, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = STRIPE;
  ctx.lineWidth = R * 0.09;
  ctx.globalAlpha = 0.55 + 0.45 * lk.glow;
  for (let n = -1; n <= 1; n++) {
    const sx = n * long * 0.42;
    const sy = wide * Math.sqrt(Math.max(0, 1 - (sx / long) ** 2)) * 0.9;
    ctx.beginPath();
    ctx.moveTo(sx, -sy);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }
  if (lk.glow > 0) {
    // The tell: the abdomen lights from within.
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = lk.glow;
    ctx.fillStyle = GLOW;
    ctx.beginPath();
    ctx.ellipse(0, 0, long * 0.7, wide * 0.6, 0, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.globalAlpha = 1;
  // Her head and thorax: the walking beetle, a little long.
  drawBody(f, look, view, i, 1.1, 1, 1, 1, a);
}

export const queenDraw: BugDraw = { look, under, draw: () => {} };
