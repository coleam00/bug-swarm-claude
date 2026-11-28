// The invisibility cloak (#132): a hooded-cloak glyph, and a slow shimmering violet outline around
// a robot that has it. render.ts drawRobot draws a cloaked robot's body at CLOAK_ALPHA; this outline
// is drawn on every page, so teammates still see where a cloaked player is.
import { PLAYER_RADIUS } from "../../../../shared/arena/constants";
import { GLOW_CLOAK, PALETTE } from "../../../game/look";
import type { PickupDraw } from "./kind";

const COLOUR = PALETTE[GLOW_CLOAK];
/** A cloaked robot's body opacity (the issue's 30%). */
export const CLOAK_ALPHA = 0.3;
/** The outline's radius, world units (outside your own white marker and a shield's bubble), and its shimmer (cycles a second: slow). */
export const CLOAK_OUTLINE_RADIUS = PLAYER_RADIUS + 11;
const SHIMMER_HZ = 0.8;
const TAU = Math.PI * 2;

/** Adds two arcs of the outline to the path, `len` radians each, from `from` and half a turn on. */
function arcs(ctx: CanvasRenderingContext2D, x: number, y: number, from: number, len: number): void {
  for (let i = 0; i < 2; i++) {
    const a = from + i * Math.PI;
    ctx.moveTo(x + Math.cos(a) * CLOAK_OUTLINE_RADIUS, y + Math.sin(a) * CLOAK_OUTLINE_RADIUS);
    ctx.arc(x, y, CLOAK_OUTLINE_RADIUS, a, a + len);
  }
}

export const cloakDraw: PickupDraw = {
  glow: GLOW_CLOAK,
  glyph(ctx, x, y, size) {
    const h = size / 2;
    ctx.fillStyle = COLOUR;
    // A bell-shaped cloak, flaring to the hem, under a round hood.
    ctx.beginPath();
    ctx.moveTo(x - h * 0.3, y - h * 0.2);
    ctx.quadraticCurveTo(x - h * 0.55, y + h * 0.4, x - h * 0.85, y + h);
    ctx.lineTo(x + h * 0.85, y + h);
    ctx.quadraticCurveTo(x + h * 0.55, y + h * 0.4, x + h * 0.3, y - h * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y - h * 0.45, h * 0.45, 0, TAU);
    ctx.fill();
  },
  on(ctx, x, y, _aim, t, glow, id) {
    // A faint glow, then the outline as two long and two short arcs breathing out of phase and
    // turning slowly, so it ripples.
    const k = 0.5 + 0.5 * Math.sin(t * TAU * SHIMMER_HZ + id);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.2 + 0.2 * k;
    const g = CLOAK_OUTLINE_RADIUS * 1.6;
    ctx.drawImage(glow, x - g, y - g, g * 2, g * 2);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = COLOUR;
    ctx.lineWidth = 2.5;
    const spin = t * 0.6 + id;
    ctx.globalAlpha = 0.45 + 0.45 * k;
    ctx.beginPath();
    arcs(ctx, x, y, spin, Math.PI * 0.8);
    ctx.stroke();
    ctx.globalAlpha = 0.9 - 0.45 * k;
    ctx.beginPath();
    arcs(ctx, x, y, spin + Math.PI * 0.8, Math.PI * 0.2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  },
};
