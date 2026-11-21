import { MAX_RUN_SECONDS, MAX_SQUASHES_PER_SECOND, POINTS_PER_SECOND, POINTS_PER_SQUASH, type UpgradeId } from "../server/rules";
import type { Me } from "./api";
import { UPGRADES } from "./game/config";

export type UpgradeLevel = { id: UpgradeId; name: string; level: number };

/**
 * How the run was built, for the game-over screen: each upgrade taken, in the order first
 * taken, at the level it reached (one level a pick).
 */
export function upgradeLevels(taken: readonly UpgradeId[]): UpgradeLevel[] {
  const levels: UpgradeLevel[] = [];
  for (const id of taken) {
    const known = levels.find((l) => l.id === id);
    if (known) known.level++;
    else levels.push({ id, name: UPGRADES[id].name, level: 1 });
  }
  return levels;
}

export type SaveState = "saving" | "saved" | "failed" | "not-saved" | "rate-limited";

/** The line the game-over screen shows about saving, or null when there is nothing to say. */
export function saveNotice(saved: SaveState): string | null {
  if (saved === "rate-limited") return "Too many runs right now. Your next run will save.";
  if (saved === "failed") return "Couldn't save your score";
  return null;
}

/** A count as the board writes it: 466,548. */
export const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * Where the player stands, under Best: "Your best is #37 of 214" and either the points to pass
 * the rank above or "You're in the top 10!". Nothing without a rank (hidden, no saved run, or
 * the read failed).
 */
export function rankLines(me: Me | null): string[] {
  if (!me || me.rank === null) return [];
  const lines = [`Your best is #${fmt(me.rank)} of ${fmt(me.ranked)}`];
  if (me.rank <= 10) lines.push("You're in the top 10!");
  else if (me.next) lines.push(`${fmt(me.next.points)} point${me.next.points === 1 ? "" : "s"} to beat #${fmt(me.next.rank)}`);
  return lines;
}

/** The highest score the server accepts (rules.ts checkScore), the widest a score gets. */
export const MAX_SCORE = MAX_RUN_SECONDS * (POINTS_PER_SECOND + MAX_SQUASHES_PER_SECOND * POINTS_PER_SQUASH);

/** The longest rank lines, for `bun run bench`'s layout check. */
export const WORST_RANK_LINES = rankLines({ rank: 9999, ranked: 9999, next: { rank: 9998, points: MAX_SCORE }, row: null });
