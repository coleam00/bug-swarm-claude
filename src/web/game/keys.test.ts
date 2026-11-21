import { expect, test } from "bun:test";
import { STATS_KEY, STEERING_KEYS, keysToInput } from "./keys";

test("WASD and arrows steer; opposite keys cancel", () => {
  expect(keysToInput(new Set())).toEqual({ kind: "none" });
  expect(keysToInput(new Set(["KeyW"]))).toEqual({ kind: "direction", dx: 0, dy: -1 });
  expect(keysToInput(new Set(["ArrowDown"]))).toEqual({ kind: "direction", dx: 0, dy: 1 });
  expect(keysToInput(new Set(["KeyA", "ArrowUp"]))).toEqual({ kind: "direction", dx: -1, dy: -1 });
  expect(keysToInput(new Set(["ArrowRight", "KeyS"]))).toEqual({ kind: "direction", dx: 1, dy: 1 });
  expect(keysToInput(new Set(["KeyA", "KeyD"]))).toEqual({ kind: "none" });
  expect(keysToInput(new Set(["KeyQ"]))).toEqual({ kind: "none" });
});

test("F toggles the readout, and does not steer", () => {
  expect(STATS_KEY).toBe("KeyF");
  expect(STEERING_KEYS.has(STATS_KEY)).toBe(false);
});
