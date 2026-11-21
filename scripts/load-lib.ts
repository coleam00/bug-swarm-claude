// The pure half of `bun run load`: arguments, the players' names and claims, the routes, and
// the summary math. No network here, so `bun test` covers it; `load.ts` makes the requests.
import { MAX_UPGRADES, POINTS_PER_SECOND, POINTS_PER_SQUASH, TEAMS, UPGRADE_IDS, type Team, type UpgradeId } from "../src/server/rules";

export const USAGE = "usage: bun run load -- --url <base url> [--players 500] [--seconds 60]";
/** The bar from the PRD: 95% of requests under this many ms, and no 5xx (the load test also fails on any 4xx). */
export const FAST_MS = 200;
export const FAST_SHARE = 0.95;

export type LoadArgs = { url: string; players: number; seconds: number };

const INT_FLAGS = {
  players: { def: 500, min: 1, max: 5000 },
  seconds: { def: 60, min: 5, max: 3600 },
} as const;
type IntFlag = keyof typeof INT_FLAGS;
const INT_FLAG_NAMES = Object.keys(INT_FLAGS) as IntFlag[];

/** Parses `--url`, `--players` and `--seconds`, as `--x v` or `--x=v`. Throws a message on anything else. */
export function parseLoadArgs(argv: string[]): LoadArgs {
  const seen: Record<string, string> = {};
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`unexpected argument "${arg}"`);
    const key = m[1]!;
    if (key !== "url" && !(INT_FLAG_NAMES as string[]).includes(key)) throw new Error(`unknown flag --${key}`);
    let value = m[2];
    if (value === undefined) {
      value = args[++i];
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    seen[key] = value;
  }
  if (seen.url === undefined) throw new Error("--url is required");
  let url: URL;
  try {
    url = new URL(seen.url);
  } catch {
    throw new Error(`--url "${seen.url}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must be http or https");
  const out: LoadArgs = { url: url.href.replace(/\/+$/, ""), players: 0, seconds: 0 };
  for (const key of INT_FLAG_NAMES) {
    const { def, min, max } = INT_FLAGS[key];
    const raw = seen[key];
    const n = raw === undefined ? def : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${key} must be a whole number from ${min} to ${max}`);
    out[key] = n;
  }
  return out;
}

/** Load-test players are `load-0000` to `load-4999`, so they are easy to spot and `bun run reset` clears them. */
export function loadName(i: number): string {
  return `load-${String(i).padStart(4, "0")}`;
}

export function loadPlayerId(i: number): string {
  return `load-player-${String(i).padStart(4, "0")}`;
}

export type Claim = { score: number; squashes: number; seconds: number; touch: boolean; upgrades: UpgradeId[] };

/**
 * A finished run that passes the server's plausibility check. `elapsedSeconds` is measured from
 * when the start response arrived, so it never exceeds the server's own elapsed time; one second
 * comes off on top. At most 3 squashes per claimed second (the server allows 5), and load runs
 * last at most 30 s (well under the server's MAX_RUN_SECONDS).
 */
export function claimFor(elapsedSeconds: number, rand: () => number): Claim {
  const seconds = Math.max(0, Math.floor(elapsedSeconds) - 1);
  const squashes = Math.floor(seconds * (1 + rand() * 2));
  const score = POINTS_PER_SQUASH * squashes + POINTS_PER_SECOND * seconds;
  const touch = rand() < 0.6;
  const upgrades: UpgradeId[] = [];
  const picks = Math.min(MAX_UPGRADES, Math.floor(seconds / 20));
  for (let k = 0; k < picks; k++) upgrades.push(UPGRADE_IDS[Math.floor(rand() * UPGRADE_IDS.length)]!);
  return { score, squashes, seconds, touch, upgrades };
}

/** The start body. A new player must send a team; load players alternate between them. */
export function startBody(i: number): { playerId: string; name: string; team: Team } {
  return { playerId: loadPlayerId(i), name: loadName(i), team: TEAMS[i % TEAMS.length]! };
}

/**
 * Every request the load test makes, by kind. `label` is the route pattern the report groups by
 * (all ends are one route); `path` builds the concrete URL. Players start and end runs, poll the
 * top 10 and team totals, and read their best as the game-over screen does; board watchers poll
 * the stream board's one read. `load.ts` calls every route here, so no row prints empty.
 */
export const ROUTES = {
  start: { label: "POST /api/runs", method: "POST", path: () => "/api/runs" },
  end: { label: "POST /api/runs/:id/end", method: "POST", path: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/end` },
  top: { label: "GET /api/top", method: "GET", path: () => "/api/top" },
  teams: { label: "GET /api/teams", method: "GET", path: () => "/api/teams" },
  best: {
    label: "GET /api/players/:id/best",
    method: "GET",
    path: (playerId: string) => `/api/players/${encodeURIComponent(playerId)}/best`,
  },
  board: { label: "GET /api/board", method: "GET", path: () => "/api/board" },
} as const;
export type RouteKind = keyof typeof ROUTES;

/**
 * How many /board tabs poll alongside the players: one per 50 players, at least one. The owner
 * runs one for the stream, and some viewers may open it too.
 */
export function boardWatchers(players: number): number {
  return Math.max(1, Math.round(players / 50));
}

export type Sample = { route: string; status: number | "error"; ms: number };

export type RouteSummary = {
  route: string;
  requests: number;
  /** Count per HTTP status; network errors and timeouts are `error`. */
  statuses: Record<string, number>;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** Share of requests that took under FAST_MS. */
  fastShare: number;
};
export type Summary = { routes: RouteSummary[]; overall: RouteSummary };

/** Nearest-rank percentile of an ascending list; null when it is empty. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function summarizeOne(route: string, samples: Sample[]): RouteSummary {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  for (const s of samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
  return {
    route,
    requests: samples.length,
    statuses,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    fastShare: samples.length === 0 ? 0 : ms.filter((m) => m < FAST_MS).length / samples.length,
  };
}

/** Per route (the given routes first, in order, even with no samples; then any others seen) and overall. */
export function summarize(samples: Sample[], routes: string[] = Object.values(ROUTES).map((r) => r.label)): Summary {
  const byRoute = new Map<string, Sample[]>(routes.map((r) => [r, []]));
  for (const s of samples) {
    const list = byRoute.get(s.route);
    if (list) list.push(s);
    else byRoute.set(s.route, [s]);
  }
  return {
    routes: [...byRoute].map(([route, list]) => summarizeOne(route, list)),
    overall: summarizeOne("overall", samples),
  };
}

export type Verdict = { pass: boolean; failed: string[] };

/**
 * Pass: at least 95% of all requests under 200 ms, no 4xx or 5xx, and no network error or timeout.
 * No request the load test makes should ever be refused: a 4xx means the test is wrong (a 429 from
 * a server started without RUN_STARTS_PER_WINDOW raised, a 400 from an outdated start body), and
 * fast refusals would otherwise read as a pass.
 */
export function verdict(summary: Summary): Verdict {
  const { overall } = summary;
  const failed: string[] = [];
  if (overall.requests === 0) failed.push("no requests were made");
  else if (overall.fastShare < FAST_SHARE) {
    failed.push(`${pct(overall.fastShare)} of requests under ${FAST_MS} ms (needs ${pct(FAST_SHARE)})`);
  }
  for (const kind of ["4", "5"]) {
    const n = Object.entries(overall.statuses)
      .filter(([s]) => s.length === 3 && s.startsWith(kind))
      .reduce((a, [, c]) => a + c, 0);
    if (n > 0) failed.push(`${n} ${kind}xx response${n === 1 ? "" : "s"}`);
  }
  const errors = overall.statuses.error ?? 0;
  if (errors > 0) failed.push(`${errors} network error${errors === 1 ? "" : "s"} or timeout${errors === 1 ? "" : "s"}`);
  return { pass: failed.length === 0, failed };
}

/** A share as a percentage, rounded down to 0.1 so 94.99% never prints as 95.0%. */
function pct(share: number): string {
  return `${(Math.floor(share * 1000) / 10).toFixed(1)}%`;
}

function msText(v: number | null): string {
  return v === null ? "-" : v.toFixed(1);
}

function statusText(statuses: Record<string, number>): string {
  const keys = Object.keys(statuses).sort();
  return keys.length === 0 ? "-" : keys.map((k) => `${k}:${statuses[k]}`).join(" ");
}

/** The printed report: one row per route, an overall row, then PASS or FAIL with the reasons. */
export function formatSummary(summary: Summary): string[] {
  const head = ["route", "requests", "statuses", "p50 ms", "p95 ms", "p99 ms", `<${FAST_MS} ms`];
  const row = (r: RouteSummary) => [
    r.route,
    String(r.requests),
    statusText(r.statuses),
    msText(r.p50),
    msText(r.p95),
    msText(r.p99),
    pct(r.fastShare),
  ];
  const rows = [head, ...summary.routes.map(row), row(summary.overall)];
  const widths = head.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  const line = (r: string[]) =>
    r
      .map((cell, c) => (c === 0 || c === 2 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!)))
      .join("  ")
      .trimEnd();
  const v = verdict(summary);
  return [...rows.map(line), v.pass ? "PASS" : `FAIL: ${v.failed.join("; ")}`];
}
