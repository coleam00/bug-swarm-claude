import { TEAMS, type Team } from "../server/rules";
import { parseBoard } from "./board/data";

// The API client for the life-over screen's reads (the arena saves lives on the server; nothing
// here writes). Nothing here throws to its caller and nothing blocks play: every failure is
// logged and reported as a value the screen can show.
const TIMEOUT_MS = 5000;

export type TopRow = { name: string; score: number };

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Where the player stands, as the server ranks them (src/server/db.ts rankOf). */
export type Me = {
  rank: number | null;
  ranked: number;
  next: { rank: number; points: number } | null;
  row: number | null;
  /** Only when another player's life holds the name's row: that row's name, rank and score. */
  held?: { name: string; rank: number; score: number };
};

/**
 * The top 10, and with a player id where that player stands (`me`). A malformed `me` is
 * logged and dropped (null): the top 10 still shows.
 */
export async function fetchTop(playerId?: string): Promise<{ top: TopRow[]; me: Me | null } | "failed"> {
  try {
    const res = await call(playerId === undefined ? "/api/top" : `/api/top?player=${encodeURIComponent(playerId)}`);
    const body = (await res.json()) as { top?: unknown; me?: unknown };
    if (res.ok && Array.isArray(body.top)) {
      const me = playerId === undefined ? null : parseMe(body.me);
      if (playerId !== undefined && me === null) console.error("top 10: the player's rank was missing or malformed");
      return { top: body.top as TopRow[], me };
    }
    console.error(`top 10 failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("top 10 failed", err);
  }
  return "failed";
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function parseMe(v: unknown): Me | null {
  if (typeof v !== "object" || v === null) return null;
  const { rank, ranked, next, row, held } = v as Record<string, unknown>;
  if (!(rank === null || count(rank)) || !count(ranked) || !(row === null || count(row))) return null;
  let me: Me;
  if (next === null) me = { rank, ranked, next: null, row };
  else {
    if (typeof next !== "object") return null;
    const n = next as Record<string, unknown>;
    if (!count(n.rank) || !count(n.points)) return null;
    me = { rank, ranked, next: { rank: n.rank, points: n.points }, row };
  }
  if (held === undefined) return me;
  if (typeof held !== "object" || held === null) return null;
  const h = held as Record<string, unknown>;
  if (typeof h.name !== "string" || !count(h.rank) || !count(h.score)) return null;
  return { ...me, held: { name: h.name, rank: h.rank, score: h.score } };
}

/** Each team's total, as the server counts it. */
export async function fetchTeams(): Promise<Record<Team, number> | "failed"> {
  try {
    const res = await call("/api/teams");
    const body = (await res.json()) as { teams?: Record<string, unknown> };
    const teams = body.teams;
    if (res.ok && teams && TEAMS.every((t) => typeof teams[t] === "number")) {
      return Object.fromEntries(TEAMS.map((t) => [t, teams[t]])) as Record<Team, number>;
    }
    console.error(`team totals failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("team totals failed", err);
  }
  return "failed";
}

/** The player's best saved score: a number, or null with none yet. */
export async function fetchBest(playerId: string): Promise<number | null | "failed"> {
  try {
    const res = await call(`/api/players/${encodeURIComponent(playerId)}/best`);
    const body = (await res.json()) as { best?: unknown };
    if (res.ok && (typeof body.best === "number" || body.best === null)) return body.best;
    console.error(`best score failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("best score failed", err);
  }
  return "failed";
}

/** People playing now (never bots), from the stream board's read (/api/board): the start screen's live line. */
export async function fetchPlaying(): Promise<number | "failed"> {
  try {
    const res = await call("/api/board");
    const board = res.ok ? parseBoard(await res.json()) : null;
    if (board) return board.playing;
    console.error(`playing now failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("playing now failed", err);
  }
  return "failed";
}
