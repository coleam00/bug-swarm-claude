import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TEAMS, isShownName, isTeam, nameKey, type Team } from "./rules";

// Every event the app records, named once. The server writes them and `bun run stats` reads them,
// so both import this list instead of typing the strings. A run is a run_started and, if it
// finished, a run_ended; a run with no run_ended was abandoned.
export const EVENT_TYPES = ["run_started", "run_ended"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const [RUN_STARTED, RUN_ENDED] = EVENT_TYPES;

// The two teams. They live in rules.ts, which the browser imports too; server code finds them here.
export { TEAMS, type Team } from "./rules";

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
  // The team the run's player had when it started, on both rows. NULL (runs from before teams,
  // or a player with no team yet) counts for nobody.
  ["team", "TEXT"],
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
  // A player's best is read on every game-over poll (their rank): an index lookup, not a scan.
  db.exec("CREATE INDEX IF NOT EXISTS events_player_type ON events(player_id, type);");
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

export function recordRunStarted(db: Database, runId: string, playerId: string, at: Date, team: Team | null): void {
  db.query("INSERT INTO events (type, at, run_id, player_id, team) VALUES (?, ?, ?, ?, ?)").run(
    RUN_STARTED,
    at.toISOString(),
    runId,
    playerId,
    team,
  );
}

/**
 * Creates the player, or renames them to the name they started this run with. A team is set
 * once, by the first run that sends one, and never switched.
 */
export function upsertPlayer(db: Database, id: string, name: string, team: Team | null, at: Date): void {
  db.query(
    `INSERT INTO players (id, name, team, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, team = COALESCE(players.team, excluded.team)`,
  ).run(id, name, team, at.toISOString());
}

/** A stored player, or null for an id the server has never seen. */
export function findPlayer(db: Database, id: string): { name: string; team: Team | null } | null {
  const row = db.query("SELECT name, team FROM players WHERE id = ?").get(id) as { name: string; team: string | null } | null;
  return row ? { name: row.name, team: isTeam(row.team) ? row.team : null } : null;
}

export type RunStart = { runId: string; playerId: string; at: Date; team: Team | null };

export function findRunStart(db: Database, runId: string): RunStart | null {
  const row = db
    .query("SELECT run_id, player_id, at, team FROM events WHERE type = ? AND run_id = ?")
    .get(RUN_STARTED, runId) as { run_id: string; player_id: string; at: string; team: string | null } | null;
  return row
    ? { runId: row.run_id, playerId: row.player_id, at: new Date(row.at), team: isTeam(row.team) ? row.team : null }
    : null;
}

export type RunEnd = {
  runId: string;
  playerId: string;
  score: number;
  squashes: number;
  seconds: number;
  touch: boolean;
  upgrades: string[];
  /** The team from the run's start. */
  team: Team | null;
};

/** Thrown when a run already has its run_ended. */
export class DuplicateRunEnd extends Error {}

export function recordRunEnded(db: Database, end: RunEnd, at: Date): void {
  try {
    db.query(
      `INSERT INTO events (type, at, run_id, player_id, score, squashes, seconds, touch, upgrades, team)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      end.team,
    );
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) throw new DuplicateRunEnd(end.runId);
    throw err;
  }
}

export type TopRow = { name: string; score: number };

/** One ranked player: their best score and when they first finished a run (the tie order). */
export type RankEntry = { playerId: string; name: string; score: number; firstAt: string };

/**
 * Every player with a finished run, by best score, non-hidden names only, highest first. Ties go
 * to the player who finished a run first, then to the lower player id, so the order is total.
 * The top 10 is its first ten rows and a player's rank is their place in it. Stored names the
 * word lists now refuse (isShownName) are left out too: those rows stay stored, they are only
 * not shown, and they are dropped before the cut to 10, so a high-ranked one doesn't shorten
 * the board.
 */
export function ranking(db: Database): RankEntry[] {
  const rows = db
    .query(
      `SELECT p.id AS playerId, p.name AS name, MAX(e.score) AS score, MIN(e.at) AS firstAt
       FROM events e JOIN players p ON p.id = e.player_id
       WHERE e.type = ? AND lower(p.name) NOT IN (SELECT name_key FROM hidden_names)
       GROUP BY p.id
       ORDER BY score DESC, firstAt ASC, p.id ASC`,
    )
    .all(RUN_ENDED) as RankEntry[];
  return rows.filter((r) => isShownName(r.name));
}

/** The first ten rows of the ranking: best score per player, one row each. */
export function topTen(db: Database): TopRow[] {
  return topOf(ranking(db));
}

export function topOf(entries: RankEntry[]): TopRow[] {
  return entries.slice(0, 10).map(({ name, score }) => ({ name, score }));
}

/** The hidden names' keys (lower case, as the ranking's filter compares them). */
export function hiddenKeys(db: Database): Set<string> {
  return new Set((db.query("SELECT name_key FROM hidden_names").all() as { name_key: string }[]).map((r) => r.name_key));
}

/**
 * Where a player stands. `rank` is their place among `ranked` visible players (null when hidden
 * or with no finished run); `next` is the rank just above and the points it takes to pass it;
 * `row` is their index in the top 10 rows, when they are in them.
 */
export type Me = { rank: number | null; ranked: number; next: { rank: number; points: number } | null; row: number | null };

/**
 * Ranks a player's best against a ranking. `best` may be fresher than the ranking (a run that
 * finished since it was read): the player is placed by it, with their first-finish time from the
 * ranking, or after everyone already in it when they are not in it yet. `row` follows the
 * ranking as it is, since it points into the rows read with it.
 */
export function rankOf(entries: RankEntry[], playerId: string, best: number | null, hidden: boolean): Me {
  const at = entries.findIndex((e) => e.playerId === playerId);
  const row = !hidden && at >= 0 && at < 10 ? at : null;
  if (hidden || best === null) return { rank: null, ranked: entries.length, next: null, row: null };
  const mine = at >= 0 ? entries[at]! : null;
  // The ranking's order: score down, then first finish, then id. Not in the ranking yet: their
  // first finish is after the ranking was read, so after everyone in it.
  const ahead = (e: RankEntry) =>
    e.score > best ||
    (e.score === best && (mine === null || e.firstAt < mine.firstAt || (e.firstAt === mine.firstAt && e.playerId < mine.playerId)));
  let above: RankEntry | null = null;
  let count = 0;
  for (const e of entries) {
    if (e.playerId === playerId || !ahead(e)) continue;
    count++;
    above = e;
  }
  const rank = count + 1;
  return {
    rank,
    ranked: entries.length + (mine ? 0 : 1),
    next: above ? { rank: rank - 1, points: above.score - best + 1 } : null,
    row,
  };
}

/**
 * Each team's total: the sum of its finished runs' scores, leaving out hidden names and stored
 * names the word lists now refuse (isShownName). A run counts for the team stamped on it, so
 * runs from before teams count for nobody.
 */
export function teamTotals(db: Database): Record<Team, number> {
  const rows = db
    .query(
      `SELECT e.team AS team, p.name AS name, SUM(e.score) AS total
       FROM events e JOIN players p ON p.id = e.player_id
       WHERE e.type = ? AND e.team IS NOT NULL AND lower(p.name) NOT IN (SELECT name_key FROM hidden_names)
       GROUP BY e.team, p.id`,
    )
    .all(RUN_ENDED) as { team: string; name: string; total: number | null }[];
  const totals = Object.fromEntries(TEAMS.map((t) => [t, 0])) as Record<Team, number>;
  for (const r of rows) if (isTeam(r.team) && isShownName(r.name)) totals[r.team] += r.total ?? 0;
  return totals;
}

/** A player's best finished score, or null with none. */
export function playerBest(db: Database, playerId: string): number | null {
  const row = db
    .query("SELECT MAX(score) AS best FROM events WHERE type = ? AND player_id = ?")
    .get(RUN_ENDED, playerId) as { best: number | null } | null;
  return row?.best ?? null;
}

/**
 * Hides a name (any case) from the top 10 and the team totals, including from players who take it later.
 * Returns the key and how many players have that name now, so the caller can say when a
 * hide reached nobody (a typo, say).
 */
export function hideName(db: Database, name: string, at: Date): { key: string; players: number } {
  const key = nameKey(name);
  db.query("INSERT OR IGNORE INTO hidden_names (name_key, at) VALUES (?, ?)").run(key, at.toISOString());
  const row = db.query("SELECT COUNT(*) AS n FROM players WHERE lower(name) = ?").get(key) as { n: number };
  return { key, players: row.n };
}

/**
 * Deletes every run (its run events) and every player, in one transaction, for a clean board
 * before the stream (`bun run reset`). Hidden names stay: moderation survives a wipe. Tables
 * and the file stay too, since a running server holds them open. Returns what was deleted.
 */
export function resetData(db: Database): { runs: number; players: number } {
  const marks = EVENT_TYPES.map(() => "?").join(", ");
  return db.transaction(() => {
    const runs = db
      .query(`SELECT COUNT(DISTINCT run_id) AS n FROM events WHERE type IN (${marks})`)
      .get(...EVENT_TYPES) as { n: number };
    db.query(`DELETE FROM events WHERE type IN (${marks})`).run(...EVENT_TYPES);
    const players = db.query("DELETE FROM players").run();
    return { runs: runs.n, players: players.changes };
  })();
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
