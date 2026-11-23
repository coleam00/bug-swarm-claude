// The life-over screen's words, without the DOM (App.tsx renders them).
import type { Me, TopRow } from "./api";

/** A count as the board writes it: 466,548. */
export const fmt = (n: number): string => n.toLocaleString("en-US");

/** How many rows the top 10 has. */
export const TOP_SIZE = 10;

/**
 * Where the player stands against the top 10, as the server ranked them: "#3 on the top 10".
 * When another player's life holds their name's row (one row per name, db.ts rankOf), that row
 * instead: "Churn holds #1 with 1,900", and nothing is highlighted. Off the top 10, "120 points to reach the top 10" (one more than the 10th row's score minus their best; never
 * under 1, since the rows can trail the best by a second). Null without a rank or a best (hidden,
 * no saved life yet, or the read failed).
 */
export function topLine(me: Me | null, top: readonly TopRow[], best: number | null): string | null {
  if (me?.held && best !== null) return `${me.held.name} holds #${me.held.rank} with ${fmt(me.held.score)}`;
  if (!me || me.rank === null || best === null) return null;
  if (me.rank <= TOP_SIZE) return `#${me.rank} on the top 10`;
  const tenth = top[TOP_SIZE - 1];
  if (!tenth) return null;
  const points = Math.max(1, tenth.score - best + 1);
  return `${fmt(points)} point${points === 1 ? "" : "s"} to reach the top 10`;
}
