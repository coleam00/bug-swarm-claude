// Grenades in the world (#130), in world units: a small glowing orb arcing from the thrower to its
// landing point; while it blinks there, a red dashed ring of the blast's reach on the floor so
// anyone near can dash out; then the blast's flash, a filled disc and a ring swelling to the reach
// (the particles and the shake are game.ts's, at the blast). Drawn from grenades.ts; allocates nothing.
import { GRENADE_RADIUS } from "../../../shared/arena/constants";
import { grenadeAt, grenadeClock, type ClientGrenades, type GrenadeAt } from "../grenades";

const TAU = Math.PI * 2;
/** The orb: radius, its glow's, and the flight's peak height over the floor, world units. */
const ORB_R = 6;
const ORB_GLOW_R = 16;
const ARC_HEIGHT = 70;
const ORB = "#ffb020";
const ORB_CORE = "#fff7d6";
const ORB_GLOW = "rgba(255, 176, 32, 0.35)";
/** The blink: the ring's colour, width and dashes, and how fast it blinks, cycles a second. */
const RING = "#f43f5e";
const RING_FILL = "rgba(244, 63, 94, 0.12)";
const RING_WIDTH = 3;
const RING_DASH: number[] = [14, 10];
const NO_DASH: number[] = [];
const BLINK_HZ = 6;
/** The flash: its fill and ring. */
const FLASH_FILL = "rgba(255, 200, 120, 0.55)";
const FLASH_RING = "#ffb020";

const g0: GrenadeAt = { phase: 0, x: 0, y: 0, k: 0 };

/**
 * Draws every grenade inside the view box (vl, vt)-(vr, vb), each at its thrower's clock. `t`:
 * seconds, for the blink.
 */
export function drawGrenades(
  ctx: CanvasRenderingContext2D,
  g: ClientGrenades,
  you: number | null,
  mineAt: number,
  othersAt: number,
  t: number,
  vl: number,
  vt: number,
  vr: number,
  vb: number,
): void {
  if (g.live === 0) return;
  const reach = GRENADE_RADIUS + RING_WIDTH;
  for (let i = 0; i < g.on.length; i++) {
    if (!g.on[i]) continue;
    const a = grenadeAt(g, i, grenadeClock(g, i, you, mineAt, othersAt), g0);
    if (a.phase === 0) continue;
    if (a.x + reach < vl || a.x - reach > vr || a.y + reach + ARC_HEIGHT < vt || a.y - reach > vb) continue;
    if (a.phase === 1) {
      // A shallow arc: the orb's shadow on the line, the orb lifted over it.
      const lift = Math.sin(Math.PI * a.k) * ARC_HEIGHT;
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.beginPath();
      ctx.ellipse(a.x, a.y, ORB_R, ORB_R * 0.5, 0, 0, TAU);
      ctx.fill();
      orb(ctx, a.x, a.y - lift);
    } else if (a.phase === 2) {
      // Blinking on the floor: the reach as a red dashed ring, brighter as the fuse runs down.
      const on = Math.sin(t * TAU * BLINK_HZ) > 0;
      ctx.fillStyle = RING_FILL;
      ctx.beginPath();
      ctx.arc(a.x, a.y, GRENADE_RADIUS, 0, TAU);
      ctx.fill();
      ctx.setLineDash(RING_DASH);
      ctx.strokeStyle = RING;
      ctx.lineWidth = RING_WIDTH;
      ctx.globalAlpha = on ? 1 : 0.45 + 0.4 * a.k;
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      ctx.globalAlpha = 1;
      orb(ctx, a.x, a.y);
      if (on) {
        ctx.fillStyle = RING;
        ctx.beginPath();
        ctx.arc(a.x, a.y, ORB_R * 0.6, 0, TAU);
        ctx.fill();
      }
    } else {
      // The blast: a flash filling the reach, and its ring, fading out.
      const fade = 1 - a.k;
      ctx.globalAlpha = fade;
      ctx.fillStyle = FLASH_FILL;
      ctx.beginPath();
      ctx.arc(a.x, a.y, GRENADE_RADIUS * (0.6 + 0.4 * a.k), 0, TAU);
      ctx.fill();
      ctx.strokeStyle = FLASH_RING;
      ctx.lineWidth = 6 * fade + 1;
      ctx.beginPath();
      ctx.arc(a.x, a.y, GRENADE_RADIUS, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function orb(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = ORB_GLOW;
  ctx.beginPath();
  ctx.arc(x, y, ORB_GLOW_R, 0, TAU);
  ctx.fill();
  ctx.fillStyle = ORB;
  ctx.beginPath();
  ctx.arc(x, y, ORB_R, 0, TAU);
  ctx.fill();
  ctx.fillStyle = ORB_CORE;
  ctx.beginPath();
  ctx.arc(x, y, ORB_R * 0.45, 0, TAU);
  ctx.fill();
}
