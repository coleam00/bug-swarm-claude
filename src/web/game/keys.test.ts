import { expect, test } from "bun:test";
import { CHOICE_CARDS } from "./config";
import { CHOICE_KEYS, STATS_KEY, STEERING_KEYS, keysToInput } from "./keys";

test("WASD and arrows steer; opposite keys cancel", () => {
  expect(keysToInput(new Set())).toEqual({ kind: "none" });
  expect(keysToInput(new Set(["KeyW"]))).toEqual({ kind: "direction", dx: 0, dy: -1 });
  expect(keysToInput(new Set(["ArrowDown"]))).toEqual({ kind: "direction", dx: 0, dy: 1 });
  expect(keysToInput(new Set(["KeyA", "ArrowUp"]))).toEqual({ kind: "direction", dx: -1, dy: -1 });
  expect(keysToInput(new Set(["ArrowRight", "KeyS"]))).toEqual({ kind: "direction", dx: 1, dy: 1 });
  expect(keysToInput(new Set(["KeyA", "KeyD"]))).toEqual({ kind: "none" });
  expect(keysToInput(new Set(["KeyQ"]))).toEqual({ kind: "none" });
});

test("1-3 on the digit row or the numpad pick a card, and none of them steers", () => {
  expect(CHOICE_KEYS.get("Digit1")).toBe(0);
  expect(CHOICE_KEYS.get("Digit2")).toBe(1);
  expect(CHOICE_KEYS.get("Digit3")).toBe(2);
  expect(CHOICE_KEYS.get("Numpad1")).toBe(0);
  expect(CHOICE_KEYS.get("Numpad3")).toBe(2);
  expect(CHOICE_KEYS.has("Digit4")).toBe(false);
  for (const [code, card] of CHOICE_KEYS) {
    expect(card).toBeLessThan(CHOICE_CARDS);
    expect(STEERING_KEYS.has(code)).toBe(false);
  }
});

test("F toggles the readout, and neither steers nor picks a card", () => {
  expect(STATS_KEY).toBe("KeyF");
  expect(STEERING_KEYS.has(STATS_KEY)).toBe(false);
  expect(CHOICE_KEYS.has(STATS_KEY)).toBe(false);
});
