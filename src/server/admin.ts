// The owner's live operations over HTTP (#110): stats, hide and reset against the running server,
// so they work on Railway without a shell in the container. `bun run admin` calls them
// (scripts/admin-cli-lib.ts). Off unless ADMIN_TOKEN is set; never linked from the game.
//
// Order inside the handler is fixed: 404 when off, then the rate limit, then 401, then 400, then
// act. Off first, so nothing says the routes exist; the limit before auth, so guessing tokens is
// throttled. The token and the Authorization header are never logged.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import { computeStats, hideName, resetData, type Stats } from "./db";

export const ADMIN_PREFIX = "/api/admin";
/** A shorter ADMIN_TOKEN keeps the routes off: too easy to guess. */
export const MIN_TOKEN_LENGTH = 16;
/** Admin requests allowed per client per window. */
export const ADMIN_REQUESTS_PER_WINDOW = 10;
export const ADMIN_WINDOW_MS = 60_000;
/** Past this many tracked clients, expired windows are dropped. */
const LIMITER_PRUNE_AT = 1000;

// The wording `bun run stats`, `hide` and `reset` print, shared with the routes (scripts/admin-lib.ts
// imports these; the server never imports from scripts/).

/** The four lines of the bet signal. */
export function statsLines(stats: Stats): string[] {
  return [
    `players: ${stats.players}`,
    `finished_runs: ${stats.finishedRuns}`,
    `median_runs_per_player: ${stats.medianRunsPerPlayer.toFixed(1)}`,
    `touch_share: ${stats.touchShare}%`,
  ];
}

export function hideLine(key: string, players: number): string {
  return players === 0
    ? `hidden: ${key} (no saved player has this name yet; anyone playing as it now is kicked within 5 s; check the spelling if you expected a saved player)`
    : `hidden: ${key} (${players} player${players === 1 ? "" : "s"})`;
}

export function resetLine(runs: number, players: number): string {
  return `reset: deleted ${runs} run${runs === 1 ? "" : "s"} and ${players} player${players === 1 ? "" : "s"} (hidden names kept)`;
}

/** The admin token from the environment, and a startup line that says whether the routes are on (never the token). */
export function adminTokenFrom(env: Record<string, string | undefined>): { token: string | null; line: string } {
  const token = env.ADMIN_TOKEN?.trim() ?? "";
  if (!token) return { token: null, line: "admin routes off (no ADMIN_TOKEN)" };
  if (token.length < MIN_TOKEN_LENGTH) {
    return { token: null, line: `admin routes off: ADMIN_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters` };
  }
  return { token, line: "admin routes on" };
}

/**
 * The client's address, for the rate limit (release 1's pickClientIp with no trusted hops):
 * X-Real-IP, which Railway documents as the client's address, else the rightmost
 * X-Forwarded-For entry (the hop the last proxy appended), else the peer. Never throws.
 */
export function clientKey(header: (name: string) => string | undefined, peer: () => string | undefined): string {
  try {
    const real = header("x-real-ip")?.trim();
    if (real) return real;
    const last = header("x-forwarded-for")?.split(",").pop()?.trim();
    return last || peer() || "unknown";
  } catch {
    return "unknown";
  }
}

/** A fixed window per key. Per client rather than global, so a stranger cannot lock the owner out mid-stream. */
export function createLimiter(opts: { max: number; windowMs: number; now: () => number }): { hit(key: string): boolean } {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key) {
      const t = opts.now();
      if (windows.size > LIMITER_PRUNE_AT) {
        for (const [k, w] of windows) if (t - w.start >= opts.windowMs) windows.delete(k);
      }
      const w = windows.get(key);
      if (!w || t - w.start >= opts.windowMs) {
        windows.set(key, { start: t, count: 1 });
        return opts.max >= 1;
      }
      w.count++;
      return w.count <= opts.max;
    },
  };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export type AdminOptions = {
  /** null: the routes answer 404. */
  token: string | null;
  now: () => number;
  /** The rate limit's key for a request. */
  clientKey: (c: Context) => string;
};

/** Mounts /api/admin/*. Call before servePages, whose fallback would answer the game page. */
export function mountAdminRoutes(app: Hono, db: Database, opts: AdminOptions): void {
  const expected = opts.token === null ? null : digest(opts.token);
  const limiter = createLimiter({ max: ADMIN_REQUESTS_PER_WINDOW, windowMs: ADMIN_WINDOW_MS, now: opts.now });
  const notFound = (c: Context) => c.text("not found", 404);
  const badRequest = (c: Context, error: string) => c.json({ error }, 400);

  const handle = async (c: Context) => {
    if (expected === null) return notFound(c);
    if (!limiter.hit(opts.clientKey(c))) return c.text("too many requests", 429);
    // SHA-256 both sides, so the compare is constant-time and the length does not leak.
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    if (!m || !timingSafeEqual(digest(m[1]!), expected)) return c.text("unauthorized", 401);

    const path = c.req.path;
    const method = c.req.method;
    if (path === `${ADMIN_PREFIX}/stats` && method === "GET") {
      const range: { since?: string; until?: string } = {};
      for (const k of ["since", "until"] as const) {
        const v = c.req.query(k);
        if (v === undefined || v === "") continue;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return badRequest(c, `${k}: not an ISO time: ${v}`);
        // Stored times are UTC ISO strings, so the range compares in the same form.
        range[k] = d.toISOString();
      }
      return c.json({ lines: statsLines(computeStats(db, range)) });
    }
    if (path === `${ADMIN_PREFIX}/hide` && method === "POST") {
      const body = await jsonBody(c);
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return badRequest(c, 'hide needs {"name": "<name>"}');
      const { key, players } = hideName(db, name, new Date(opts.now()));
      return c.json({ lines: [hideLine(key, players)] });
    }
    if (path === `${ADMIN_PREFIX}/reset` && method === "POST") {
      const body = await jsonBody(c);
      if (body?.confirm !== true) return badRequest(c, 'reset needs {"confirm": true}');
      const { runs, players } = resetData(db);
      return c.json({ lines: [resetLine(runs, players)] });
    }
    return notFound(c);
  };
  app.all(ADMIN_PREFIX, handle);
  app.all(`${ADMIN_PREFIX}/*`, handle);
}

/** The request's JSON object, or null for no body, invalid JSON or anything not an object. */
async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await c.req.json();
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
