// The bodies of `bun run stats`, `bun run hide` and `bun run reset`, as functions that return
// their exit code and output lines instead of printing and exiting, so `bun test` runs them
// in-process. `stats.ts`, `hide.ts` and `reset.ts` print the lines and exit with the code.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hideLine, resetLine, statsLines } from "../src/server/admin";
import { computeStats, hideName, openDb, resetData, type Stats } from "../src/server/db";

export type CommandResult = { code: 0 | 1; out: string[]; err: string[] };

const STATS_USAGE = "usage: bun run stats [-- --since <ISO time> --until <ISO time>]";

export class ArgError extends Error {}

/** `--since` and `--until` as UTC ISO strings; throws ArgError on anything else. `bun run admin stats` reuses it. */
export function parseStatsArgs(argv: string[]): { since?: string; until?: string } {
  const out: { since?: string; until?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    const m = /^--(since|until)(?:=(.*))?$/.exec(arg);
    if (!m) throw new ArgError(`unknown argument: ${arg}`);
    const value = m[2] ?? argv[++i];
    if (value === undefined) throw new ArgError(`--${m[1]} needs an ISO time`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new ArgError(`--${m[1]}: not an ISO time: ${value}`);
    // Stored times are UTC ISO strings; normalizing makes "2026-11-28T09:00:00-06:00" compare right.
    out[m[1] as "since" | "until"] = date.toISOString();
  }
  return out;
}

/** `bun run stats`: the four lines of the bet signal. Zeros, and no database created, when there is none. */
export function statsCommand(argv: string[], dataDir: string): CommandResult {
  let range: { since?: string; until?: string };
  try {
    range = parseStatsArgs(argv);
  } catch (e) {
    if (!(e instanceof ArgError)) throw e;
    return { code: 1, out: [], err: [`stats: ${e.message}`, STATS_USAGE] };
  }
  const path = join(dataDir, "app.db");
  let stats: Stats = { players: 0, finishedRuns: 0, medianRunsPerPlayer: 0, touchShare: 0 };
  if (existsSync(path)) {
    const db = openDb(path);
    try {
      stats = computeStats(db, range);
    } finally {
      db.close();
    }
  }
  return { code: 0, out: statsLines(stats), err: [] };
}

/** `bun run hide "<name>"`: hides the name as of `now`. Refuses, creating nothing, when there is no database. */
export function hideCommand(argv: string[], dataDir: string, now: Date): CommandResult {
  const name = argv.filter((a) => a !== "--").join(" ").trim();
  if (!name) return { code: 1, out: [], err: ['usage: bun run hide "<name>"'] };
  const path = join(dataDir, "app.db");
  if (!existsSync(path)) {
    return { code: 1, out: [], err: [`hide: no database at ${path} (set DATA_DIR to the folder that holds app.db)`] };
  }
  const db = openDb(path);
  try {
    const { key, players } = hideName(db, name, now);
    return { code: 0, out: [hideLine(key, players)], err: [] };
  } finally {
    db.close();
  }
}

/** `bun run reset -- --yes`: deletes every run and player. Without `--yes`, or with no database, it opens nothing. */
export function resetCommand(argv: string[], dataDir: string): CommandResult {
  const args = argv.filter((a) => a !== "--");
  const path = join(dataDir, "app.db");
  if (args.length !== 1 || args[0] !== "--yes") {
    return { code: 1, out: [], err: [`reset: deletes every run and player in ${path}; run again with --yes`] };
  }
  if (!existsSync(path)) {
    return { code: 1, out: [], err: [`reset: no database at ${path} (set DATA_DIR to the folder that holds app.db)`] };
  }
  const db = openDb(path);
  try {
    const { runs, players } = resetData(db);
    // A running server needs no restart: its top 10 cache lasts 1 s, and a life in progress is
    // saved as a new run (with its player) when it ends.
    return { code: 0, out: [resetLine(runs, players)], err: [] };
  } finally {
    db.close();
  }
}

/** What the scripts (stats, hide, reset, admin) do with a result: errors to stderr, output to stdout, then exit with the code. */
export function finish(r: CommandResult): never {
  for (const line of r.err) console.error(line);
  for (const line of r.out) console.log(line);
  process.exit(r.code);
}
