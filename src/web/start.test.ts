import { expect, test } from "bun:test";
import { TEAMS } from "../server/rules";
import {
  BOT_NAME_MESSAGE,
  playingLine,
  changeName,
  nameMessage,
  openingNotice,
  pressEnter,
  pressPlay,
  REVEAL_LAND_MS,
  REVEAL_MS,
  REVEAL_SHORT_MS,
  revealFrame,
  revealMs,
  showMessage,
  startView,
  typed,
  type StartView,
} from "./start";

const id = "0123456789abcdef0123456789abcdef";
const [TABS, SPACES] = TEAMS;
const REFUSED = nameMessage("blocked");

test("first visit: an empty name field and Play, no team, no message", () => {
  const view = startView({ id, name: null, team: null }, null);
  expect(view).toEqual({ kind: "entry", name: "", team: null, message: null });
});

test("first visit: Play with a good name starts with no team (the server picks); a bad name gets one short message", () => {
  const view = startView({ id, name: null, team: null }, null);
  expect(pressPlay(view, "  Robo   Cop ")).toEqual({ kind: "start", name: "Robo Cop", team: null });
  expect(pressPlay(view, "")).toEqual({ kind: "message", text: "2 to 16 characters" });
  expect(pressPlay(view, "a".repeat(17))).toEqual({ kind: "message", text: "2 to 16 characters" });
  expect(pressPlay(view, "a!")).toEqual({ kind: "message", text: "Letters, numbers, spaces, - and _" });
  expect(pressPlay(view, "sh1t")).toEqual({ kind: "message", text: "Pick a different name" });
  expect(pressPlay(view, "admin")).toEqual({ kind: "message", text: "Pick a different name" });
});

test("first visit: Enter does what Play does", () => {
  const view = startView({ id, name: null, team: null }, null);
  expect(pressEnter(view, "Robo")).toEqual({ kind: "start", name: "Robo", team: null });
  expect(pressEnter(view, "x")).toEqual({ kind: "message", text: "2 to 16 characters" });
});

test("the message shows after a bad attempt and typing clears it", () => {
  const view = startView({ id, name: null, team: null }, null);
  const shown = showMessage(view, "2 to 16 characters");
  expect(shown).toEqual({ kind: "entry", name: "", team: null, message: "2 to 16 characters" });
  expect(typed(shown)).toEqual(view);
  expect(typed(view)).toBe(view);
});

test("returning: one Play as button, and Enter or the button plays with the stored name and team", () => {
  const view = startView({ id, name: "Robo", team: SPACES }, null);
  expect(view).toEqual({ kind: "returning", name: "Robo", team: SPACES });
  expect(pressEnter(view, "")).toEqual({ kind: "start", name: "Robo", team: SPACES });
  expect(pressPlay(view, "")).toEqual({ kind: "start", name: "Robo", team: SPACES });
});

test("change name: the field comes back filled in, and Play keeps the player's team", () => {
  const returning = startView({ id, name: "Robo", team: SPACES }, null);
  const view = changeName(returning);
  expect(view).toEqual({ kind: "entry", name: "Robo", team: SPACES, message: null });
  expect(pressPlay(view, "Robo Two")).toEqual({ kind: "start", name: "Robo Two", team: SPACES });
  expect(pressEnter(view, "Robo Two")).toEqual({ kind: "start", name: "Robo Two", team: SPACES });
  expect(pressPlay(view, "Robo!")).toEqual({ kind: "message", text: "Letters, numbers, spaces, - and _" });
  expect(changeName(view)).toBe(view);
});

test("a player from before teams gets the field filled in and no team: the server picks", () => {
  const view = startView({ id, name: "Old Timer", team: null }, null);
  expect(view).toEqual({ kind: "entry", name: "Old Timer", team: null, message: null });
  expect(pressPlay(view, "Old Timer")).toEqual({ kind: "start", name: "Old Timer", team: null });
});

test("a stored name the rules now refuse: an empty field, the team kept, and the message shown", () => {
  const view: StartView = startView({ id, name: null, team: TABS }, REFUSED);
  expect(view).toEqual({ kind: "entry", name: "", team: TABS, message: "Pick a different name" });
  expect(pressEnter(view, "Robo")).toEqual({ kind: "start", name: "Robo", team: TABS });
});

test("a stored bot name: the name field, filled in, says why, instead of Play as", () => {
  const notice = openingNotice(false, "bot alice");
  expect(notice).toBe(BOT_NAME_MESSAGE);
  expect(startView({ id, name: "bot alice", team: SPACES }, notice)).toEqual({ kind: "entry", name: "bot alice", team: SPACES, message: BOT_NAME_MESSAGE });
  // A name the rules now refuse says so first; any other stored name says nothing.
  expect(openingNotice(true, "bot alice")).toBe(REFUSED);
  expect(openingNotice(false, "Robo")).toBeNull();
  expect(openingNotice(false, null)).toBeNull();
});

test("a bot name is refused before joining, by Play and by Enter", () => {
  const view = startView({ id, name: null, team: null }, null);
  expect(pressPlay(view, "bot alice")).toEqual({ kind: "message", text: BOT_NAME_MESSAGE });
  expect(pressPlay(view, "BOT  Bob")).toEqual({ kind: "message", text: BOT_NAME_MESSAGE });
  expect(pressEnter(view, "Bot carl")).toEqual({ kind: "message", text: BOT_NAME_MESSAGE });
  expect(pressEnter({ kind: "entry", name: "", team: TABS, message: null }, "bot dee")).toEqual({ kind: "message", text: BOT_NAME_MESSAGE });
  // Not a bot name: "bots-01", "Robot".
  expect(pressPlay(view, "bots-01")).toEqual({ kind: "start", name: "bots-01", team: null });
  expect(pressPlay(view, "Robot")).toEqual({ kind: "start", name: "Robot", team: null });
});

test("the reveal: 1.5 s for a new player, 0.6 s for one with a stored team", () => {
  expect(revealMs(null)).toBe(REVEAL_MS);
  expect(REVEAL_MS).toBe(1500);
  expect(revealMs(TABS)).toBe(REVEAL_SHORT_MS);
  expect(REVEAL_SHORT_MS).toBe(600);
});

test("the reveal flicks between the teams, slowing, then lands on the server's team", () => {
  const flicking = REVEAL_MS - REVEAL_LAND_MS;
  const shown: string[] = [];
  for (let t = 0; t < flicking; t += 5) shown.push(revealFrame(t, REVEAL_MS, SPACES).team);
  // Both teams show, back and forth, and nothing lands before the flicking is over.
  expect(new Set(shown)).toEqual(new Set(TEAMS));
  for (let t = 0; t < flicking; t += 5) expect(revealFrame(t, REVEAL_MS, SPACES).landed).toBe(false);
  // Each flick lasts at least as long as the one before.
  const runs: number[] = [];
  for (let i = 0; i < shown.length; i++) if (i === 0 || shown[i] !== shown[i - 1]) runs.push(1);
  else runs[runs.length - 1]!++;
  const whole = runs.slice(0, -1);
  for (let i = 1; i < whole.length; i++) expect(whole[i]!).toBeGreaterThanOrEqual(whole[i - 1]!);
  expect(whole.at(-1)!).toBeGreaterThan(whole[0]!);
  expect(revealFrame(flicking, REVEAL_MS, SPACES)).toEqual({ team: SPACES, landed: true });
  expect(revealFrame(flicking, REVEAL_MS, TABS)).toEqual({ team: TABS, landed: true });
});

test("the reveal keeps flicking until the welcome says the team, and the short one lands at once", () => {
  expect(revealFrame(REVEAL_MS + 800, REVEAL_MS, null).landed).toBe(false);
  expect(revealFrame(0, REVEAL_SHORT_MS, TABS)).toEqual({ team: TABS, landed: true });
  expect(revealFrame(0, REVEAL_SHORT_MS, null).landed).toBe(false);
});

test("the live line: people playing now, formatted like the board; nothing at none or when the read failed", () => {
  expect(playingLine(1)).toBe("1 playing now");
  expect(playingLine(1234)).toBe("1,234 playing now");
  expect(playingLine(0)).toBe("");
  expect(playingLine(null)).toBe("");
});
