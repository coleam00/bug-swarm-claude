// Name rules and score plausibility. Pure: no bun:sqlite, node:* or Bun globals, because the
// browser imports this file too (name entry checks names before the server sees them, and
// the simulation scores with the same constants the server checks against).
import { BLOCKED_ANYWHERE, BLOCKED_WHOLE, EXCEPTIONS, RESERVED_NAMES } from "./blocked-words";

// Scoring, shared by the simulation and the server.
export const POINTS_PER_SQUASH = 10;
export const POINTS_PER_SECOND = 1;

// Plausibility. Phase 2 tunes these.
/** Seconds the client may claim beyond the server's own elapsed time (network and clock jitter). */
export const ELAPSED_SLACK_SECONDS = 2;
/** Squashes per second of real elapsed time above which a run can't be real. */
export const MAX_SQUASHES_PER_SECOND = 6;

// Upgrades.
/**
 * Every upgrade that is built, by id: the game's draw pool, and the only ids the server stores.
 * An upgrade joins this list in the pull request that builds it, so nothing unbuilt is ever
 * offered. All four are built.
 */
export const UPGRADE_IDS = ["review-laser", "test-shield", "refactor-bomb", "ci-drone"] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];
export const [REVIEW_LASER, TEST_SHIELD, REFACTOR_BOMB, CI_DRONE] = UPGRADE_IDS;
/** Picking an upgrade again makes it stronger, up to this level; then it leaves the pool. */
export const UPGRADE_MAX_LEVEL = 2;
/** The most upgrades a finished run may report. Every upgrade at its top level must fit. */
export const MAX_UPGRADES = 10;

export function isUpgradeId(v: unknown): v is UpgradeId {
  return (UPGRADE_IDS as readonly unknown[]).includes(v);
}

// Teams.
/**
 * The two teams of the Tabs vs Spaces race. Here, not in db.ts, because the browser imports
 * this file and can't import db.ts (bun:sqlite); db.ts re-exports it for server code.
 */
export const TEAMS = ["tabs", "spaces"] as const;
export type Team = (typeof TEAMS)[number];

export function isTeam(v: unknown): v is Team {
  return (TEAMS as readonly unknown[]).includes(v);
}

// Names.
export const NAME_MIN = 2;
export const NAME_MAX = 16;
// ASCII letters only: look-alike Unicode letters would slip past the blocked-word list.
const NAME_CHARS = /^[A-Za-z0-9 _-]+$/;
const DIGIT_SWAPS: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" };

export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: "length" | "characters" | "blocked" | "reserved" };

/** Trims and collapses runs of spaces to one. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/ {2,}/g, " ");
}

/** The key hidden names are matched by: the normalized name, lowercased. */
export function nameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

/** The form the word lists are matched against: lowercased, spaces, - and _ removed, digit swaps undone. */
export function compactName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ _-]/g, "")
    .replace(/[0134578]/g, (d) => DIGIT_SWAPS[d] ?? d);
}

/**
 * The ways to read a name: its compact form, and, when it starts or ends with a number, also the
 * compact form without those numbers (an age, a year, a "2"). A name is refused if either reading
 * is, so "ass2", "2fag", "1 Admin" and "Cole Medin 2" are caught while "pen15" still reads "penis".
 */
function readings(s: string): string[] {
  const joined = s.replace(/[ _-]/g, "");
  const bare = joined.replace(/^\d+(?=\D)/, "").replace(/(\D)\d+$/, "$1");
  return bare === joined ? [compactName(s)] : [compactName(s), compactName(bare)];
}

/**
 * An entry as a pattern: each run of a letter matches that many or more of it, so "fuck" is
 * f+u+c+k+ (catches "fuuuck") and "pussy" is p+u+s{2,}y+. The name is never collapsed: that
 * would make "boob" match "Bob" and "hell" match "Helen".
 */
export function entryPattern(entry: string): string {
  return entry.replace(/([a-z])\1*/g, (run, c: string) => (run.length === 1 ? `${c}+` : `${c}{${run.length},}`));
}

const alternation = (list: readonly string[]) => list.map(entryPattern).join("|");
const ANYWHERE = new RegExp(alternation(BLOCKED_ANYWHERE));
const WHOLE = new RegExp(`^(?:${alternation(BLOCKED_WHOLE)})s*$`);
const RESERVED = new RegExp(`^(?:${alternation(RESERVED_NAMES)})$`);
// Longest first, so a long exception is cut before a shorter one inside it.
const EXCEPTIONS_LONGEST_FIRST = [...EXCEPTIONS].sort((a, b) => b.length - a.length);

/**
 * The words of a name, split on space, - and _. A run of words of one or two characters is
 * joined back into one word, since that is a word spelled out ("f u c k", "n a z i", "fu ck"),
 * not several names. A word made only of digits inside a longer name is a number
 * ("load-4455"), not letters, so it is left out.
 */
function nameWords(name: string): string[] {
  const words: string[] = [];
  let run = "";
  for (const w of name.split(/[ _-]+/).filter(Boolean)) {
    if (w.length <= 2) {
      run += w;
      continue;
    }
    if (run) words.push(run);
    run = "";
    words.push(w);
  }
  if (run) words.push(run);
  const lettered = words.filter((w) => !/^\d+$/.test(w));
  return lettered.length > 0 ? lettered : words;
}

/** An exception becomes "|", not "", so cutting it out can't join two halves into a word. */
function cutExceptions(compact: string): string {
  let cut = compact;
  for (const e of EXCEPTIONS_LONGEST_FIRST) cut = cut.split(e).join("|");
  return cut;
}

/**
 * Why the word lists refuse this name, or null when they don't. Checks the lists only, not
 * length or characters: the boards use it to hide stored names that the lists now refuse.
 *
 * Blocked words are looked for inside each word of the name, never across the space between
 * two words: "Anna Ziegler" holds "nazi" and "Matt Watson" holds "twat" only once the space is
 * gone. BLOCKED_WHOLE words are also looked for in the parts of a word that a capital starts
 * ("BigDick", "ImASpic"). Reserved names are matched against the whole name.
 */
export function listedReason(name: string): "blocked" | "reserved" | null {
  const words = nameWords(name);
  const parts = words.flatMap((w) => w.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").split(" "));
  const wordReadings = words.flatMap(readings);
  if (wordReadings.some((c) => ANYWHERE.test(cutExceptions(c)))) return "blocked";
  if ([...wordReadings, ...parts.flatMap(readings)].some((c) => WHOLE.test(c))) return "blocked";
  if (readings(name).some((c) => RESERVED.test(c))) return "reserved";
  return null;
}

export function checkName(raw: string): NameCheck {
  const name = normalizeName(raw);
  if (name.length < NAME_MIN || name.length > NAME_MAX) return { ok: false, reason: "length" };
  if (!NAME_CHARS.test(name)) return { ok: false, reason: "characters" };
  const listed = listedReason(name);
  if (listed) return { ok: false, reason: listed };
  return { ok: true, name };
}

const shown = new Map<string, boolean>();
/**
 * May a stored name appear on a board? False when the word lists now refuse it (blocked or
 * reserved), so a name stored before a list grew is hidden at read time. Memoised: the boards
 * ask once a second for every player.
 */
export function isShownName(name: string): boolean {
  let ok = shown.get(name);
  if (ok === undefined) {
    if (shown.size >= 10_000) shown.clear();
    ok = listedReason(normalizeName(name)) === null;
    shown.set(name, ok);
  }
  return ok;
}

export type ScoreClaim = { score: number; squashes: number; seconds: number };
export type ScoreCheck = { ok: true } | { ok: false; reason: string };

/**
 * Is this score possible for a run that really lasted `elapsedSeconds` by the server's clock?
 * The score can't exceed 10 per squash plus 1 per (elapsed + slack) second, squashes can't
 * exceed 6 per elapsed second, and the run can't claim more time than really passed (+ slack).
 */
export function checkScore(claim: ScoreClaim, elapsedSeconds: number): ScoreCheck {
  const { score, squashes, seconds } = claim;
  if (!Number.isInteger(score) || score < 0) return { ok: false, reason: "score" };
  if (!Number.isInteger(squashes) || squashes < 0) return { ok: false, reason: "squashes" };
  if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, reason: "seconds" };
  const allowedSeconds = elapsedSeconds + ELAPSED_SLACK_SECONDS;
  if (score > POINTS_PER_SQUASH * squashes + POINTS_PER_SECOND * allowedSeconds) {
    return { ok: false, reason: "score too high for the elapsed time" };
  }
  if (squashes > MAX_SQUASHES_PER_SECOND * elapsedSeconds) {
    return { ok: false, reason: "too many squashes for the elapsed time" };
  }
  if (seconds > allowedSeconds) return { ok: false, reason: "more seconds than really passed" };
  return { ok: true };
}
