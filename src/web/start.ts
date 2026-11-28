// The start screen's state, without the DOM: which view a player gets, what Play and Enter do, and
// the team reveal's frames. App.tsx renders it; a "start" press joins an arena. A returning player
// (a name and a team) gets one "Play as" button; anyone else, or a returning player who taps
// "change name", gets the name field and one Play button. The server assigns the team (#131): a
// player who has one keeps it (architecture.md, Data), a new one gets the side with fewer people
// playing, and the reveal shows which.
import { NAME_MAX, NAME_MIN, TEAMS, checkName, isBotName, type NameCheck, type Team } from "../server/rules";
import { formatScore } from "./board/data";
import type { Player } from "./player";

export type StartView =
  | { kind: "returning"; name: string; team: Team }
  | { kind: "entry"; name: string; team: Team | null; message: string | null };

/** What a press does: start a run as `name` (with the stored team, or null for the server to pick), or show one short message. */
export type Press = { kind: "start"; name: string; team: Team | null } | { kind: "message"; text: string };

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

/** "change name": the name field and Play, filled in with the player's name and team. */
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

/**
 * Play, or Enter. On "Play as" it plays. In the name field it checks the name: a bad one shows its
 * message, a good one starts with the stored team (null for a new player: the server picks).
 */
export function pressPlay(view: StartView, raw: string): Press {
  if (view.kind === "returning") return { kind: "start", name: view.name, team: view.team };
  const checked = checkName(raw);
  if (!checked.ok) return { kind: "message", text: nameMessage(checked.reason) };
  if (isBotName(checked.name)) return { kind: "message", text: BOT_NAME_MESSAGE };
  return { kind: "start", name: checked.name, team: view.team };
}

/** Enter does what Play does. */
export const pressEnter = pressPlay;

// The team reveal (#131): after Play, "TABS" and "SPACES" flick back and forth, slowing, then land
// on the team the server's welcome named, which holds for REVEAL_LAND_MS with a burst.

/** A new player's whole reveal, ms: REVEAL_MS - REVEAL_LAND_MS of flicking, then the landing. */
export const REVEAL_MS = 1500;
/** A player with a stored team (or one who asked for reduced motion): it lands at once, ms. */
export const REVEAL_SHORT_MS = 600;
/** How long the landed team holds before the reveal leaves, ms (the short one holds it all). */
export const REVEAL_LAND_MS = 500;
/** With no welcome by then (busy, limits, a slow network) the reveal leaves anyway, ms: the status shows. */
export const REVEAL_GIVE_UP_MS = 4000;
/** The first flick's length, ms; each next one is REVEAL_SLOW times longer, up to REVEAL_FLICK_MAX_MS. */
const REVEAL_FLICK_MS = 55;
const REVEAL_SLOW = 1.22;
const REVEAL_FLICK_MAX_MS = 260;

/** The reveal's length for a player whose stored team is `stored` (null: a new player). */
export function revealMs(stored: Team | null): number {
  return stored === null ? REVEAL_MS : REVEAL_SHORT_MS;
}

/**
 * The reveal at `elapsed` ms of a reveal `total` ms long: the team on screen and whether it has
 * landed. It lands once the flicking is over and the server's team (`landed`) is known; until
 * then it keeps flicking, slower and slower.
 */
export function revealFrame(elapsed: number, total: number, landed: Team | null): { team: Team; landed: boolean } {
  const flicking = Math.max(0, total - REVEAL_LAND_MS);
  if (landed !== null && (total <= REVEAL_SHORT_MS || elapsed >= flicking)) return { team: landed, landed: true };
  let flick = REVEAL_FLICK_MS;
  let at = 0;
  let i = 0;
  while (at + flick <= elapsed) {
    at += flick;
    flick = Math.min(REVEAL_FLICK_MAX_MS, flick * REVEAL_SLOW);
    i++;
  }
  return { team: TEAMS[i % TEAMS.length]!, landed: false };
}

/**
 * The live line under the title (#79): people playing now, as the board counts them (never
 * bots), formatted like the board. Empty with nobody playing, or when the read failed (null).
 */
export function playingLine(playing: number | null): string {
  return playing !== null && playing >= 1 ? `${formatScore(playing)} playing now` : "";
}
