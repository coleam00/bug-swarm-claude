// The arena, in game units. The short side is always 600 units and the long side follows the
// screen's shape up to 1100, so portrait and landscape both fill the screen. It is fixed for a
// run; a resize during the run only rescales and letterboxes it.
export type Arena = { w: number; h: number };

export const ARENA_SHORT = 600;
export const ARENA_LONG_MAX = 1100;

export function arenaForViewport(cssW: number, cssH: number): Arena {
  const w = Math.max(1, cssW);
  const h = Math.max(1, cssH);
  if (w >= h) return { w: Math.min(Math.round((ARENA_SHORT * w) / h), ARENA_LONG_MAX), h: ARENA_SHORT };
  return { w: ARENA_SHORT, h: Math.min(Math.round((ARENA_SHORT * h) / w), ARENA_LONG_MAX) };
}
