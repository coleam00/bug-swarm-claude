import type { Input } from "./sim";

// Held keys (KeyboardEvent.code, so it follows key position on any layout) to a steering input.
const LEFT = ["KeyA", "ArrowLeft"];
const RIGHT = ["KeyD", "ArrowRight"];
const UP = ["KeyW", "ArrowUp"];
const DOWN = ["KeyS", "ArrowDown"];
export const STEERING_KEYS: ReadonlySet<string> = new Set([...LEFT, ...RIGHT, ...UP, ...DOWN]);

export function keysToInput(pressed: ReadonlySet<string>): Input {
  const any = (codes: string[]) => (codes.some((c) => pressed.has(c)) ? 1 : 0);
  const dx = any(RIGHT) - any(LEFT);
  const dy = any(DOWN) - any(UP);
  return dx === 0 && dy === 0 ? { kind: "none" } : { kind: "direction", dx, dy };
}

/** Keys that pick card 1 to 3 of an upgrade choice: the digit row and the numpad. */
export const CHOICE_KEYS: ReadonlyMap<string, number> = new Map([
  ["Digit1", 0],
  ["Digit2", 1],
  ["Digit3", 2],
  ["Numpad1", 0],
  ["Numpad2", 1],
  ["Numpad3", 2],
]);
