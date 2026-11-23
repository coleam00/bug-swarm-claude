// The start screen's state, without the DOM: which view a player gets, and what each button and
// Enter does. App.tsx renders it; a "start" press joins an arena. A returning player (a name and a team) gets one "Play as"
// button; anyone else, or a returning player who taps "change name", gets the name field and the
// team buttons. A player's team is stored once and never switched (architecture.md, Data), so
// once they have one, the other team's button is shown but locked.
import { NAME_MAX, NAME_MIN, TEAMS, checkName, isBotName, type NameCheck, type Team } from "../server/rules";
import { formatScore } from "./board/data";
import type { Player } from "./player";

export type StartView =
  | { kind: "returning"; name: string; team: Team }
  | { kind: "entry"; name: string; team: Team | null; message: string | null };

/** What a press does: start a run as `name` on `team`, show one short message, or move focus to a team button. */
export type Press = { kind: "start"; name: string; team: Team } | { kind: "message"; text: string } | { kind: "focus"; team: Team };

export type NameRefusal = Extract<NameCheck, { ok: false }>["reason"];

/** The one short line shown under the name field for each refusal. */
export function nameMessage(reason: NameRefusal): string {
  if (reason === "length") return `${NAME_MIN} to ${NAME_MAX} characters`;
  if (reason === "characters") return "Letters, numbers, spaces, - and _";
  return "Pick a different name";
}

/** Why a name whose first word reads "bot" ("Bot", "b0t x", "bot_x") can't play: the arena keeps them for its bots (rules.ts isBotName). */
export const BOT_NAME_MESSAGE = `Names starting with the word "bot" are kept for the arena's bots`;

/**
 * The message to show on opening the page, or null: the stored name the rules now refuse
 * (`refusedNow`, player.ts takeRefusedName), else a stored "bot ..." name (kept from before the
 * arena refused them), which has to change before it can play.
 */
export function openingNotice(refusedNow: boolean, storedName: string | null): string | null {
  if (refusedNow) return nameMessage("blocked");
  return storedName !== null && isBotName(storedName) ? BOT_NAME_MESSAGE : null;
}

/** The view on opening the page. `notice` is a message to show at once (a stored name now refused). */
export function startView(player: Player, notice: string | null): StartView {
  if (player.name !== null && player.team !== null && notice === null) return { kind: "returning", name: player.name, team: player.team };
  return { kind: "entry", name: player.name ?? "", team: player.team, message: notice };
}

/** "change name": the name field and team buttons, filled in with the player's name and team. */
export function changeName(view: StartView): StartView {
  return view.kind === "returning" ? { kind: "entry", name: view.name, team: view.team, message: null } : view;
}

/** The view with `text` shown under the field. */
export function showMessage(view: StartView, text: string): StartView {
  return view.kind === "entry" ? { ...view, message: text } : view;
}

/** Typing in the field clears the message. */
export function typed(view: StartView): StartView {
  return view.kind === "entry" && view.message !== null ? { ...view, message: null } : view;
}

/** Whether `team`'s button is locked: the player already has the other team. */
export function teamLocked(view: StartView, team: Team): boolean {
  return view.kind === "entry" && view.team !== null && view.team !== team;
}

/** A team button pressed with `raw` in the name field. */
export function pressTeam(view: StartView, raw: string, team: Team): Press {
  if (view.kind === "returning") return { kind: "start", name: view.name, team: view.team };
  if (view.team !== null && view.team !== team) return { kind: "focus", team: view.team };
  const checked = checkName(raw);
  if (!checked.ok) return { kind: "message", text: nameMessage(checked.reason) };
  if (isBotName(checked.name)) return { kind: "message", text: BOT_NAME_MESSAGE };
  return { kind: "start", name: checked.name, team };
}

/**
 * Enter. On "Play as" it plays. In the name field it checks the name: a bad one shows its
 * message; a good one starts at once when the team is already known, else moves focus to the
 * first team button so the next Enter joins it. Nothing is guessed.
 */
export function pressEnter(view: StartView, raw: string): Press {
  if (view.kind === "returning") return { kind: "start", name: view.name, team: view.team };
  const checked = checkName(raw);
  if (!checked.ok) return { kind: "message", text: nameMessage(checked.reason) };
  if (isBotName(checked.name)) return { kind: "message", text: BOT_NAME_MESSAGE };
  if (view.team !== null) return { kind: "start", name: checked.name, team: view.team };
  return { kind: "focus", team: TEAMS[0] };
}

/**
 * The live line under the title (#79): people playing now, as the board counts them (never
 * bots), formatted like the board. Empty with nobody playing, or when the read failed (null).
 */
export function playingLine(playing: number | null): string {
  return playing !== null && playing >= 1 ? `${formatScore(playing)} playing now` : "";
}
