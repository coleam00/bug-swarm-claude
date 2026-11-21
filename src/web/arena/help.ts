// Finding downed players (#59): an arrow at the screen's edge pointing to each downed player out
// of view within HELP_ARROW_RANGE of you, and their minimap dots blinking. Pure: render.ts draws
// what this places.
import { HELP_ARROW_RANGE } from "../../shared/arena/constants";
import type { Insets } from "../game/hud";
import type { Camera } from "./camera";
import { flashOn } from "./hudfx";

/** How far inside the (safe) screen edge an arrow sits, CSS px: its own size, so it is whole. */
export const ARROW_MARGIN = 28;
/** A downed player's minimap dot blinks this fast, cycles a second. */
export const HELP_BLINK_HZ = 3;

export type EdgeArrow = { x: number; y: number; angle: number };

/**
 * Where to draw the arrow to a downed player at (tx, ty), CSS px, into `out`: on the line from
 * the screen's centre toward them, where it meets the screen inset by the safe area plus
 * ARROW_MARGIN, pointing at them (`angle`, radians, 0 to the right). False, and `out` untouched,
 * when they are on screen or more than HELP_ARROW_RANGE from you at (selfX, selfY).
 */
export function edgeArrow(
  cam: Camera,
  cssW: number,
  cssH: number,
  insets: Insets,
  selfX: number,
  selfY: number,
  tx: number,
  ty: number,
  out: EdgeArrow,
): boolean {
  const rx = tx - selfX;
  const ry = ty - selfY;
  if (rx * rx + ry * ry > HELP_ARROW_RANGE * HELP_ARROW_RANGE) return false;
  const cx = cssW / 2;
  const cy = cssH / 2;
  const dx = (tx - cam.x) * cam.scale;
  const dy = (ty - cam.y) * cam.scale;
  const sx = cx + dx;
  const sy = cy + dy;
  if (sx >= 0 && sx <= cssW && sy >= 0 && sy <= cssH) return false;
  const left = insets.left + ARROW_MARGIN;
  const right = cssW - insets.right - ARROW_MARGIN;
  const top = insets.top + ARROW_MARGIN;
  const bottom = cssH - insets.bottom - ARROW_MARGIN;
  // The furthest along the line that stays inside on both axes.
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (right - cx) / dx);
  else if (dx < 0) t = Math.min(t, (left - cx) / dx);
  if (dy > 0) t = Math.min(t, (bottom - cy) / dy);
  else if (dy < 0) t = Math.min(t, (top - cy) / dy);
  out.x = Math.min(right, Math.max(left, cx + dx * t));
  out.y = Math.min(bottom, Math.max(top, cy + dy * t));
  out.angle = Math.atan2(dy, dx);
  return true;
}

/** Whether a player's minimap dot shows at `t` seconds: always while up, blinking while down. */
export function minimapDotOn(down: boolean, t: number): boolean {
  return !down || flashOn(t, HELP_BLINK_HZ);
}
