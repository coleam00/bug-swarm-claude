// Name rules and teams. Pure: no bun:sqlite, node:* or Bun globals, because the browser imports
// this file too (name entry checks names before the server sees them).
import { BLOCKED_ANYWHERE, BLOCKED_WHOLE, EXCEPTIONS, RESERVED_EXACT, RESERVED_NAMES } from "./blocked-words";

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
const EXACT = new Set(RESERVED_EXACT);
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
  if (readings(name).some((c) => RESERVED.test(c) || EXACT.has(c))) return "reserved";
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
 * True for a name that reads as one of the server's own arena bots: its first word reads "bot"
 * once digit swaps, separators, spelled-out letters and a number at either end are undone (the
 * profanity check's normalisation: "Bot", "b0t x", "bot_x", "b o t", "Bot2", "1 bot", and every
 * fill bot's "bot Ada"). The arena's /ws refuses these from clients and the start screen before
 * joining (start.ts), so a name that reads "bot" in the arena is always a server bot. Not folded
 * into checkName: fill bots keep their names and the boards still show stored ones. "Robot",
 * "Abbot", "Boot" and "bots-01" are not bot names.
 */
export function isBotName(name: string): boolean {
  const first = nameWords(normalizeName(name))[0];
  return first !== undefined && readings(first.text).includes("bot");
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
