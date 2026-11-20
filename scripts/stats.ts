// `bun run stats [-- --since <ISO> --until <ISO>]`: prints the PRD's bet signal, exactly four
// lines, the same format whether or not any data exists yet (zeros on a fresh clone, and no
// database is created). `--since` is inclusive and `--until` exclusive, on the run's end time.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeStats, openDb, type Stats } from "../src/server/db";

function parseArgs(argv: string[]): { since?: string; until?: string } {
  const out: { since?: string; until?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    const m = /^--(since|until)(?:=(.*))?$/.exec(arg);
    if (!m) fail(`unknown argument: ${arg}`);
    const value = m[2] ?? argv[++i];
    if (value === undefined) fail(`--${m[1]} needs an ISO time`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) fail(`--${m[1]}: not an ISO time: ${value}`);
    // Stored times are UTC ISO strings; normalizing makes "2026-11-28T09:00:00-06:00" compare right.
    out[m[1] as "since" | "until"] = date.toISOString();
  }
  return out;
}

function fail(message: string): never {
  console.error(`stats: ${message}`);
  console.error("usage: bun run stats [-- --since <ISO time> --until <ISO time>]");
  process.exit(1);
}

const range = parseArgs(process.argv.slice(2));
const path = join(process.env.DATA_DIR ?? "data", "app.db");
let stats: Stats = { players: 0, finishedRuns: 0, medianRunsPerPlayer: 0, touchShare: 0 };
if (existsSync(path)) {
  const db = openDb(path);
  try {
    stats = computeStats(db, range);
  } finally {
    db.close();
  }
}
console.log(`players: ${stats.players}`);
console.log(`finished_runs: ${stats.finishedRuns}`);
console.log(`median_runs_per_player: ${stats.medianRunsPerPlayer.toFixed(1)}`);
console.log(`touch_share: ${stats.touchShare}%`);
