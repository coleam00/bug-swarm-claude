import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadPlayer, setPlayerName } from "./player";

// A stand-in for the browser's localStorage.
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
});
afterEach(() => {
  // @ts-expect-error: bun has no localStorage of its own
  delete globalThis.localStorage;
});

test("a return visit finds the stored id and name", () => {
  const first = setPlayerName("Robo");
  expect(first.id).toMatch(/^[0-9a-f]{32}$/);
  // What the next page load reads:
  expect(JSON.parse(store.get("bugswarm.player")!)).toEqual({ id: first.id, name: "Robo" });
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "Return Visit" }));
  expect(loadPlayer()).toEqual({ id: "0123456789abcdef0123456789abcdef", name: "Return Visit" });
});

test("a stored name that breaks the rules is dropped, so name entry asks again", () => {
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "sh1t" }));
  expect(loadPlayer()).toEqual({ id: "0123456789abcdef0123456789abcdef", name: null });
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "x" }));
  expect(loadPlayer().name).toBeNull();
});

test("a first visit gets a new random id and no name", () => {
  const a = loadPlayer();
  expect(a.name).toBeNull();
  expect(a.id).toMatch(/^[0-9a-f]{32}$/);
  store.clear();
  // memory keeps the id for this page when storage is empty or unavailable
  expect(loadPlayer().id).toBe(a.id);
});
