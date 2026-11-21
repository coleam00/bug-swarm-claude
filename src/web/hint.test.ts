import { afterEach, beforeEach, expect, test } from "bun:test";
import { HINT_MS, createHint, dismissHint, forgetHintForTests, hintLeft, hintText, takeFirstRun } from "./hint";

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
  expect(store.get("bugswarm.hinted")).toBe("1");
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

test("the hint is gone HINT_MS (4 s) after it shows", () => {
  expect(HINT_MS).toBe(4000);
  const h = createHint(1000);
  expect(hintLeft(h, 1000)).toBe(4000);
  expect(hintLeft(h, 4000)).toBe(1000);
  expect(hintLeft(h, 5000)).toBe(0);
  expect(hintLeft(h, 9000)).toBe(0);
});

test("the first movement dismisses the hint at once", () => {
  const h = createHint(0);
  dismissHint(h);
  expect(hintLeft(h, 0)).toBe(0);
  expect(hintLeft(h, 2000)).toBe(0);
});

test("touch and desktop each get their own text", () => {
  expect(hintText(true)).toBe("Drag anywhere to move");
  expect(hintText(false)).toBe("WASD, arrows or mouse");
});
