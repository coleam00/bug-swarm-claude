// The arena, in game units. Every arena has the same area, so a run is as crowded on a phone as
// on a desktop, and takes the screen's aspect ratio, clamped between 9:16 and 16:9, so a phone
// in portrait or landscape plays across its screen rather than in a strip. It is fixed for a run; a resize during the run only
// rescales and letterboxes it.
import { ARENA_AREA, ARENA_RATIO_MAX, ARENA_RATIO_MIN } from "./config";

export type Arena = { w: number; h: number };

export function arenaForViewport(cssW: number, cssH: number): Arena {
  const ratio = Math.min(Math.max(Math.max(1, cssW) / Math.max(1, cssH), ARENA_RATIO_MIN), ARENA_RATIO_MAX);
  return { w: Math.round(Math.sqrt(ARENA_AREA * ratio)), h: Math.round(Math.sqrt(ARENA_AREA / ratio)) };
}
