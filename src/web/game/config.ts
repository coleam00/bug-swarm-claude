// The sizes release 1's drawing kept for the arena and the start screen's backdrop: the robot, the
// bug looks and the view area. Distances are arena units. The arena's own tuning numbers live in
// src/shared/arena/constants.ts. The camera (arena.ts), the looks (look.ts), the sprites
// (sprites.ts), the backdrop and the server's icons (src/server/art.ts) import from here.

// The view: the same area on every screen, in the screen's ratio between 9:16 and 16:9.
export const ARENA_AREA = 360_000;
/** Width over height: the tallest view (9:16) and the widest (16:9). */
export const ARENA_RATIO_MIN = 9 / 16;
export const ARENA_RATIO_MAX = 16 / 9;

/** The robot's radius, as release 1 drew it (the sprites and icons are built at this size). */
export const ROBOT_RADIUS = 14;

/** A bug look: its id (look.ts gives each its colours and legs) and its radius. */
export type BugKind = { id: string; radius: number };

/** Every bug look. The first is the base look; the arena's crawler wears it. */
export const BUG_KINDS = [
  { id: "base", radius: 12 },
  // Small and quick (the backdrop's second kind).
  { id: "fast", radius: 8 },
] as const satisfies readonly BugKind[];
