import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { hideCommand, resetCommand, statsCommand } from "../../scripts/admin-lib";
import {
  TEAMS,
  computeStats,
  hideName,
  openDb,
  recordRunEnded,
  recordRunStarted,
  resetData,
  teamTotals,
  topTen,
  upsertPlayer,
} from "./db";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "db-test-"));
  db = openDb(join(dir, "app.db"));
});

afterEach(() => {
  db.close(); // close before deleting: Windows refuses to delete an open file
  rmSync(dir, { recursive: true, force: true });
});

let runs = 0;
function run(playerId: string, at: string, opts: { touch?: boolean; finished?: boolean; score?: number } = {}) {
  const runId = `run-${++runs}`;
  const start = new Date(Date.parse(at) - 60_000);
  const team = TEAMS[0];
  upsertPlayer(db, playerId, playerId.toUpperCase(), team, start);
  recordRunStarted(db, runId, playerId, start, team);
  if (opts.finished === false) return;
  const end = { runId, playerId, score: opts.score ?? 60, squashes: 0, seconds: 60, touch: opts.touch ?? false, upgrades: [], team };
  recordRunEnded(db, end, new Date(at));
}

// The stream window is 15:00Z (9:00 CT) to 16:15Z (10:15 CT).
// a: 3 runs inside (one touch) and one exactly at the window's end; b: 1 touch run inside;
// c: 2 runs inside; d: only an abandoned run; e: 1 touch run before the window.
function fixture() {
  run("a", "2026-11-28T15:01:00.000Z", { touch: true });
  run("a", "2026-11-28T15:02:00.000Z");
  run("a", "2026-11-28T15:03:00.000Z");
  run("a", "2026-11-28T16:15:00.000Z");
  run("b", "2026-11-28T15:10:00.000Z", { touch: true });
  run("c", "2026-11-28T15:20:00.000Z");
  run("c", "2026-11-28T15:30:00.000Z");
  run("d", "2026-11-28T15:40:00.000Z", { finished: false });
  run("e", "2026-11-28T14:00:00.000Z", { touch: true });
}

test("stats on an empty database are zeros", () => {
  expect(computeStats(db)).toEqual({ players: 0, finishedRuns: 0, medianRunsPerPlayer: 0, touchShare: 0 });
});

test("stats over everything: even player count, abandoned runs not counted", () => {
  fixture();
  // finished runs per player: a 4, b 1, c 2, e 1 -> median of [1, 1, 2, 4] is 1.5; touch 3 of 8.
  expect(computeStats(db)).toEqual({ players: 4, finishedRuns: 8, medianRunsPerPlayer: 1.5, touchShare: 38 });
});

test("stats inside a window: since inclusive, until exclusive, odd player count", () => {
  fixture();
  const range = { since: "2026-11-28T15:00:00.000Z", until: "2026-11-28T16:15:00.000Z" };
  // a 3, b 1, c 2 -> median 2; touch 2 of 6.
  expect(computeStats(db, range)).toEqual({ players: 3, finishedRuns: 6, medianRunsPerPlayer: 2, touchShare: 33 });
  // since is inclusive: starting at a's first run keeps it.
  expect(computeStats(db, { since: "2026-11-28T15:01:00.000Z", until: range.until }).finishedRuns).toBe(6);
});

test("stats command prints the four zero lines with no database, and creates none", () => {
  const empty = join(dir, "none");
  const r = statsCommand([], empty);
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["players: 0", "finished_runs: 0", "median_runs_per_player: 0.0", "touch_share: 0%"]);
  expect(Bun.file(join(empty, "app.db")).size).toBe(0);
});

test("stats command -- --since --until filters, with times in any offset", () => {
  fixture();
  db.close();
  const r = statsCommand(["--", "--since", "2026-11-28T09:00:00-06:00", "--until=2026-11-28T10:15:00-06:00"], dir);
  db = openDb(join(dir, "app.db"));
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["players: 3", "finished_runs: 6", "median_runs_per_player: 2.0", "touch_share: 33%"]);
});

test("stats command refuses a time it can't read", () => {
  const r = statsCommand(["--since", "yesterday"], dir);
  expect(r.code).toBe(1);
  expect(r.out).toEqual([]);
});

test("a database file from before teams opens and gains events.team; its old runs count for nobody", () => {
  db.close();
  const path = join(dir, "old.db");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, at TEXT NOT NULL,
    run_id TEXT, player_id TEXT, score INTEGER, squashes INTEGER, seconds REAL, touch INTEGER, upgrades TEXT);`);
  old.exec("CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT, created_at TEXT NOT NULL);");
  old.exec("INSERT INTO players VALUES ('old', 'Old', NULL, '2026-11-01T00:00:00.000Z');");
  old.exec("INSERT INTO events (type, at, run_id, player_id, score) VALUES ('run_ended', '2026-11-01T00:01:00.000Z', 'r0', 'old', 99);");
  old.close();
  db = openDb(path);
  const columns = (db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
  expect(columns).toContain("team");
  expect(topTen(db)).toEqual([{ name: "Old", score: 99 }]); // still on the top 10
  expect(teamTotals(db)).toEqual({ tabs: 0, spaces: 0 });
});

const HIDE_AT = new Date("2026-11-28T16:00:00.000Z");

test("hide command removes a name from the top 10, whatever its case", () => {
  run("a", "2026-11-28T15:01:00.000Z", { score: 50 });
  run("b", "2026-11-28T15:02:00.000Z", { score: 40 });
  expect(topTen(db).map((r) => r.name)).toEqual(["A", "B"]);
  db.close();
  const r = hideCommand(["a"], dir, HIDE_AT);
  db = openDb(join(dir, "app.db"));
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["hidden: a (1 player)"]);
  expect(topTen(db)).toEqual([{ name: "B", score: 40 }]);
});

test("hide command says when no player has the name", () => {
  run("tester", "2026-11-28T15:01:00.000Z", { score: 50 });
  db.close();
  const r = hideCommand(["--", "Testr"], dir, HIDE_AT);
  db = openDb(join(dir, "app.db"));
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["hidden: testr (no player has this name yet; check the spelling)"]);
  expect(topTen(db)).toEqual([{ name: "TESTER", score: 50 }]);
});

test("hide command refuses, and creates nothing, when there is no database", () => {
  const missing = join(dir, "missing");
  const r = hideCommand(["Nobody"], missing, HIDE_AT);
  expect(r.code).toBe(1);
  expect(r.out).toEqual([]);
  expect(r.err.join(" ")).toContain(join(missing, "app.db"));
  expect(existsSync(missing)).toBe(false);
});

const ZERO_STATS = { players: 0, finishedRuns: 0, medianRunsPerPlayer: 0, touchShare: 0 };
const countRows = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("resetData deletes every run and player and keeps hidden names", () => {
  fixture(); // 9 runs (one abandoned) by 5 players
  hideName(db, "Rude", new Date("2026-11-28T15:00:00.000Z"));
  expect(resetData(db)).toEqual({ runs: 9, players: 5 });
  expect(topTen(db)).toEqual([]);
  expect(computeStats(db)).toEqual(ZERO_STATS);
  expect(countRows("events")).toBe(0);
  expect(countRows("players")).toBe(0);
  expect(countRows("hidden_names")).toBe(1);
  expect(resetData(db)).toEqual({ runs: 0, players: 0 });
});

test("reset command without --yes says what it would do and deletes nothing", () => {
  fixture();
  db.close();
  const bare = resetCommand([], dir);
  const other = resetCommand(["--", "--no"], dir);
  db = openDb(join(dir, "app.db"));
  for (const r of [bare, other]) {
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.join(" ")).toContain(join(dir, "app.db"));
  }
  expect(computeStats(db).finishedRuns).toBe(8);
  expect(countRows("players")).toBe(5);
});

test("reset command -- --yes empties runs and players, keeps hidden names, and prints the counts", () => {
  fixture();
  hideName(db, "Rude", new Date("2026-11-28T15:00:00.000Z"));
  db.close();
  const r = resetCommand(["--", "--yes"], dir);
  db = openDb(join(dir, "app.db"));
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["reset: deleted 9 runs and 5 players (hidden names kept)"]);
  expect(topTen(db)).toEqual([]);
  expect(computeStats(db)).toEqual(ZERO_STATS);
  expect(countRows("hidden_names")).toBe(1);
});

test("reset command refuses, and creates nothing, when there is no database", () => {
  const missing = join(dir, "missing");
  const r = resetCommand(["--yes"], missing);
  expect(r.code).toBe(1);
  expect(r.out).toEqual([]);
  expect(r.err.join(" ")).toContain(join(missing, "app.db"));
  expect(existsSync(missing)).toBe(false);
});

// The commands above are what `bun run stats`, `hide` and `reset` run, through these scripts.
test("bun run stats, hide and reset run their scripts", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts.stats).toBe("bun scripts/stats.ts");
  expect(pkg.scripts.hide).toBe("bun scripts/hide.ts");
  expect(pkg.scripts.reset).toBe("bun scripts/reset.ts");
});
