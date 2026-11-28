import { afterEach, beforeEach, expect, test } from "bun:test";
import { HINT_LIVES, HINT_MS, forgetHintForTests, hintLines, takeHintLife } from "./hint";

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

const takeMany = (n: number) => Array.from({ length: n }, () => takeHintLife());

test("the card shows on a browser's first 3 lives, for 10 s each, and the 4th shows none", () => {
  expect(HINT_LIVES).toBe(3);
  expect(HINT_MS).toBe(10000);
  expect(takeMany(5)).toEqual([true, true, true, false, false]);
});

test("the count is kept across page loads, and stays spent after the 3rd", () => {
  expect(takeHintLife()).toBe(true);
  forgetHintForTests(); // a reload, same browser storage
  expect(takeMany(3)).toEqual([true, true, false]);
  forgetHintForTests();
  expect(takeHintLife()).toBe(false);
  expect(store.get("bugswarm.arenaHintLives")).toBe("3");
});

test("players who saw release 1's hint or #64's one-line hint still get all 3 cards", () => {
  store.set("bugswarm.hinted", "1");
  store.set("bugswarm.arenaHinted", "1");
  expect(takeMany(4)).toEqual([true, true, true, false]);
});

test("a garbage stored count counts as none", () => {
  store.set("bugswarm.arenaHintLives", "abc");
  expect(takeMany(4)).toEqual([true, true, true, false]);
});

test("with storage blocked the card shows on 3 lives of this page, then not again", () => {
  const blocked = () => {
    throw new Error("SecurityError");
  };
  stubStorage({ getItem: blocked, setItem: blocked });
  expect(takeMany(4)).toEqual([true, true, true, false]);
});

test("touch and desktop each get their own lines, both with dash and revive", () => {
  expect(hintLines(false)).toEqual(["WASD move", "Mouse aim, hold to fire", "Space / right-click: dash", "Stand by a downed player to revive"]);
  expect(hintLines(true)).toEqual(["Left thumb: move", "Right thumb: aim + fire", "DASH button: dodge", "Stand by a downed player to revive"]);
  for (const coarse of [false, true]) {
    expect(hintLines(coarse).some((l) => /dash/i.test(l))).toBe(true);
    expect(hintLines(coarse).some((l) => /revive/i.test(l))).toBe(true);
  }
});
