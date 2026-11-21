// The stream board's data: what /api/board returns, checked, and what the page shows from it.
// Pure: no DOM, no fetch, no clock, so `bun test` covers it.
import { TEAMS, type Team } from "../../server/rules";
import type { TopRow } from "../api";
import { TEAM_LOOK } from "../teams";

export const TOP_SIZE = 10;

export type Board = { top: TopRow[]; teams: Record<Team, number> };

export type BoardRow = { rank: number; name: string; score: string; isNew: boolean };
export type BoardTeam = { team: Team; label: string; color: string; total: string; share: number };
export type BoardView = {
  rows: BoardRow[];
  teams: BoardTeam[];
  /** The team strictly ahead, or null on a tie. */
  leader: Team | null;
  /** True when the other team was ahead last time and this one is now. */
  overtook: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isScore = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The body of GET /api/board, or null when it isn't one. Copies only the fields the board uses. */
export function parseBoard(body: unknown): Board | null {
  if (!isRecord(body) || !Array.isArray(body.top) || body.top.length > TOP_SIZE || !isRecord(body.teams)) return null;
  const top: TopRow[] = [];
  for (const row of body.top) {
    if (!isRecord(row) || typeof row.name !== "string" || !isScore(row.score)) return null;
    top.push({ name: row.name, score: row.score });
  }
  const sent = body.teams;
  if (!TEAMS.every((t) => isScore(sent[t]))) return null;
  const teams = Object.fromEntries(TEAMS.map((t) => [t, sent[t]])) as Record<Team, number>;
  return { top, teams };
}

export function formatScore(n: number): string {
  return n.toLocaleString("en-US");
}

function leaderOf(teams: Record<Team, number>): Team | null {
  const best = Math.max(...TEAMS.map((t) => teams[t]));
  const ahead = TEAMS.filter((t) => teams[t] === best);
  return ahead.length === 1 ? ahead[0]! : null;
}

/**
 * What the board shows for `next`, given what it showed before (`prev`, null on the first load).
 * A row is new when its name was not in the last top 10. The top 10 is grouped by player, so two
 * rows can share a name: names are counted, and only the extra one is new. The first load
 * highlights nothing.
 */
export function boardView(prev: Board | null, next: Board): BoardView {
  const before = new Map<string, number>();
  for (const row of prev?.top ?? []) before.set(row.name, (before.get(row.name) ?? 0) + 1);
  const rows = next.top.map((row, i) => {
    const left = before.get(row.name) ?? 0;
    if (left > 0) before.set(row.name, left - 1);
    return { rank: i + 1, name: row.name, score: formatScore(row.score), isNew: prev !== null && left === 0 };
  });

  const sum = TEAMS.reduce((a, t) => a + next.teams[t], 0);
  const teams = TEAMS.map((team) => ({
    team,
    label: TEAM_LOOK[team].label,
    color: TEAM_LOOK[team].color,
    total: formatScore(next.teams[team]),
    share: sum > 0 ? next.teams[team] / sum : 1 / TEAMS.length,
  }));

  const leader = leaderOf(next.teams);
  const was = prev ? leaderOf(prev.teams) : null;
  return { rows, teams, leader, overtook: was !== null && leader !== null && leader !== was };
}

/** The join line: the page's own host, so the board never names a URL of its own. */
export function joinText(origin: string): string {
  return `Play at ${new URL(origin).host}`;
}
