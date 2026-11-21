// A spitter's glob (#72): a bright yellow-green ball with a short tapering trail behind it, so it
// reads in a swarm and its line is easy to judge. Not a beetle: it does not use drawBody. Its
// heading is its motion between snapshots (game.ts), and in its fade its locked line; its
// fade is drawn from the snapshot's phase tail.
import { FADE, FADE_TICKS, GLOB_RADIUS } from "../../../../shared/arena/bugs/glob";
import { DT } from "../../../../shared/arena/constants";
import { GLOW_GLOB, PALETTE, type BugLook } from "../../../game/look";
import type { BugsView } from "../../render";
import type { BugDraw, BugFrame } from "./kind";

// A valid look for sprites.ts (its leg frames are built but never drawn) and its glow colour.
const look: BugLook = {
  radius: GLOB_RADIUS,
  shell: PALETTE[GLOW_GLOB],
  shine: "#ffffff",
  head: PALETTE[GLOW_GLOB],
  legs: PALETTE[GLOW_GLOB],
  glow: GLOW_GLOB,
  legHz: 0,
  legSwing: 0,
  jitter: 0,
  jitterHz: 0,
};

const FADE_S = FADE_TICKS * DT;
const CORE = PALETTE[GLOW_GLOB];
const HOT = "#ffffff";
/** The trail: this many blobs behind it, TRAIL_STEP units apart, shrinking and fading. */
const TRAIL_BLOBS = 4;
const TRAIL_STEP = 9;
const TAU = Math.PI * 2;

/**
 * A glob's opacity in phase `phase` (an index into GLOB_PHASES), `secondsIn` seconds into it:
 * 1 in flight, falling to 0 over its fade. Pure.
 */
export function globAlpha(phase: number, secondsIn: number): number {
  if (phase !== FADE) return 1;
  return Math.max(0, 1 - secondsIn / FADE_S);
}

function draw(f: BugFrame, view: BugsView, i: number): void {
  const a = globAlpha(view.phase[i]!, view.phaseS[i]!);
  if (a <= 0) return;
  const { ctx, k } = f;
  const x = view.x[i]!;
  const y = view.y[i]!;
  const h = view.heading[i]!;
  const bx = -Math.cos(h);
  const by = -Math.sin(h);
  ctx.setTransform(k, 0, 0, k, f.ox, f.oy);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.8 * a;
  const g = GLOB_RADIUS * 4;
  ctx.drawImage(f.glow, x - g, y - g, g * 2, g * 2);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = CORE;
  for (let s = TRAIL_BLOBS; s >= 1; s--) {
    const u = s / (TRAIL_BLOBS + 1);
    ctx.globalAlpha = a * 0.55 * (1 - u);
    ctx.beginPath();
    ctx.arc(x + bx * TRAIL_STEP * s, y + by * TRAIL_STEP * s, GLOB_RADIUS * (1 - 0.7 * u), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = a;
  ctx.beginPath();
  ctx.arc(x, y, GLOB_RADIUS, 0, TAU);
  ctx.fill();
  ctx.fillStyle = HOT;
  ctx.beginPath();
  ctx.arc(x - bx * 2, y - by * 2, GLOB_RADIUS * 0.45, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
}

export const globDraw: BugDraw = { look, draw };
