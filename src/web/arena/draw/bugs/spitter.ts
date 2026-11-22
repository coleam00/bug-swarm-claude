// The spitter (#72): a fat, acid-green bug whose swell reads from across a phone screen, and
// from off it. Every player sees it, whoever it is aimed at (the snapshot's phase tail).
// - keep: fat and quiet.
// - tell: it swells to SWELL x its size, a sac on its back and an acid glow grow, and the glow
//   pulses in the last PULSE_S. A spitter telling off screen, within EDGE_RANGE of it, gets a
//   chevron at the screen's edge pointing at it, swelling with it: a portrait phone shows about
//   370 units across, and a spitter keeps 260 to 360 from its target, so it is often just off.
// - spit: it snaps small (the recoil) and grows back.
import { SPIT, SPITTER_RADIUS, SPIT_TICKS, TELL, TELL_S } from "../../../../shared/arena/bugs/spitter";
import { DT } from "../../../../shared/arena/constants";
import { GLOW_ACID, PALETTE, type BugLook } from "../../../game/look";
import type { BugsView } from "../../render";
import { drawBody } from "./body";
import type { BugDraw, BugFrame } from "./kind";

const look: BugLook = {
  // Drawn a touch larger than its 12-unit collision radius, and wider still across: fat.
  radius: SPITTER_RADIUS + 1,
  shell: "#4d9a16",
  shine: "#b6ff7a",
  head: "#163a04",
  legs: "#d9ffb8",
  glow: GLOW_ACID,
  legHz: 2,
  legSwing: 0.3,
  jitter: 0.04,
  jitterHz: 0.6,
};

/** Fat: its body is drawn this wide across its heading. */
const FAT = 1.2;
/** How big it swells by the end of its tell. */
export const SWELL = 1.55;
/** The last part of the tell, seconds, in which it pulses at PULSE_HZ. */
const PULSE_S = 0.2;
const PULSE_HZ = 6;
const SPIT_S = SPIT_TICKS * DT;
/** A telling spitter this far outside the screen, world units, gets an edge chevron. */
export const EDGE_RANGE = 700;
/** How far inside the screen's (safe) edge the chevron sits, world units. */
export const EDGE_INSET = 22;
const ACID = PALETTE[GLOW_ACID];
const SAC = "#efffb0";
const TAU = Math.PI * 2;

/** How a spitter looks at a moment: its size, the glow and sac strength (0 to 1). */
export type SpitterLook = { scale: number; glow: number };

/**
 * How a spitter in phase `phase` (an index into SPITTER_PHASES), `secondsIn` seconds into it, is
 * drawn, written into `out`. Pure; allocates nothing.
 * - keep: size 1, no glow.
 * - tell (p = how far through, 0 to 1): size eased from 1 to SWELL, glow from 0.3 to 1, pulsing
 *   in the last PULSE_S.
 * - spit: snaps to 0.85 and grows back to 1 over the recoil, the glow fading out.
 */
export function spitterLook(phase: number, secondsIn: number, out: SpitterLook): SpitterLook {
  out.scale = 1;
  out.glow = 0;
  if (phase === TELL) {
    const p = Math.min(1, Math.max(0, secondsIn / TELL_S));
    out.scale = 1 + (SWELL - 1) * p * p * (3 - 2 * p);
    out.glow = 0.3 + 0.7 * p;
    const late = secondsIn - (TELL_S - PULSE_S);
    if (late > 0) {
      const w = Math.cos(TAU * PULSE_HZ * late);
      out.glow *= 0.75 + 0.25 * w;
      out.scale *= 1 + 0.04 * w;
    }
  } else if (phase === SPIT) {
    const p = Math.min(1, Math.max(0, secondsIn / SPIT_S));
    out.scale = 0.85 + 0.15 * p;
    out.glow = 0.6 * (1 - p);
  }
  return out;
}

export type EdgeMark = { x: number; y: number; angle: number };

/**
 * Where to put the chevron for a spitter at (x, y), world units, into `out`: on the line from the
 * screen's centre toward it, where it meets the screen (left, top, right, bottom) inset by
 * `inset`, pointing at it (`angle`, radians, 0 to the right). False, and `out` untouched, when it
 * is on the screen or more than EDGE_RANGE outside it.
 */
export function edgeMark(left: number, top: number, right: number, bottom: number, x: number, y: number, inset: number, out: EdgeMark): boolean {
  const ox = x < left ? left - x : x > right ? x - right : 0;
  const oy = y < top ? top - y : y > bottom ? y - bottom : 0;
  if (ox === 0 && oy === 0) return false;
  if (ox * ox + oy * oy > EDGE_RANGE * EDGE_RANGE) return false;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const dx = x - cx;
  const dy = y - cy;
  const l = left + inset;
  const r = right - inset;
  const t0 = top + inset;
  const b = bottom - inset;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (r - cx) / dx);
  else if (dx < 0) t = Math.min(t, (l - cx) / dx);
  if (dy > 0) t = Math.min(t, (b - cy) / dy);
  else if (dy < 0) t = Math.min(t, (t0 - cy) / dy);
  out.x = Math.min(r, Math.max(l, cx + dx * t));
  out.y = Math.min(b, Math.max(t0, cy + dy * t));
  out.angle = Math.atan2(dy, dx);
  return true;
}

const now: SpitterLook = { scale: 1, glow: 0 };
const mark: EdgeMark = { x: 0, y: 0, angle: 0 };

/** The edge chevron of a spitter telling off screen. */
function under(f: BugFrame, view: BugsView, i: number): void {
  if (view.phase[i] !== TELL) return;
  if (!edgeMark(f.screenLeft, f.screenTop, f.screenRight, f.screenBottom, view.x[i]!, view.y[i]!, EDGE_INSET, mark)) return;
  const lk = spitterLook(TELL, view.phaseS[i]!, now);
  const { ctx, k } = f;
  const c = Math.cos(mark.angle) * k * lk.scale;
  const s = Math.sin(mark.angle) * k * lk.scale;
  ctx.setTransform(c, s, -s, c, k * mark.x + f.ox, k * mark.y + f.oy);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.6 * lk.glow;
  ctx.drawImage(f.glow, -20, -20, 40, 40);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 0.55 + 0.45 * lk.glow;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#05070d";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(-5, -10);
  ctx.lineTo(7, 0);
  ctx.lineTo(-5, 10);
  ctx.stroke();
  ctx.strokeStyle = ACID;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function draw(f: BugFrame, view: BugsView, i: number): void {
  const phase = view.phase[i]!;
  const lk = spitterLook(phase, view.phaseS[i]!, now);
  const { ctx, k } = f;
  const x = view.x[i]!;
  const y = view.y[i]!;
  if (lk.glow > 0) {
    const g = look.radius * 4.5 * lk.scale;
    ctx.setTransform(k, 0, 0, k, f.ox, f.oy);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = lk.glow;
    ctx.drawImage(f.glow, x - g, y - g, g * 2, g * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  // Telling or recoiling it faces where it aims; keeping its distance, it wobbles like any bug.
  const angle = phase === 0 ? NaN : view.angle[i]!;
  drawBody(f, look, view, i, lk.scale, lk.scale * FAT, 1, phase === 0 ? 1 : 0, angle);
  if (lk.glow > 0) {
    // The sac on its back, filling as it swells.
    ctx.setTransform(k, 0, 0, k, f.ox, f.oy);
    ctx.globalAlpha = lk.glow;
    ctx.fillStyle = SAC;
    ctx.beginPath();
    ctx.arc(x, y, look.radius * 0.45 * lk.scale, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export const spitterDraw: BugDraw = { look, under, draw };
