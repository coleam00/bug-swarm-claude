// The arena, in game units. Every arena has the same area, so a run is as crowded on a phone as
// on a desktop, and takes the screen's aspect ratio, clamped between 9:16 and 16:9, so a phone
// in portrait or landscape fills its screen. It is fixed for a run; a resize during the run only
// rescales and letterboxes it.
export type Arena = { w: number; h: number };

export const ARENA_AREA = 360_000;
/** Width over height: the tallest arena (9:16) and the widest (16:9). */
export const ARENA_RATIO_MIN = 9 / 16;
export const ARENA_RATIO_MAX = 16 / 9;

export function arenaForViewport(cssW: number, cssH: number): Arena {
  const ratio = Math.min(Math.max(Math.max(1, cssW) / Math.max(1, cssH), ARENA_RATIO_MIN), ARENA_RATIO_MAX);
  return { w: Math.round(Math.sqrt(ARENA_AREA * ratio)), h: Math.round(Math.sqrt(ARENA_AREA / ratio)) };
}
