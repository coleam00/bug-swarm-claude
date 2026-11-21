// The test shield (#73): a shield glyph, and a translucent bubble around a robot that has it.
import { PLAYER_RADIUS } from "../../../../shared/arena/constants";
import { GLOW_SHIELD, PALETTE } from "../../../game/look";
import type { PickupDraw } from "./kind";

const COLOUR = PALETTE[GLOW_SHIELD];
/** The bubble's radius, world units, and its rim's pulse (cycles a second). */
export const BUBBLE_RADIUS = PLAYER_RADIUS + 8;
const BUBBLE_PULSE_HZ = 2;
const BUBBLE_FILL = "rgba(125, 211, 252, 0.16)";

export const shieldDraw: PickupDraw = {
  glow: GLOW_SHIELD,
  glyph(ctx, x, y, size) {
    const h = size / 2;
    ctx.fillStyle = COLOUR;
    ctx.beginPath();
    ctx.moveTo(x, y - h);
    ctx.lineTo(x + h * 0.85, y - h * 0.6);
    ctx.lineTo(x + h * 0.75, y + h * 0.2);
    ctx.quadraticCurveTo(x + h * 0.5, y + h * 0.75, x, y + h);
    ctx.quadraticCurveTo(x - h * 0.5, y + h * 0.75, x - h * 0.75, y + h * 0.2);
    ctx.lineTo(x - h * 0.85, y - h * 0.6);
    ctx.closePath();
    ctx.fill();
  },
  on(ctx, x, y, _aim, t, glow) {
    const k = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * BUBBLE_PULSE_HZ);
    ctx.fillStyle = BUBBLE_FILL;
    ctx.beginPath();
    ctx.arc(x, y, BUBBLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.25 + 0.2 * k;
    const g = BUBBLE_RADIUS * 1.6;
    ctx.drawImage(glow, x - g, y - g, g * 2, g * 2);
    ctx.globalAlpha = 0.55 + 0.35 * k;
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = COLOUR;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  },
};
