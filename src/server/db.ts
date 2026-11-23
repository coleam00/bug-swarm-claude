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

export type RunEnd = {
  runId: string;
  playerId: string;
  score: number;
  squashes: number;
  seconds: number;
  touch: boolean;
  /** Release 1 stored the upgrades a run took; an arena life stores none. */
  upgrades: readonly string[];
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

/** One player's row before the ranking keeps one per name: their best score and when they first finished a run (the tie order). */
export type RankEntry = { playerId: string; name: string; score: number; firstAt: string };

/**
 * One row per name (`nameKey`, any case), each at its best life, highest first, non-hidden
 * names only, so one name can't fill the top 10 however many players take it (#106). Ties go to
 * the player who finished a run first, then to the lower player id, so the order is total; a
 * name's row is the first of its players in that order, with that player's stored spelling.
 * The top 10 is its first ten rows and a player's rank is their name's place in it (rankOf).
 * Stored names the word lists now refuse (isShownName) are left out too: those rows stay
 * stored, they are only not shown, and they are dropped before the cut to 10, so a high-ranked
 * one doesn't shorten the board.
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
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!isShownName(r.name)) return false;
    const key = nameKey(r.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The first ten rows of the ranking: best life per name, one row each. */
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
 * Where a player stands. The ranking has one row per name, and a player is ranked only when
 * their own life is the one on their name's row (owner ruling on #106). `rank` is that row's
 * place among `ranked` visible names (null when hidden, with no finished run, or when another
 * player's life holds the name's row); `next` is the rank just above and how many points above
 * the player's own best it takes to pass it (one more than that rank's score minus their best);
 * `row` is the name's index in the top 10 rows, when it is in them and the life on it is theirs.
 * `held`, only when another player's life holds the name's row: that row's name as stored, its
 * rank and score ("Churn holds #1 with 1,900").
 */
export type Me = {
  rank: number | null;
  ranked: number;
  next: { rank: number; points: number } | null;
  row: number | null;
  held?: { name: string; rank: number; score: number };
};

/**
 * The index of a player's name's row in a ranking, or -1: the row with their name (any case),
 * else the row with their id (renamed since the ranking was read: their old row is still theirs
 * until the next read).
 */
function nameRow(entries: RankEntry[], playerId: string, name: string | null): number {
  const key = name === null ? null : nameKey(name);
  const at = key === null ? -1 : entries.findIndex((e) => nameKey(e.name) === key);
  return at >= 0 ? at : entries.findIndex((e) => e.playerId === playerId);
}

/**
 * Ranks a player against a ranking, by their name (`name`, their current stored name, or null
 * when the server has never stored them). The ranking has one row per name: when the life on the
 * name's row is another player's and `best` does not beat it, this player has no rank or row,
 * and `held` says who holds the name and where (owner ruling on #106). Otherwise the row is
 * theirs, or becomes theirs: `best` may be fresher than the ranking (a run that finished since it
 * was read), and the name is placed by the higher of it and the row, with the row's first-finish
 * time, or after everyone already in it when the name is not in it yet. `next.points` is how many points above this
 * player's own best (not the name's) it takes to pass the rank above. `row` follows the ranking as it is, since it points into
 * the rows read with it.
 */
export function rankOf(entries: RankEntry[], playerId: string, name: string | null, best: number | null, hidden: boolean): Me {
  const at = nameRow(entries, playerId, name);
  const mine = at >= 0 ? entries[at]! : null;
  if (hidden) return { rank: null, ranked: entries.length, next: null, row: null };
  // Another player's life on the name's row, not beaten by this player's best: not theirs.
  if (mine && mine.playerId !== playerId && (best === null || best <= mine.score)) {
    return { rank: null, ranked: entries.length, next: null, row: null, held: { name: mine.name, rank: at + 1, score: mine.score } };
  }
  const row = at >= 0 && at < 10 ? at : null;
  if (best === null) return { rank: null, ranked: entries.length, next: null, row: null };
  const score = mine ? Math.max(best, mine.score) : best;
  // The ranking's order: score down, then first finish, then id. Not in the ranking yet: their
  // first finish is after the ranking was read, so after everyone in it.
  const ahead = (e: RankEntry) =>
    e.score > score ||
    (e.score === score && (mine === null || e.firstAt < mine.firstAt || (e.firstAt === mine.firstAt && e.playerId < mine.playerId)));
  let above: RankEntry | null = null;
  let count = 0;
  for (const e of entries) {
    if (e === mine || !ahead(e)) continue;
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
 * The top 10 as one player should see it: the ranking's rows with that player's name's row placed
 * by their fresh best at their fresh rank (`me`, from rankOf with the same `name` and `best`), so a
 * life that just ended is on their top 10 at once and `row` points at it. The ranking has one row
 * per name (#106), so the name's row is the one replaced: a best that does not beat the name's row
 * leaves the rows as the ranking read them. The other rows stay as the ranking read them. A player
 * with no rank, or ranked below 10, gets the ranking's rows and `me` unchanged.
 */
export function topFor(entries: RankEntry[], playerId: string, name: string, best: number | null, me: Me): { top: TopRow[]; me: Me } {
  if (best === null || me.rank === null || me.rank > 10) return { top: topOf(entries), me };
  const at = nameRow(entries, playerId, name);
  if (at >= 0 && entries[at]!.score >= best) return { top: topOf(entries), me };
  const rows: TopRow[] = [];
  for (const [i, e] of entries.entries()) {
    if (rows.length >= 10) break;
    if (i !== at) rows.push({ name: e.name, score: e.score });
  }
  rows.splice(me.rank - 1, 0, { name, score: best });
  return { top: rows.slice(0, 10), me: { ...me, row: me.rank - 1 } };
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
