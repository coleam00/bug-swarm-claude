import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { computeStats, openDb, recordRunEnded, recordRunStarted, topTen, upsertPlayer } from "./db";

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
  upsertPlayer(db, playerId, playerId.toUpperCase(), start);
  recordRunStarted(db, runId, playerId, start);
  if (opts.finished === false) return;
  const end = { runId, playerId, score: opts.score ?? 60, squashes: 0, seconds: 60, touch: opts.touch ?? false, upgrades: [] };
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
