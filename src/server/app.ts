import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Database } from "bun:sqlite";
import {
  DuplicateRunEnd,
  findPlayer,
  findRunStart,
  playerBest,
  recordRunEnded,
  recordRunStarted,
  teamTotals,
  topTen,
  upsertPlayer,
  type TopRow,
} from "./db";
import { ASSET_PATHS, asset } from "./art";
import { MAX_UPGRADES, checkName, checkScore, isTeam, isUpgradeId, type Team, type UpgradeId } from "./rules";

/** At most this many run starts per IP per window (architecture.md, "Boundaries"). */
export const RUN_STARTS_PER_WINDOW = 30;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
/** Hundreds of clients polling the top 10 cost one query a second. */
export const TOP_CACHE_MS = 1000;
/** Team totals are cached the same way. */
export const TEAMS_CACHE_MS = TOP_CACHE_MS;
export const MAX_BODY_BYTES = 2048;
/** Browsers and link-preview crawlers keep the icons and the preview for a day. */
export const ASSET_MAX_AGE_S = 86400;
const PLAYER_ID = /^[A-Za-z0-9-]{8,64}$/;

export type AppOptions = {
  /** The server's clock, in ms. Tests inject one. */
  now?: () => number;
  /** The address the rate limit counts by. */
  clientIp?: (c: Context) => string;
  /** Run starts allowed per IP per window. Defaults to the real limit; only `bun run load` raises it. */
  runStartsPerWindow?: number;
};

/**
 * Behind Railway the socket address is the proxy. Railway documents X-Real-IP as the client's
 * address (docs.railway.com, networking specs and limits), so that comes first. Otherwise the
 * rightmost X-Forwarded-For entry: the hop the last proxy appended (entries to its left are
 * whatever the client sent, and can be forged).
 */
export function forwardedClientIp(c: Context): string {
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  const last = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
  return last || "unknown";
}

// The API. Every route the UI calls lives under /api. /health answers once the app can serve.
// The icons and the link preview sit at the root, where browsers and crawlers look for them.
export function createApp(db: Database, opts: AppOptions = {}): Hono {
  const now = opts.now ?? Date.now;
  const clientIp = opts.clientIp ?? forwardedClientIp;
  const startsPerWindow = opts.runStartsPerWindow ?? RUN_STARTS_PER_WINDOW;
  const starts = new Map<string, number[]>();
  let topCache: { at: number; top: TopRow[] } | null = null;
  let teamsCache: { at: number; teams: Record<Team, number> } | null = null;

  const app = new Hono();
  app.get("/health", (c) => c.text("ok"));
  // The icons and the link preview, drawn in code (art.ts) on first request. Registered before
  // main.ts's static files and page fallback, so these paths never fall through to the page.
  for (const path of ASSET_PATHS) {
    app.get(path, () => {
      const { type, body } = asset(path);
      return new Response(body, { headers: { "content-type": type, "cache-control": `public, max-age=${ASSET_MAX_AGE_S}` } });
    });
  }
  app.use("/api/*", bodyLimit({ maxSize: MAX_BODY_BYTES }));

  app.post("/api/runs", async (c) => {
    const body = await readJson(c);
    if (
      !isRecord(body) ||
      typeof body.playerId !== "string" ||
      typeof body.name !== "string" ||
      (body.team !== undefined && !isTeam(body.team))
    ) {
      return c.json({ error: "body" }, 400);
    }
    if (!PLAYER_ID.test(body.playerId)) return c.json({ error: "playerId" }, 400);
    const name = checkName(body.name);
    if (!name.ok) return c.json({ error: "name", reason: name.reason }, 400);
    // A new player must pick a team. A player from before teams (no team stored) still plays,
    // and their runs count for nobody until they send one. A stored team is never switched:
    // a different team sent later is ignored.
    const sentTeam = body.team ?? null;
    const existing = findPlayer(db, body.playerId);
    if (!existing && !sentTeam) return c.json({ error: "team" }, 400);
    const team = existing?.team ?? sentTeam;

    const t = now();
    const ip = clientIp(c);
    const recent = (starts.get(ip) ?? []).filter((at) => t - at < RATE_WINDOW_MS);
    if (recent.length >= startsPerWindow) {
      starts.set(ip, recent);
      return c.json({ error: "rate" }, 429);
    }
    recent.push(t);
    starts.set(ip, recent);
    pruneStarts(starts, t);

    const runId = crypto.randomUUID();
    const at = new Date(t);
    recordRunStarted(db, runId, body.playerId, at, team);
    // The run is saved: answer 200 even if the follow-up write fails, so a retry never
    // duplicates it. A failed upsert only leaves this run off the top 10 and the team totals.
    try {
      upsertPlayer(db, body.playerId, name.name, sentTeam, at);
    } catch (err) {
      console.error(`run ${runId}: saving player ${body.playerId} failed`, err);
    }
    return c.json({ runId });
  });

  app.post("/api/runs/:id/end", async (c) => {
    const body = await readJson(c);
    if (
      !isRecord(body) ||
      typeof body.score !== "number" ||
      typeof body.squashes !== "number" ||
      typeof body.seconds !== "number" ||
      typeof body.touch !== "boolean" ||
      !isUpgrades(body.upgrades)
    ) {
      return c.json({ error: "body" }, 400);
    }
    const runId = c.req.param("id");
    const start = findRunStart(db, runId);
    if (!start) return c.json({ error: "run" }, 404);

    const t = now();
    const elapsedSeconds = (t - start.at.getTime()) / 1000;
    const claim = { score: body.score, squashes: body.squashes, seconds: body.seconds };
    const plausible = checkScore(claim, elapsedSeconds);
    if (!plausible.ok) return c.json({ error: "implausible", reason: plausible.reason }, 422);

    try {
      recordRunEnded(
        db,
        { runId, playerId: start.playerId, ...claim, touch: body.touch, upgrades: body.upgrades, team: start.team },
        new Date(t),
      );
    } catch (err) {
      if (err instanceof DuplicateRunEnd) return c.json({ error: "duplicate" }, 409);
      throw err;
    }
    return c.json({ ok: true });
  });

  app.get("/api/top", (c) => {
    const t = now();
    if (!topCache || t - topCache.at >= TOP_CACHE_MS) topCache = { at: t, top: topTen(db) };
    return c.json({ top: topCache.top });
  });

  app.get("/api/teams", (c) => {
    const t = now();
    if (!teamsCache || t - teamsCache.at >= TEAMS_CACHE_MS) teamsCache = { at: t, teams: teamTotals(db) };
    return c.json({ teams: teamsCache.teams });
  });

  app.get("/api/players/:id/best", (c) => c.json({ best: playerBest(db, c.req.param("id")) }));

  return app;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The upgrades a run took, in pick order: known ids only, so what is stored is always real. */
function isUpgrades(v: unknown): v is UpgradeId[] {
  return Array.isArray(v) && v.length <= MAX_UPGRADES && v.every(isUpgradeId);
}

/** Drops IPs with no start inside the window, so the map doesn't grow without bound. */
function pruneStarts(starts: Map<string, number[]>, t: number): void {
  if (starts.size < 1000) return;
  for (const [ip, times] of starts) {
    if (times.every((at) => t - at >= RATE_WINDOW_MS)) starts.delete(ip);
  }
}
