// The view area, in world units: the same area on every screen, so a phone sees as much of the
// arena as a desktop, in the screen's aspect ratio clamped between 9:16 and 16:9, so a phone in
// portrait or landscape plays across its screen rather than in a strip. The arena's camera
// (src/web/arena/camera.ts) and the start screen's backdrop size their view with it.
import { ARENA_AREA, ARENA_RATIO_MAX, ARENA_RATIO_MIN } from "./config";

export type Arena = { w: number; h: number };

export function arenaForViewport(cssW: number, cssH: number): Arena {
  const ratio = Math.min(Math.max(Math.max(1, cssW) / Math.max(1, cssH), ARENA_RATIO_MIN), ARENA_RATIO_MAX);
  return { w: Math.round(Math.sqrt(ARENA_AREA * ratio)), h: Math.round(Math.sqrt(ARENA_AREA / ratio)) };
}
