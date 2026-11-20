import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nameKey } from "./rules";

// Every event the app records, named once. The server writes them and `bun run stats` reads them,
// so both import this list instead of typing the strings. A run is a run_started and, if it
// finished, a run_ended; a run with no run_ended was abandoned.
export const EVENT_TYPES = ["run_started", "run_ended"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const [RUN_STARTED, RUN_ENDED] = EVENT_TYPES;

// The two teams (Phase 3 asks players to pick one).
export const TEAMS = ["tabs", "spaces"] as const;
export type Team = (typeof TEAMS)[number];

// Columns added to `events` after the first release. Schema changes are additive: add a table
// or a column, never drop or rename one. Old rows (such as the scaffold's `opened`) stay and
// are ignored.
const EVENT_COLUMNS: [name: string, type: string][] = [
  ["run_id", "TEXT"],
  ["player_id", "TEXT"],
  ["score", "INTEGER"],
  ["squashes", "INTEGER"],
  ["seconds", "REAL"],
  ["touch", "INTEGER"],
  ["upgrades", "TEXT"],
];

// One SQLite file holds the app's data. Tables are created here.
export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  // `bun run hide` writes from a second process while the server runs: wait, don't fail.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    at TEXT NOT NULL
  );`);
  const have = new Set((db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of EVENT_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type};`);
  }
  // One start and one end per run, even under concurrent requests.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS events_run_type ON events(run_id, type) WHERE run_id IS NOT NULL;");
  db.exec("CREATE INDEX IF NOT EXISTS events_type_at ON events(type, at);");
  db.exec(`CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    team TEXT,
    created_at TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS hidden_names (
    name_key TEXT PRIMARY KEY,
    at TEXT NOT NULL
  );`);
  return db;
}

export function recordRunStarted(db: Database, runId: string, playerId: string, at: Date): void {
  db.query("INSERT INTO events (type, at, run_id, player_id) VALUES (?, ?, ?, ?)").run(
    RUN_STARTED,
    at.toISOString(),
    runId,
    playerId,
  );
}

/** Creates the player, or renames them to the name they started this run with. */
export function upsertPlayer(db: Database, id: string, name: string, at: Date): void {
  db.query(
    "INSERT INTO players (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
  ).run(id, name, at.toISOString());
}

export type RunStart = { runId: string; playerId: string; at: Date };

export function findRunStart(db: Database, runId: string): RunStart | null {
  const row = db
    .query("SELECT run_id, player_id, at FROM events WHERE type = ? AND run_id = ?")
    .get(RUN_STARTED, runId) as { run_id: string; player_id: string; at: string } | null;
  return row ? { runId: row.run_id, playerId: row.player_id, at: new Date(row.at) } : null;
}

export type RunEnd = {
  runId: string;
  playerId: string;
  score: number;
  squashes: number;
  seconds: number;
  touch: boolean;
  upgrades: string[];
};

/** Thrown when a run already has its run_ended. */
export class DuplicateRunEnd extends Error {}

export function recordRunEnded(db: Database, end: RunEnd, at: Date): void {
  try {
    db.query(
      `INSERT INTO events (type, at, run_id, player_id, score, squashes, seconds, touch, upgrades)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      RUN_ENDED,
      at.toISOString(),
      end.runId,
      end.playerId,
      end.score,
      end.squashes,
      end.seconds,
      end.touch ? 1 : 0,
      JSON.stringify(end.upgrades),
    );
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) throw new DuplicateRunEnd(end.runId);
    throw err;
  }
}

export type TopRow = { name: string; score: number };

/** Best score per player, one row each, non-hidden names only, highest first (earlier wins ties). */
export function topTen(db: Database): TopRow[] {
  return db
    .query(
      `SELECT p.name AS name, MAX(e.score) AS score
       FROM events e JOIN players p ON p.id = e.player_id
       WHERE e.type = ? AND lower(p.name) NOT IN (SELECT name_key FROM hidden_names)
       GROUP BY p.id
       ORDER BY score DESC, MIN(e.at) ASC
       LIMIT 10`,
    )
    .all(RUN_ENDED) as TopRow[];
}

/** A player's best finished score, or null with none. */
export function playerBest(db: Database, playerId: string): number | null {
  const row = db
    .query("SELECT MAX(score) AS best FROM events WHERE type = ? AND player_id = ?")
    .get(RUN_ENDED, playerId) as { best: number | null } | null;
  return row?.best ?? null;
}

/** Hides a name (any case) from the top 10. */
export function hideName(db: Database, name: string, at: Date): string {
  const key = nameKey(name);
  db.query("INSERT OR IGNORE INTO hidden_names (name_key, at) VALUES (?, ?)").run(key, at.toISOString());
  return key;
}

export type Stats = { players: number; finishedRuns: number; medianRunsPerPlayer: number; touchShare: number };

/**
 * The bet's numbers over finished runs, filtered by the run_ended time: `since` inclusive,
 * `until` exclusive, both ISO strings in UTC like the stored `at`.
 */
export function computeStats(db: Database, range: { since?: string; until?: string } = {}): Stats {
  const where = ["type = ?"];
  const params: string[] = [RUN_ENDED];
  if (range.since) {
    where.push("at >= ?");
    params.push(range.since);
  }
  if (range.until) {
    where.push("at < ?");
    params.push(range.until);
  }
  const rows = db
    .query(
      `SELECT COUNT(*) AS runs, SUM(touch) AS touch FROM events WHERE ${where.join(" AND ")} GROUP BY player_id`,
    )
    .all(...params) as { runs: number; touch: number | null }[];
  const counts = rows.map((r) => r.runs).sort((a, b) => a - b);
  const finishedRuns = counts.reduce((a, b) => a + b, 0);
  const touchRuns = rows.reduce((a, r) => a + (r.touch ?? 0), 0);
  return {
    players: counts.length,
    finishedRuns,
    medianRunsPerPlayer: median(counts),
    touchShare: finishedRuns === 0 ? 0 : Math.round((100 * touchRuns) / finishedRuns),
  };
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
