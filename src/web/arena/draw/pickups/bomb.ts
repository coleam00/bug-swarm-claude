// The refactor bomb (#78): a ringed-burst glyph. It is instant, so it has no `on`: taking it
// starts release 1's expanding ring at the taker for everyone (game.ts, fx/rings.ts).
import { GLOW_BOMB, PALETTE } from "../../../game/look";
import type { PickupDraw } from "./kind";

const COLOUR = PALETTE[GLOW_BOMB];
/** The burst's spokes. */
const SPOKES = 8;

export const bombDraw: PickupDraw = {
  glow: GLOW_BOMB,
  glyph(ctx, x, y, size) {
    const h = size / 2;
    ctx.strokeStyle = COLOUR;
    ctx.lineWidth = Math.max(1.5, size * 0.12);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(x, y, h * 0.85, 0, Math.PI * 2);
    for (let i = 0; i < SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ctx.moveTo(x + c * h * 0.25, y + s * h * 0.25);
      ctx.lineTo(x + c * h * 0.55, y + s * h * 0.55);
    }
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, h * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineCap = "butt";
  },
};
