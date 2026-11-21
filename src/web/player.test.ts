import { afterEach, beforeEach, expect, test } from "bun:test";
import { TEAMS } from "../server/rules";
import { forgetPlayerForTests, loadPlayer, nextScreen, setPlayerName, setPlayerTeam, takeRefusedName } from "./player";

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

test("the next screen: setup until there is a name and a team, so a player from before teams is asked once", () => {
  const id = "0123456789abcdef0123456789abcdef";
  expect(nextScreen({ id, name: null, team: null }, false)).toBe("setup"); // first visit: name and team
  expect(nextScreen({ id, name: "Old Timer", team: null }, false)).toBe("setup"); // the one-time team ask
  expect(nextScreen({ id, name: "Old Timer", team: TEAMS[0] }, false)).toBe("play");
  expect(nextScreen({ id, name: null, team: TEAMS[0] }, false)).toBe("setup"); // a refused name keeps the team
  expect(nextScreen({ id, name: null, team: null }, true)).toBe("play"); // a stress run needs neither
  // Once the team is stored, every later visit plays straight away.
  store.set("bugswarm.player", JSON.stringify({ id, name: "Old Timer" }));
  expect(nextScreen(loadPlayer(), false)).toBe("setup");
  setPlayerTeam(TEAMS[1]);
  forgetPlayerForTests();
  expect(nextScreen(loadPlayer(), false)).toBe("play");
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
