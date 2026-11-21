import { afterEach, beforeEach, expect, test } from "bun:test";
import { TEAMS } from "../server/rules";
import { forgetPlayerForTests, loadPlayer, nextScreen, noteArenaRefusedName, setPlayerName, setPlayerTeam, takeArenaRefusedName, takeRefusedName } from "./player";

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

test("the next screen: every page load opens on the start screen; between runs, setup only until there is a name and a team", () => {
  const id = "0123456789abcdef0123456789abcdef";
  // Opening the page: the start screen for everyone, a returning player too ("Play as").
  expect(nextScreen({ id, name: null, team: null }, false, true)).toBe("setup");
  expect(nextScreen({ id, name: "Old Timer", team: TEAMS[0] }, false, true)).toBe("setup");
  expect(nextScreen({ id, name: null, team: null }, true, true)).toBe("play"); // a stress run needs neither
  // Between runs in the same page ("Play again"):
  expect(nextScreen({ id, name: null, team: null }, false, false)).toBe("setup");
  expect(nextScreen({ id, name: "Old Timer", team: null }, false, false)).toBe("setup"); // the one-time team ask
  expect(nextScreen({ id, name: "Old Timer", team: TEAMS[0] }, false, false)).toBe("play");
  expect(nextScreen({ id, name: null, team: TEAMS[0] }, false, false)).toBe("setup"); // a refused name keeps the team
  expect(nextScreen({ id, name: null, team: null }, true, false)).toBe("play");
  // Once the team is stored, every later run in the page plays straight away.
  store.set("bugswarm.player", JSON.stringify({ id, name: "Old Timer" }));
  expect(nextScreen(loadPlayer(), false, false)).toBe("setup");
  setPlayerTeam(TEAMS[1]);
  forgetPlayerForTests();
  expect(nextScreen(loadPlayer(), false, false)).toBe("play");
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

test("the arena's refusal is noted for the next page once, and keeps the stored name", () => {
  const session = new Map<string, string>();
  globalThis.sessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  } as Storage;
  try {
    store.set("bugswarm.player", JSON.stringify({ id: "0123456789abcdef0123456789abcdef", name: "bot alice", team: TEAMS[1] }));
    noteArenaRefusedName("bot alice");
    forgetPlayerForTests(); // the redirect is a new page load
    expect(loadPlayer().name).toBe("bot alice"); // `/` still accepts it
    expect(takeArenaRefusedName()).toBe("bot alice");
    expect(takeArenaRefusedName()).toBeNull();
  } finally {
    // @ts-expect-error: bun has no sessionStorage of its own
    delete globalThis.sessionStorage;
  }
  expect(takeArenaRefusedName()).toBeNull(); // no storage at all: nothing to say
});
