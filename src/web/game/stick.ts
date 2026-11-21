// A floating touch stick (the arena's move and aim sticks are two of these). Where the first finger
// lands is the centre; dragging away from it points that way, further for a longer drag, full at
// STICK_RANGE. A second finger is ignored until the first lifts. Coordinates are CSS px relative
// to the canvas, not arena units, so the stick feels the same at any scale. No DOM and no clock:
// src/web/arena/controls.ts feeds it pointer events and src/web/arena/render.ts draws it.

/** Drag distance for full speed, CSS px. */
export const STICK_RANGE = 60;
/** Inside this drag distance, CSS px, the robot stands still (a resting thumb jitters). */
export const STICK_DEAD = 6;

export type Stick = {
  /** The finger's pointer id; -1 when no finger is down. */
  id: number;
  active: boolean;
  /** The centre: where the finger landed. */
  cx: number;
  cy: number;
  /** Where the finger is now. */
  x: number;
  y: number;
};

/** A movement for the simulation: the "stick" Input, its length the fraction of full speed. */
export type StickOut = { kind: "stick"; dx: number; dy: number };

export function createStick(): Stick {
  return { id: -1, active: false, cx: 0, cy: 0, x: 0, y: 0 };
}

/** A finger lands. False, changing nothing, if another finger already holds the stick. */
export function stickDown(s: Stick, id: number, x: number, y: number): boolean {
  if (s.active) return false;
  s.active = true;
  s.id = id;
  s.cx = s.x = x;
  s.cy = s.y = y;
  return true;
}

/** The holding finger moves. False, changing nothing, for any other finger. */
export function stickMove(s: Stick, id: number, x: number, y: number): boolean {
  if (!s.active || id !== s.id) return false;
  s.x = x;
  s.y = y;
  return true;
}

/** The holding finger lifts. False, changing nothing, for any other finger. */
export function stickUp(s: Stick, id: number): boolean {
  if (!s.active || id !== s.id) return false;
  stickReset(s);
  return true;
}

/** Lets go whatever finger holds it (a card was picked, the window lost focus). */
export function stickReset(s: Stick): void {
  s.active = false;
  s.id = -1;
}

/**
 * Writes the movement into `out` and returns true, or returns false when the stick asks for none
 * (no finger, or inside the dead zone: a resting thumb is standing still, for the fire rate too).
 */
export function stickDrive(s: Stick, out: StickOut): boolean {
  if (!s.active) return false;
  const vx = s.x - s.cx;
  const vy = s.y - s.cy;
  const d = Math.hypot(vx, vy);
  if (d < STICK_DEAD) return false;
  const m = Math.min(d / STICK_RANGE, 1);
  out.dx = (vx / d) * m;
  out.dy = (vy / d) * m;
  return true;
}

/** Writes where to draw the knob into `out`: the finger, held within STICK_RANGE of the centre. */
export function stickKnob(s: Stick, out: { x: number; y: number }): void {
  const vx = s.x - s.cx;
  const vy = s.y - s.cy;
  const d = Math.hypot(vx, vy);
  const k = d > STICK_RANGE ? STICK_RANGE / d : 1;
  out.x = s.cx + vx * k;
  out.y = s.cy + vy * k;
}
