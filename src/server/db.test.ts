import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  TEAMS,
  computeStats,
  hideName,
  openDb,
  rankOf,
  recordRunEnded,
  recordRunStarted,
  resetData,
  teamTotals,
  topTen,
  upsertPlayer,
  type RankEntry,
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

function script(args: string[]) {
  const p = Bun.spawnSync(["bun", ...args], { env: { ...process.env, DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim().split(/\r?\n/) };
}

test("bun run stats prints the four zero lines with no database, and creates none", () => {
  const empty = join(dir, "none");
  const p = Bun.spawnSync(["bun", "scripts/stats.ts"], { env: { ...process.env, DATA_DIR: empty }, stdout: "pipe" });
  expect(p.stdout.toString().trim().split(/\r?\n/)).toEqual([
    "players: 0",
    "finished_runs: 0",
    "median_runs_per_player: 0.0",
    "touch_share: 0%",
  ]);
  expect(Bun.file(join(empty, "app.db")).size).toBe(0);
});

test("bun run stats -- --since --until filters, with times in any offset", () => {
  fixture();
  db.close();
  const r = script(["run", "stats", "--", "--since", "2026-11-28T09:00:00-06:00", "--until=2026-11-28T10:15:00-06:00"]);
  db = openDb(join(dir, "app.db"));
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["players: 3", "finished_runs: 6", "median_runs_per_player: 2.0", "touch_share: 33%"]);
});

test("bun run stats refuses a time it can't read", () => {
  expect(script(["scripts/stats.ts", "--since", "yesterday"]).code).toBe(1);
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

test("bun run hide removes a name from the top 10, whatever its case", () => {
  run("a", "2026-11-28T15:01:00.000Z", { score: 50 });
  run("b", "2026-11-28T15:02:00.000Z", { score: 40 });
  expect(topTen(db).map((r) => r.name)).toEqual(["A", "B"]);
  db.close();
  const r = script(["run", "hide", "a"]);
  db = openDb(join(dir, "app.db"));
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["hidden: a (1 player)"]);
  expect(topTen(db)).toEqual([{ name: "B", score: 40 }]);
});

test("bun run hide says when no player has the name", () => {
  run("tester", "2026-11-28T15:01:00.000Z", { score: 50 });
  db.close();
  const r = script(["run", "hide", "Testr"]);
  db = openDb(join(dir, "app.db"));
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["hidden: testr (no player has this name yet; check the spelling)"]);
  expect(topTen(db)).toEqual([{ name: "TESTER", score: 50 }]);
});

test("bun run hide refuses, and creates nothing, when there is no database", () => {
  const missing = join(dir, "missing");
  const p = Bun.spawnSync(["bun", "scripts/hide.ts", "Nobody"], {
    env: { ...process.env, DATA_DIR: missing },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toBe("");
  expect(p.stderr.toString()).toContain(join(missing, "app.db"));
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

test("bun run reset without --yes says what it would do and deletes nothing", () => {
  fixture();
  db.close();
  const bare = script(["run", "reset"]);
  const other = script(["scripts/reset.ts", "--", "--no"]);
  db = openDb(join(dir, "app.db"));
  for (const r of [bare, other]) expect(r.code).toBe(1);
  expect(computeStats(db).finishedRuns).toBe(8);
  expect(countRows("players")).toBe(5);
});

test("bun run reset -- --yes empties runs and players, keeps hidden names, and prints the counts", () => {
  fixture();
  hideName(db, "Rude", new Date("2026-11-28T15:00:00.000Z"));
  db.close();
  const r = script(["run", "reset", "--", "--yes"]);
  db = openDb(join(dir, "app.db"));
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["reset: deleted 9 runs and 5 players (hidden names kept)"]);
  expect(topTen(db)).toEqual([]);
  expect(computeStats(db)).toEqual(ZERO_STATS);
  expect(countRows("hidden_names")).toBe(1);
});

test("bun run reset refuses, and creates nothing, when there is no database", () => {
  const missing = join(dir, "missing");
  const p = Bun.spawnSync(["bun", "scripts/reset.ts", "--yes"], {
    env: { ...process.env, DATA_DIR: missing },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(p.exitCode).toBe(1);
  expect(p.stdout.toString()).toBe("");
  expect(p.stderr.toString()).toContain(join(missing, "app.db"));
  expect(existsSync(missing)).toBe(false);
});

describe("rankOf", () => {
  const entry = (playerId: string, score: number, firstAt: string): RankEntry => ({ playerId, name: playerId, score, firstAt });
  const entries = [entry("p-a", 100, "2026-11-28T15:00:01Z"), entry("p-b", 50, "2026-11-28T15:00:02Z"), entry("p-c", 50, "2026-11-28T15:00:03Z")];

  test("a player not in the ranking yet is placed after everyone tied with them, and counted", () => {
    expect(rankOf(entries, "p-new", 50, false)).toEqual({ rank: 4, ranked: 4, next: { rank: 3, points: 1 }, row: null });
    expect(rankOf(entries, "p-new", 101, false)).toEqual({ rank: 1, ranked: 4, next: null, row: null });
  });

  test("a fresh best above the stale cached one ranks by the fresh score; `row` stays the cached one", () => {
    expect(rankOf(entries, "p-c", 60, false)).toEqual({ rank: 2, ranked: 3, next: { rank: 1, points: 41 }, row: 2 });
  });

  test("past the top 10 there is no row", () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`p-${String(i).padStart(2, "0")}`, 100 - i, "2026-11-28T15:00:00Z"));
    expect(rankOf(many, "p-10", 90, false)).toEqual({ rank: 11, ranked: 12, next: { rank: 10, points: 2 }, row: null });
    expect(rankOf(many, "p-09", 91, false).row).toBe(9);
  });
});
