// Held keys (KeyboardEvent.code, so it follows key position on any layout) to a move direction.
const LEFT = ["KeyA", "ArrowLeft"];
const RIGHT = ["KeyD", "ArrowRight"];
const UP = ["KeyW", "ArrowUp"];
const DOWN = ["KeyS", "ArrowDown"];
export const STEERING_KEYS: ReadonlySet<string> = new Set([...LEFT, ...RIGHT, ...UP, ...DOWN]);

/** A direction from the held keys (each of dx, dy is -1, 0 or 1), or none (none held, or opposites cancel). */
export type KeyMove = { kind: "none" } | { kind: "direction"; dx: number; dy: number };

export function keysToInput(pressed: ReadonlySet<string>): KeyMove {
  const any = (codes: string[]) => (codes.some((c) => pressed.has(c)) ? 1 : 0);
  const dx = any(RIGHT) - any(LEFT);
  const dy = any(DOWN) - any(UP);
  return dx === 0 && dy === 0 ? { kind: "none" } : { kind: "direction", dx, dy };
}

/** Toggles the frame-rate readout (fps, bugs on screen, effects alive). Desktop: it needs a keyboard. */
export const STATS_KEY = "KeyF";
