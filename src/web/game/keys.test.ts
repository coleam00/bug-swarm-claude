import { expect, test } from "bun:test";
import { keysToInput } from "./keys";

test("WASD and arrows steer; opposite keys cancel", () => {
  expect(keysToInput(new Set())).toEqual({ kind: "none" });
  expect(keysToInput(new Set(["KeyW"]))).toEqual({ kind: "direction", dx: 0, dy: -1 });
  expect(keysToInput(new Set(["ArrowDown"]))).toEqual({ kind: "direction", dx: 0, dy: 1 });
  expect(keysToInput(new Set(["KeyA", "ArrowUp"]))).toEqual({ kind: "direction", dx: -1, dy: -1 });
  expect(keysToInput(new Set(["ArrowRight", "KeyS"]))).toEqual({ kind: "direction", dx: 1, dy: 1 });
  expect(keysToInput(new Set(["KeyA", "KeyD"]))).toEqual({ kind: "none" });
  expect(keysToInput(new Set(["KeyQ"]))).toEqual({ kind: "none" });
});
