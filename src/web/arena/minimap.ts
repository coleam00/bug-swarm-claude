// The minimap: the whole world as a small square in the top-right corner, inside the safe area,
// with every player as a team-coloured dot. Pure: render.ts draws what this lays out.
import { WORLD_H, WORLD_W } from "../../shared/arena/constants";
import type { Insets } from "../game/hud";

/** The minimap's side on a phone (a screen whose short side is under PHONE_SHORT_SIDE), CSS px. */
export const MINIMAP_PHONE = 120;
export const MINIMAP_DESKTOP = 160;
export const PHONE_SHORT_SIDE = 500;
/** Its gap from the (safe) edges, CSS px. */
export const MINIMAP_MARGIN = 12;

export type MinimapLayout = { x: number; y: number; size: number };

export function minimapLayout(cssW: number, cssH: number, insets: Insets): MinimapLayout {
  const size = Math.min(cssW, cssH) < PHONE_SHORT_SIDE ? MINIMAP_PHONE : MINIMAP_DESKTOP;
  return { x: cssW - insets.right - MINIMAP_MARGIN - size, y: insets.top + MINIMAP_MARGIN, size };
}

/** A world position on the minimap, CSS px, into `out`. */
export function toMinimap(m: MinimapLayout, wx: number, wy: number, out: { x: number; y: number }): void {
  out.x = m.x + (wx / WORLD_W) * m.size;
  out.y = m.y + (wy / WORLD_H) * m.size;
}
