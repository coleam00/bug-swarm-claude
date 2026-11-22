// The review laser (#73): a lens-and-beam glyph, and a glow at the barrel tip of a robot that has
// it. Its shots are drawn as longer, brighter beams (render.ts drawShots).
import { BARREL } from "../../../../shared/arena/constants";
import { GLOW_LASER, PALETTE } from "../../../game/look";
import type { PickupDraw } from "./kind";

const COLOUR = PALETTE[GLOW_LASER];
/** The barrel-tip glow's size, world units, and its flicker (cycles a second). */
const TIP_GLOW = 9;
const TIP_HZ = 6;

export const laserDraw: PickupDraw = {
  glow: GLOW_LASER,
  glyph(ctx, x, y, size) {
    const h = size / 2;
    ctx.strokeStyle = COLOUR;
    ctx.lineWidth = Math.max(1.5, size * 0.14);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(x - h * 0.3, y, h * 0.45, 0, Math.PI * 2);
    ctx.moveTo(x + h * 0.1, y);
    ctx.lineTo(x + h, y);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x - h * 0.3, y, h * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineCap = "butt";
  },
  on(ctx, x, y, aim, t, glow) {
    const tx = x + Math.cos(aim) * BARREL;
    const ty = y + Math.sin(aim) * BARREL;
    const g = TIP_GLOW * (0.85 + 0.15 * Math.sin(t * Math.PI * 2 * TIP_HZ));
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(glow, tx - g, ty - g, g * 2, g * 2);
    ctx.globalCompositeOperation = "source-over";
  },
};
