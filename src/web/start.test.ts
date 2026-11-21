import { expect, test } from "bun:test";
import { TEAMS } from "../server/rules";
import { BOT_NAME_MESSAGE, changeName, nameMessage, openingNotice, pressEnter, pressTeam, showMessage, startView, teamLocked, typed, type StartView } from "./start";

const id = "0123456789abcdef0123456789abcdef";
const [TABS, SPACES] = TEAMS;
const REFUSED = nameMessage("blocked");

test("first visit: an empty name field, both team buttons, no message", () => {
  const view = startView({ id, name: null, team: null }, null);
  expect(view).toEqual({ kind: "entry", name: "", team: null, message: null });
  expect(teamLocked(view, TABS)).toBe(false);
  expect(teamLocked(view, SPACES)).toBe(false);
});

test("first visit: a team button with a good name starts as that team; a bad name gets one short message", () => {
  const view = startView({ id, name: null, team: null }, null);
  expect(pressTeam(view, "  Robo   Cop ", SPACES)).toEqual({ kind: "start", name: "Robo Cop", team: SPACES });
  expect(pressTeam(view, "Robo", TABS)).toEqual({ kind: "start", name: "Robo", team: TABS });
  expect(pressTeam(view, "", TABS)).toEqual({ kind: "message", text: "2 to 16 characters" });
  expect(pressTeam(view, "a".repeat(17), TABS)).toEqual({ kind: "message", text: "2 to 16 characters" });
  expect(pressTeam(view, "a!", TABS)).toEqual({ kind: "message", text: "Letters, numbers, spaces, - and _" });
  expect(pressTeam(view, "sh1t", SPACES)).toEqual({ kind: "message", text: "Pick a different name" });
  expect(pressTeam(view, "admin", SPACES)).toEqual({ kind: "message", text: "Pick a different name" });
});

test("first visit: Enter with a good name moves to the first team button, and guesses no team", () => {
  const view = startView({ id, name: null, team: null }, null);
  expect(pressEnter(view, "Robo")).toEqual({ kind: "focus", team: TABS });
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
  expect(teamLocked(view, TABS)).toBe(false);
});

test("change name: the field and team buttons come back filled in, and only the player's own team can be pressed", () => {
  const returning = startView({ id, name: "Robo", team: SPACES }, null);
  const view = changeName(returning);
  expect(view).toEqual({ kind: "entry", name: "Robo", team: SPACES, message: null });
  expect(teamLocked(view, TABS)).toBe(true);
  expect(teamLocked(view, SPACES)).toBe(false);
  expect(pressTeam(view, "Robo Two", SPACES)).toEqual({ kind: "start", name: "Robo Two", team: SPACES });
  expect(pressEnter(view, "Robo Two")).toEqual({ kind: "start", name: "Robo Two", team: SPACES });
  expect(pressTeam(view, "Robo Two", TABS)).toEqual({ kind: "focus", team: SPACES });
  expect(pressTeam(view, "Robo!", SPACES)).toEqual({ kind: "message", text: "Letters, numbers, spaces, - and _" });
  expect(changeName(view)).toBe(view);
});

test("a player from before teams gets the field filled in and both teams", () => {
  const view = startView({ id, name: "Old Timer", team: null }, null);
  expect(view).toEqual({ kind: "entry", name: "Old Timer", team: null, message: null });
  expect(teamLocked(view, TABS)).toBe(false);
  expect(teamLocked(view, SPACES)).toBe(false);
  expect(pressTeam(view, "Old Timer", TABS)).toEqual({ kind: "start", name: "Old Timer", team: TABS });
});

test("a stored name the rules now refuse: an empty field, the team kept, and the message shown", () => {
  const view: StartView = startView({ id, name: null, team: TABS }, REFUSED);
  expect(view).toEqual({ kind: "entry", name: "", team: TABS, message: "Pick a different name" });
  expect(teamLocked(view, SPACES)).toBe(true);
  expect(pressEnter(view, "Robo")).toEqual({ kind: "start", name: "Robo", team: TABS });
});

test("sent back by the arena for a bot name: the name field, filled in, says why", () => {
  const notice = openingNotice(false, "bot alice");
  expect(notice).toBe(BOT_NAME_MESSAGE);
  expect(startView({ id, name: "bot alice", team: SPACES }, notice)).toEqual({ kind: "entry", name: "bot alice", team: SPACES, message: BOT_NAME_MESSAGE });
  // A name the rules now refuse says so first; any other arena refusal asks for a different name.
  expect(openingNotice(true, "bot alice")).toBe(REFUSED);
  expect(openingNotice(false, "Robo")).toBe(REFUSED);
  expect(openingNotice(false, null)).toBeNull();
});
