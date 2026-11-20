import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Database } from "bun:sqlite";
import {
  DuplicateRunEnd,
  findRunStart,
  playerBest,
  recordRunEnded,
  recordRunStarted,
  topTen,
  upsertPlayer,
  type TopRow,
} from "./db";
import { checkName, checkScore } from "./rules";

/** At most this many run starts per IP per window (architecture.md, "Boundaries"). */
export const RUN_STARTS_PER_WINDOW = 30;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
/** Hundreds of clients polling the top 10 cost one query a second. */
export const TOP_CACHE_MS = 1000;
export const MAX_BODY_BYTES = 2048;
const MAX_UPGRADES = 10;
const MAX_UPGRADE_LENGTH = 32;
const PLAYER_ID = /^[A-Za-z0-9-]{8,64}$/;

export type AppOptions = {
  /** The server's clock, in ms. Tests inject one. */
  now?: () => number;
  /** The address the rate limit counts by. */
  clientIp?: (c: Context) => string;
};

/**
 * Behind Railway the socket address is the proxy, so the client is the rightmost
 * X-Forwarded-For entry: the hop the platform's edge appended (entries to its left are
 * whatever the client sent, and can be forged).
 */
export function forwardedClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  const last = xff?.split(",").pop()?.trim();
  return last || "unknown";
}

// The API. Every route the UI calls lives under /api. /health answers once the app can serve.
export function createApp(db: Database, opts: AppOptions = {}): Hono {
  const now = opts.now ?? Date.now;
  const clientIp = opts.clientIp ?? forwardedClientIp;
  const starts = new Map<string, number[]>();
  let topCache: { at: number; top: TopRow[] } | null = null;

  const app = new Hono();
  app.get("/health", (c) => c.text("ok"));
  app.use("/api/*", bodyLimit({ maxSize: MAX_BODY_BYTES }));

  app.post("/api/runs", async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || typeof body.playerId !== "string" || typeof body.name !== "string") {
      return c.json({ error: "body" }, 400);
    }
    if (!PLAYER_ID.test(body.playerId)) return c.json({ error: "playerId" }, 400);
    const name = checkName(body.name);
    if (!name.ok) return c.json({ error: "name", reason: name.reason }, 400);

    const t = now();
    const ip = clientIp(c);
    const recent = (starts.get(ip) ?? []).filter((at) => t - at < RATE_WINDOW_MS);
    if (recent.length >= RUN_STARTS_PER_WINDOW) {
      starts.set(ip, recent);
      return c.json({ error: "rate" }, 429);
    }
    recent.push(t);
    starts.set(ip, recent);
    pruneStarts(starts, t);

    const runId = crypto.randomUUID();
    const at = new Date(t);
    recordRunStarted(db, runId, body.playerId, at);
    // The run is saved: answer 200 even if the follow-up write fails, so a retry never
    // duplicates it. A failed upsert only leaves this run off the top 10.
    try {
      upsertPlayer(db, body.playerId, name.name, at);
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
        { runId, playerId: start.playerId, ...claim, touch: body.touch, upgrades: body.upgrades },
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

function isUpgrades(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_UPGRADES &&
    v.every((u) => typeof u === "string" && u.length <= MAX_UPGRADE_LENGTH)
  );
}

/** Drops IPs with no start inside the window, so the map doesn't grow without bound. */
function pruneStarts(starts: Map<string, number[]>, t: number): void {
  if (starts.size < 1000) return;
  for (const [ip, times] of starts) {
    if (times.every((at) => t - at >= RATE_WINDOW_MS)) starts.delete(ip);
  }
}
