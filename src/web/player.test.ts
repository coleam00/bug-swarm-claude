import { afterEach, beforeEach, expect, test } from "bun:test";
import { TEAMS } from "../server/rules";
import { forgetPlayerForTests, loadPlayer, markUpdateReload, setPlayerName, setPlayerTeam, takeRefusedName, takeUpdateReload } from "./player";

// A stand-in for the browser's localStorage.
let store: Map<string, string>;
beforeEach(() => {
  forgetPlayerForTests(); // each test is a fresh page load
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

test("a return visit finds the stored id, name and team", () => {
  setPlayerName("Robo");
  const first = setPlayerTeam(TEAMS[1]);
  expect(first.id).toMatch(/^[0-9a-f]{32}$/);
  // What the next page load reads:
  expect(JSON.parse(store.get("bugswarm.player")!)).toEqual({ id: first.id, name: "Robo", team: TEAMS[1] });
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "Return Visit", team: TEAMS[0] }));
  expect(loadPlayer()).toEqual({ id: "0123456789abcdef0123456789abcdef", name: "Return Visit", team: TEAMS[0] });
});

test("a player stored before teams loads with no team; a stored team that isn't one is dropped", () => {
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "Old Timer" }));
  expect(loadPlayer()).toEqual({ id: "0123456789abcdef0123456789abcdef", name: "Old Timer", team: null });
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "Old Timer", team: "Tabs" }));
  expect(loadPlayer().team).toBeNull();
});

test("a stored name that breaks the rules is dropped, so name entry asks again", () => {
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "sh1t" }));
  expect(loadPlayer()).toEqual({ id: "0123456789abcdef0123456789abcdef", name: null, team: null });
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "x" }));
  expect(loadPlayer().name).toBeNull();
});

test("a dropped stored name is reported once, so name entry can say why it asks again", () => {
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "sh1t" }));
  loadPlayer();
  loadPlayer(); // the name is gone from storage now; the report stays until it is taken
  expect(takeRefusedName()).toBe("sh1t");
  expect(takeRefusedName()).toBeNull();
  store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "Robo" }));
  loadPlayer();
  expect(takeRefusedName()).toBeNull();
});

test("a first visit gets a new random id and no name", () => {
  const a = loadPlayer();
  expect(a.name).toBeNull();
  expect(a.id).toMatch(/^[0-9a-f]{32}$/);
  forgetPlayerForTests();
  store.clear();
  expect(loadPlayer().id).not.toBe(a.id); // another browser: another id
});

test("with storage unavailable, the player lasts for the page in memory", () => {
  const a = setPlayerName("Robo");
  store.clear(); // storage lost (private mode, blocked storage)
  expect(loadPlayer()).toEqual({ id: a.id, name: "Robo", team: null });
});

test("an update reload is marked for the next page load only, and only in this tab's session storage", () => {
  const session = new Map<string, string>();
  globalThis.sessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  } as Storage;
  expect(takeUpdateReload()).toBe(false);
  markUpdateReload();
  expect(store.size).toBe(0);
  expect(takeUpdateReload()).toBe(true);
  // A later manual reload opens on the start screen again.
  expect(takeUpdateReload()).toBe(false);
});
