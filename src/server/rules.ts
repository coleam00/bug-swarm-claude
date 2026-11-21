// Name rules and score plausibility. Pure: no bun:sqlite, node:* or Bun globals, because the
// browser imports this file too (name entry checks names before the server sees them, and
// the simulation scores with the same constants the server checks against).
import { BLOCKED_WORDS } from "./blocked-words";

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
 * An upgrade joins this list in the pull request that builds it (ci-drone comes next), so
 * nothing unbuilt is ever offered.
 */
export const UPGRADE_IDS = ["review-laser", "test-shield", "refactor-bomb"] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];
export const [REVIEW_LASER, TEST_SHIELD, REFACTOR_BOMB] = UPGRADE_IDS;
/** Picking an upgrade again makes it stronger, up to this level; then it leaves the pool. */
export const UPGRADE_MAX_LEVEL = 2;
/** The most upgrades a finished run may report. Every upgrade at its top level must fit. */
export const MAX_UPGRADES = 10;

export function isUpgradeId(v: unknown): v is UpgradeId {
  return (UPGRADE_IDS as readonly unknown[]).includes(v);
}

// Names.
export const NAME_MIN = 2;
export const NAME_MAX = 16;
// ASCII letters only: look-alike Unicode letters would slip past the blocked-word list.
const NAME_CHARS = /^[A-Za-z0-9 _-]+$/;
const DIGIT_SWAPS: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s" };

export type NameCheck = { ok: true; name: string } | { ok: false; reason: "length" | "characters" | "blocked" };

/** Trims and collapses runs of spaces to one. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/ {2,}/g, " ");
}

/** The key hidden names are matched by: the normalized name, lowercased. */
export function nameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

export function checkName(raw: string): NameCheck {
  const name = normalizeName(raw);
  if (name.length < NAME_MIN || name.length > NAME_MAX) return { ok: false, reason: "length" };
  if (!NAME_CHARS.test(name)) return { ok: false, reason: "characters" };
  const compact = name
    .toLowerCase()
    .replace(/[01345]/g, (d) => DIGIT_SWAPS[d] ?? d)
    .replace(/[ _-]/g, "");
  if (BLOCKED_WORDS.some((w) => compact.includes(w))) return { ok: false, reason: "blocked" };
  return { ok: true, name };
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
