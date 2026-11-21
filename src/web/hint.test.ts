import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSteerLatch, firstSteer, forgetHintForTests, hintText, takeFirstRun } from "./hint";
import { keysToInput } from "./game/keys";

// A stand-in for the browser's localStorage.
let store: Map<string, string>;
const stubStorage = (s: Partial<Storage>) => {
  globalThis.localStorage = s as Storage;
};
beforeEach(() => {
  forgetHintForTests(); // each test is a fresh page load
  store = new Map();
  stubStorage({
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => {
  // @ts-expect-error: bun has no localStorage of its own
  delete globalThis.localStorage;
});

test("the hint shows on a browser's first run only, also after a reload", () => {
  expect(takeFirstRun()).toBe(true);
  expect(takeFirstRun()).toBe(false); // the next run on this page
  forgetHintForTests(); // a reload, same browser storage
  expect(takeFirstRun()).toBe(false);
});

test("with storage blocked the hint shows once, then not again on this page", () => {
  const blocked = () => {
    throw new Error("SecurityError");
  };
  stubStorage({ getItem: blocked, setItem: blocked });
  expect(takeFirstRun()).toBe(true);
  expect(takeFirstRun()).toBe(false);
  expect(takeFirstRun()).toBe(false);
});

test("the first steering input dismisses the hint, once; held opposing keys are no movement", () => {
  const latch = createSteerLatch();
  expect(firstSteer(latch, { kind: "none" })).toBe(false);
  expect(firstSteer(latch, keysToInput(new Set(["KeyA", "KeyD"])))).toBe(false); // A+D cancel out
  expect(firstSteer(latch, keysToInput(new Set(["KeyW"])))).toBe(true);
  expect(firstSteer(latch, keysToInput(new Set(["KeyW"])))).toBe(false); // only the first
  expect(firstSteer(latch, { kind: "stick", dx: 1, dy: 0 })).toBe(false);
});

test("a drag or the mouse counts as the first movement too", () => {
  expect(firstSteer(createSteerLatch(), { kind: "stick", dx: 0.5, dy: 0 })).toBe(true);
  expect(firstSteer(createSteerLatch(), { kind: "target", x: 10, y: 20 })).toBe(true);
});

test("touch and desktop each get their own text", () => {
  expect(hintText(true)).toBe("Drag anywhere to move");
  expect(hintText(false)).toBe("WASD, arrows or mouse");
});
