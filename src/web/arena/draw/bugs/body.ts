// A bug's body (release 1's walking sprite), shared by every kind's draw function.
import type { BugLook } from "../../../game/look";
import { BUG_SPRITE_HALF } from "../../../game/sprites";
import type { BugsView } from "../../render";
import type { BugFrame } from "./kind";

const TAU = Math.PI * 2;
/** Leg frames walked forward then back: 0 1 2 3 2 1 (release 1's). */
const LEG_CYCLE = [0, 1, 2, 3, 2, 1];

/**
 * Draws bug `i` facing `angle` (its heading plus the look's wobble when `angle` is NaN), its legs
 * walking at the look's pace, `along` x its size along the heading and `across` x across it, at
 * `alpha`. `legRate` scales the walk (0: legs frozen in one pose).
 */
export function drawBody(f: BugFrame, look: BugLook, view: BugsView, i: number, along = 1, across = 1, alpha = 1, legRate = 1, angle = NaN): void {
  const { ctx, k, t } = f;
  const x = view.x[i]!;
  const y = view.y[i]!;
  const anim = view.anim[i]!;
  const a = Number.isNaN(angle) ? view.heading[i]! + look.jitter * Math.sin(TAU * (t * look.jitterHz + anim)) : angle;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const u = t * look.legHz * legRate + anim;
  const frame = LEG_CYCLE[Math.floor((u - Math.floor(u)) * LEG_CYCLE.length)]!;
  const half = look.radius * BUG_SPRITE_HALF;
  ctx.setTransform(k * c * along, k * s * along, -k * s * across, k * c * across, k * x + f.ox, k * y + f.oy);
  if (alpha !== 1) ctx.globalAlpha = alpha;
  ctx.drawImage(f.frames[frame]!, -half, -half, half * 2, half * 2);
  if (alpha !== 1) ctx.globalAlpha = 1;
}
