import { afterEach, beforeEach, expect, test } from "bun:test";
import { forgetHintForTests, hintText, takeFirstLife } from "./hint";

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

test("the hint shows on a browser's first life only, then never, across loads", () => {
  expect(takeFirstLife()).toBe(true);
  expect(takeFirstLife()).toBe(false); // the next life on this page
  forgetHintForTests(); // a reload, same browser storage
  expect(takeFirstLife()).toBe(false);
  forgetHintForTests();
  expect(takeFirstLife()).toBe(false);
});

test("a release 1 player, who already has release 1's hint key, still gets the arena hint once", () => {
  store.set("bugswarm.hinted", "1");
  expect(takeFirstLife()).toBe(true);
  expect(takeFirstLife()).toBe(false);
});

test("with storage blocked the hint shows once, then not again on this page", () => {
  const blocked = () => {
    throw new Error("SecurityError");
  };
  stubStorage({ getItem: blocked, setItem: blocked });
  expect(takeFirstLife()).toBe(true);
  expect(takeFirstLife()).toBe(false);
});

test("touch and desktop each get their own text", () => {
  expect(hintText(true)).toBe("left thumb moves · right thumb aims and fires");
  expect(hintText(false)).toBe("WASD move · mouse aim · hold to fire · Space dash");
});
