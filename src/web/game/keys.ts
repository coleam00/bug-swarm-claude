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
