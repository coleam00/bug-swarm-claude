// The golden bug (#122): a gold beetle in a pulsing gold glow, trailing three twinkling sparkles
// behind its heading as it runs. Four drawImage calls and the body, nothing allocated per frame;
// an arena holds at most one.
import { GOLDEN_RADIUS } from "../../../../shared/arena/bugs/golden";
import { GLOW_GOLD, type BugLook } from "../../../game/look";
import type { BugsView } from "../../render";
import { drawBody } from "./body";
import type { BugDraw, BugFrame } from "./kind";

const look: BugLook = {
  radius: GOLDEN_RADIUS,
  shell: "#eab308",
  shine: "#fff3b0",
  head: "#713f12",
  legs: "#fde68a",
  glow: GLOW_GOLD,
  legHz: 7,
  legSwing: 0.5,
  jitter: 0.08,
  jitterHz: 2,
};

const TAU = Math.PI * 2;
/** Its glow pulses this fast, cycles a second, between GLOW_MIN and 1 opacity. */
export const PULSE_HZ = 2;
const GLOW_MIN = 0.55;
/** The glow's half size, world units. */
const GLOW_HALF = GOLDEN_RADIUS * 3.6;
/** Sparkles in its trail, each twinkling at SPARKLE_HZ, a third of a cycle apart. */
export const SPARKLES = 3;
export const SPARKLE_HZ = 3;

/** The glow's opacity at scene time `t` seconds: GLOW_MIN to 1, at PULSE_HZ. */
export function goldenPulse(t: number): number {
  return GLOW_MIN + (1 - GLOW_MIN) * (0.5 + 0.5 * Math.sin(t * TAU * PULSE_HZ));
}

/** One sparkle: how far behind the bug (world units, along its heading), how far to the side, its half size and opacity. */
export type Sparkle = { back: number; side: number; half: number; alpha: number };

/**
 * Sparkle `k` (0 to SPARKLES - 1) at scene time `t` seconds, into `out`: each sits further back
 * along the trail, swaying side to side, and twinkles (size and opacity) at SPARKLE_HZ, a third of
 * a cycle from the next. Pure; allocates nothing.
 */
export function sparkleAt(k: number, t: number, out: Sparkle): Sparkle {
  const u = 0.5 + 0.5 * Math.sin(TAU * (t * SPARKLE_HZ + k / SPARKLES));
  out.back = GOLDEN_RADIUS * (1.5 + 1.2 * k);
  out.side = GOLDEN_RADIUS * 0.6 * Math.sin(TAU * (t * 1.3 + k * 0.37));
  out.half = GOLDEN_RADIUS * (0.5 + 0.5 * u) * (1 - 0.2 * k);
  out.alpha = (0.35 + 0.65 * u) * (1 - 0.25 * k);
  return out;
}

const sp: Sparkle = { back: 0, side: 0, half: 0, alpha: 0 };

function draw(f: BugFrame, view: BugsView, i: number): void {
  const { ctx, k, t } = f;
  const x = view.x[i]!;
  const y = view.y[i]!;
  const a = view.heading[i]!;
  const c = Math.cos(a);
  const s = Math.sin(a);
  ctx.setTransform(k, 0, 0, k, f.ox, f.oy);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = goldenPulse(t);
  ctx.drawImage(f.glow, x - GLOW_HALF, y - GLOW_HALF, GLOW_HALF * 2, GLOW_HALF * 2);
  for (let n = 0; n < SPARKLES; n++) {
    sparkleAt(n, t, sp);
    const sx = x - c * sp.back - s * sp.side;
    const sy = y - s * sp.back + c * sp.side;
    ctx.globalAlpha = sp.alpha;
    ctx.drawImage(f.glow, sx - sp.half, sy - sp.half, sp.half * 2, sp.half * 2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  drawBody(f, look, view, i);
}

export const goldenDraw: BugDraw = { look, draw };
