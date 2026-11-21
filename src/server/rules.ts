// Name rules and score plausibility. Pure: no bun:sqlite, node:* or Bun globals, because the
// browser imports this file too (name entry checks names before the server sees them, and
// the simulation scores with the same constants the server checks against).
import { BLOCKED_ANYWHERE, BLOCKED_WHOLE, EXCEPTIONS, RESERVED_NAMES } from "./blocked-words";

// Scoring, shared by the simulation and the server.
export const POINTS_PER_SQUASH = 10;
export const POINTS_PER_SECOND = 1;

// Plausibility. Not cheat-proof (a non-goal): these only keep an obvious forgery small.
/** Seconds the client may claim beyond the server's own elapsed time (network and clock jitter). */
export const ELAPSED_SLACK_SECONDS = 2;
/**
 * Squashes per second of run time (the submitted `seconds`; a choice pause squashes nothing)
 * above which a run can't be real. Measured by `bun run pacing --broad` (2,000 mover runs and
 * 250 idle, 2026-11-21): the most was 4.056 a second (same-ci-drone, seed 19, 560 squashes in
 * 138 s). A squash takes a bug and bugs come only from the spawn schedule, which spawns at most
 * 4.9 per second of run time through MAX_RUN_SECONDS (sim.test.ts guards that), so 5 can't
 * refuse a real run. It is not 1.5x the measured rate: real runs come close to the schedule's
 * ceiling, and 6.08 would let 120 squashes through in a 20 s run (with the 2 s slack, a forgery
 * needs over 120 / 22 = 5.45).
 */
export const MAX_SQUASHES_PER_SECOND = 5;
/**
 * The longest run, in run seconds, the server accepts. The longest measured run is 138 s
 * (`bun run pacing --broad`) and balance holds every run under 240 s (TARGETS.runMax in
 * src/web/game/pacing.ts); 300 is the owner's ceiling.
 */
export const MAX_RUN_SECONDS = 300;

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
 * ("load-4455"), not letters, so it is left out. `short` marks a word built from such a run.
 */
function nameWords(name: string): { text: string; short: boolean }[] {
  const words: { text: string; short: boolean }[] = [];
  let run = "";
  for (const w of name.split(/[ _-]+/).filter(Boolean)) {
    if (w.length <= 2) {
      run += w;
      continue;
    }
    if (run) words.push({ text: run, short: true });
    run = "";
    words.push({ text: w, short: false });
  }
  if (run) words.push({ text: run, short: true });
  const lettered = words.filter((w) => !/^\d+$/.test(w.text));
  return lettered.length > 0 ? lettered : words;
}

/**
 * The words to look for blocked words in: each word, and each short word (one or two letters,
 * or a run of them) glued to the word before it, the word after it, and both. A blocked word
 * split by one space into a short piece and a longer one ("f uck", "ni gger", "who re", "shi t")
 * is read whole again. A split into two pieces of three letters or more ("ret ard") is not.
 */
function lookupWords(name: string): string[] {
  const words = nameWords(name);
  const out = words.map((w) => w.text);
  words.forEach((w, i) => {
    if (!w.short) return;
    const before = words[i - 1]?.text ?? "";
    const after = words[i + 1]?.text ?? "";
    if (before) out.push(before + w.text);
    if (after) out.push(w.text + after);
    if (before && after) out.push(before + w.text + after);
  });
  return out;
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
 * two longer words: "Anna Ziegler" holds "nazi" and "Matt Watson" holds "twat" only once the
 * space is gone. A short word is also read glued to its neighbours (lookupWords). BLOCKED_WHOLE
 * words are also looked for in the parts of a word that a capital starts ("BigDick",
 * "ImASpic"). Reserved names are matched against the whole name.
 */
export function listedReason(name: string): "blocked" | "reserved" | null {
  const words = lookupWords(name);
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

/**
 * Names starting with this (after normalizing, any case) belong to the server's own arena bots,
 * so the arena's /ws refuses them from clients. Not folded into checkName yet: release 1 (`/`)
 * and its boards keep accepting such names until the item that switches `/` to the arena.
 */
export const BOT_NAME_PREFIX = "bot ";

/** True for a name reserved for the server's bots: "bot " and more, in any case. "bots-01" is not one. */
export function isBotName(name: string): boolean {
  return nameKey(name).startsWith(BOT_NAME_PREFIX);
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
 * The run can't claim more time than really passed (+ slack) or more than MAX_RUN_SECONDS, the
 * score can't exceed 10 per squash plus 1 per (elapsed + slack) second, and squashes can't
 * exceed MAX_SQUASHES_PER_SECOND per claimed second (choice pauses earn none).
 */
export function checkScore(claim: ScoreClaim, elapsedSeconds: number): ScoreCheck {
  const { score, squashes, seconds } = claim;
  if (!Number.isInteger(score) || score < 0) return { ok: false, reason: "score" };
  if (!Number.isInteger(squashes) || squashes < 0) return { ok: false, reason: "squashes" };
  if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, reason: "seconds" };
  const allowedSeconds = elapsedSeconds + ELAPSED_SLACK_SECONDS;
  if (seconds > allowedSeconds) return { ok: false, reason: "more seconds than really passed" };
  if (seconds > MAX_RUN_SECONDS) return { ok: false, reason: "run longer than any real run" };
  if (score > POINTS_PER_SQUASH * squashes + POINTS_PER_SECOND * allowedSeconds) {
    return { ok: false, reason: "score too high for the elapsed time" };
  }
  if (squashes > MAX_SQUASHES_PER_SECOND * seconds) {
    return { ok: false, reason: "too many squashes for the run's seconds" };
  }
  return { ok: true };
}
