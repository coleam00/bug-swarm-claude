// `bun run load -- --url <base url> [--players 500] [--seconds 60]`: N simulated players start
// runs, play 5 to 30 s while polling the top 10 and team totals every 4 s, finish with a plausible
// score, then fetch their best, the top 10 and the team totals as the game-over screen does, and
// start again. Beside them, one /board tab per 50 players polls /api/board every 2 s. It prints
// requests, statuses and p50/p95/p99 per route, and exits 1 unless 95% of requests took under
// 200 ms with no 4xx or 5xx and no network error. The server must run with RUN_STARTS_PER_WINDOW
// raised (architecture.md, "How it runs"), or most starts are 429.
// Not part of `bun run check`: it takes a minute and needs a running server. load-lib.ts,
// its pure half, is tested.
import { BOARD_POLL_MS } from "../src/web/board/poll";
import { ROUTES, USAGE, boardWatchers, claimFor, formatSummary, parseLoadArgs, startBody, summarize, verdict, type LoadArgs, type RouteKind, type Sample } from "./load-lib";

/** The client's own timeout (src/web/api.ts). */
const TIMEOUT_MS = 5000;
/** The game-over screen polls the top 10 and team totals this often (src/web/App.tsx). */
const TOP_POLL_MS = 4000;
const PLAY_MS = { min: 5_000, max: 30_000 };
const RETRY_MS = 2000;
/** Runs in progress at the deadline still finish, up to this long after it. */
const DRAIN_MS = 35_000;

let args: LoadArgs;
try {
  args = parseLoadArgs(process.argv.slice(2));
} catch (err) {
  console.error(`load: ${err instanceof Error ? err.message : String(err)}`);
  console.error(USAGE);
  process.exit(1);
}

const samples: Sample[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const between = (min: number, max: number) => min + Math.random() * (max - min);

type Answer = { status: number | "error"; body: unknown };

/** One timed request: from fetch until the whole body is read. */
async function call(kind: RouteKind, path: string, body?: unknown): Promise<Answer> {
  const route = ROUTES[kind];
  const t0 = performance.now();
  try {
    const res = await fetch(args.url + path, {
      method: route.method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    samples.push({ route: route.label, status: res.status, ms: performance.now() - t0 });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON: the status is what counts
    }
    return { status: res.status, body: parsed };
  } catch {
    samples.push({ route: route.label, status: "error", ms: performance.now() - t0 });
    return { status: "error", body: null };
  }
}

const runId = (a: Answer) =>
  a.status === 200 && typeof a.body === "object" && a.body !== null && typeof (a.body as { runId?: unknown }).runId === "string"
    ? (a.body as { runId: string }).runId
    : null;

async function player(i: number, deadline: number, hardStop: number): Promise<void> {
  const { playerId } = startBody(i);
  await sleep(between(0, Math.min(10, args.seconds / 3) * 1000));
  while (performance.now() < deadline) {
    const id = runId(await call("start", ROUTES.start.path(), startBody(i)));
    if (id === null) {
      await sleep(RETRY_MS);
      continue;
    }
    const startedAt = performance.now();
    const endAt = startedAt + between(PLAY_MS.min, PLAY_MS.max);
    // Poll the top 10 and team totals through the run, from a random phase so players don't poll in step.
    let nextPoll = startedAt + between(0, TOP_POLL_MS);
    while (performance.now() < endAt && performance.now() < hardStop) {
      if (performance.now() >= nextPoll) {
        nextPoll += TOP_POLL_MS;
        await Promise.all([call("top", ROUTES.top.path()), call("teams", ROUTES.teams.path())]);
      } else {
        await sleep(Math.min(nextPoll, endAt) - performance.now());
      }
    }
    if (performance.now() >= hardStop) return;
    await call("end", ROUTES.end.path(id), claimFor((performance.now() - startedAt) / 1000, Math.random));
    await Promise.all([call("best", ROUTES.best.path(playerId)), call("top", ROUTES.top.path()), call("teams", ROUTES.teams.path())]);
  }
}

/** A /board tab: one read every BOARD_POLL_MS (the board's own cadence) until the deadline, from a random phase. */
async function boardWatcher(deadline: number): Promise<void> {
  let next = performance.now() + between(0, BOARD_POLL_MS);
  while (true) {
    await sleep(next - performance.now());
    if (performance.now() >= deadline) return;
    next += BOARD_POLL_MS;
    await call("board", ROUTES.board.path());
  }
}

try {
  const res = await fetch(`${args.url}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`load: the server at ${args.url} is not answering /health (${err instanceof Error ? err.message : String(err)})`);
  process.exit(1);
}

const watchers = boardWatchers(args.players);
console.log(`load: ${args.players} players and ${watchers} board watchers for ${args.seconds} s against ${args.url}`);
const t0 = performance.now();
const deadline = t0 + args.seconds * 1000;
const hardStop = deadline + DRAIN_MS;
await Promise.all([
  ...Array.from({ length: args.players }, (_, i) => player(i, deadline, hardStop)),
  ...Array.from({ length: watchers }, () => boardWatcher(deadline)),
]);
console.log(`load: done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const summary = summarize(samples);
for (const line of formatSummary(summary)) console.log(line);
process.exit(verdict(summary).pass ? 0 : 1);
