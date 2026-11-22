// The stream board's data: what /api/board returns, checked, and what the page shows from it.
// Pure: no DOM, no fetch, no clock, so `bun test` covers it.
import { TEAMS, type Team } from "../../server/rules";
import type { LiveArena } from "../../server/arena/rooms";
import type { TopRow } from "../api";
import { TEAM_LOOK } from "../teams";

export const TOP_SIZE = 10;
/**
 * A name too wide for its row shrinks to fit, down to this share of the row's type (owner ruling
 * on #26: viewers must tell names apart). Rows are 8vh, so the floor is 5vh: 36 px at 1280x720.
 * Below the floor the name is cut with an ellipsis.
 */
export const NAME_MIN_SCALE = 5 / 8;

/** `playing` and `arenas` count people only: fill bots never reach the board. */
export type Board = { top: TopRow[]; teams: Record<Team, number>; playing: number; arenas: LiveArena[] };
export type { LiveArena };

/** One arena's pill: `text` always, `queen` ("QUEEN 64%") only while a hive queen lives there (#102). */
export type ArenaPill = { id: number; text: string; queen: string | null };
/** `moreQueens` ("2 QUEENS") counts the arenas folded into '+N more' with a hive queen alive, else null (#102). */
export type ArenaPills = { pills: ArenaPill[]; more: number; moreQueens: string | null };

export type BoardRow = { rank: number; name: string; score: string; isNew: boolean };
export type BoardTeam = { team: Team; label: string; color: string; total: string; share: number };
export type BoardView = {
  rows: BoardRow[];
  teams: BoardTeam[];
  /** The team strictly ahead, or null on a tie. */
  leader: Team | null;
  /** True when the other team was ahead last time and this one is now. */
  overtook: boolean;
  /** People playing now, formatted. */
  playing: string;
  /** The open arenas. view.ts fits as many pills as the strip holds (arenaPills, which orders them by id). */
  arenas: LiveArena[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isScore = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;
/** A hive queen's health (#102): a whole percent 1-100, or null (none). Missing reads as none, so an older server's body still parses. */
const isQueen = (v: unknown): boolean => v === undefined || v === null || (isCount(v, 1) && (v as number) <= 100);

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
  if (!isCount(body.playing, 0) || !Array.isArray(body.arenas)) return null;
  // No cap on the count: several hundred viewers is more than a dozen arenas.
  const arenas: LiveArena[] = [];
  for (const a of body.arenas) {
    if (!isRecord(a) || !isCount(a.id, 1) || !isCount(a.players, 0) || !isCount(a.wave, 1) || !isQueen(a.queen)) return null;
    arenas.push({ id: a.id, players: a.players, wave: a.wave, queen: (a.queen as number | null | undefined) ?? null });
  }
  return { top, teams, playing: body.playing, arenas };
}

/**
 * The arena strip with room for `slots` chips: one pill per open arena, by id (the order holds still
 * on stream). With more arenas than slots, the last slot becomes '+N more' for the rest. view.ts
 * finds the largest `slots` whose chips fit the strip's measured width. An arena with a hive queen
 * alive also gets her health, "QUEEN 64%", which view.ts shows after a pulsing mark (#102). Arenas
 * folded into '+N more' with a queen alive are counted on that chip instead, "2 QUEENS" (owner
 * ruling on #102), so a queen never goes unseen; the order stays by id.
 */
const queensLine = (n: number): string | null => (n === 0 ? null : n === 1 ? "1 QUEEN" : `${n} QUEENS`);

export function arenaPills(arenas: LiveArena[], slots: number): ArenaPills {
  const sorted = [...arenas].sort((a, b) => a.id - b.id);
  const shown = sorted.length <= slots ? sorted : sorted.slice(0, Math.max(0, slots - 1));
  return {
    pills: shown.map((a) => ({
      id: a.id,
      text: `Arena ${a.id} · ${a.players} · wave ${a.wave}`,
      queen: a.queen === null ? null : `QUEEN ${a.queen}%`,
    })),
    more: sorted.length - shown.length,
    moreQueens: queensLine(sorted.slice(shown.length).filter((a) => a.queen !== null).length),
  };
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
  return {
    rows,
    teams,
    leader,
    overtook: was !== null && leader !== null && leader !== was,
    playing: formatScore(next.playing),
    arenas: next.arenas,
  };
}

/** The font scale that fits a name of natural width `natural` into `available` px, never below the floor. */
export function nameScale(available: number, natural: number): number {
  if (natural <= available || natural <= 0) return 1;
  return Math.max(NAME_MIN_SCALE, available / natural);
}

/**
 * The join line's address: the page's own host, so the board never names a URL of its own. Split
 * after each dot, so a long host wraps only there and never at a hyphen viewers might type.
 */
export function joinHost(origin: string): string[] {
  return new URL(origin).host.split(/(?<=\.)/);
}
