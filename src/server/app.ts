import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Database } from "bun:sqlite";
import { findPlayer, hiddenKeys, playerBest, rankOf, ranking, teamTotals, topOf, type RankEntry, type TopRow } from "./db";
import { ASSET_PATHS, asset } from "./art";
import { isShownName, type Team } from "./rules";
import type { LiveArenas } from "./arena/rooms";

/** Hundreds of clients polling the top 10 and their rank cost one ranking query a second. */
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
  /** The open arenas and the people in them, read live for the board (serve.ts passes Rooms.live). Defaults to none. */
  live?: () => LiveArenas;
};

// The API: reads only. Arena lives are saved by the server itself (arena/lives.ts), so the top 10,
// best, team totals and the board read what it saved. /health answers once the app can serve.
// The icons and the link preview sit at the root, where browsers and crawlers look for them.
export function createApp(db: Database, opts: AppOptions = {}): Hono {
  const now = opts.now ?? Date.now;
  const live = opts.live ?? (() => ({ playing: 0, arenas: [] }));
  let rankCache: { at: number; entries: RankEntry[]; top: TopRow[]; hidden: Set<string> } | null = null;
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

  // One ranking a second feeds the top 10, the board and every player's rank, so they agree.
  const cachedRanking = () => {
    const t = now();
    if (!rankCache || t - rankCache.at >= TOP_CACHE_MS) {
      const entries = ranking(db);
      rankCache = { at: t, entries, top: topOf(entries), hidden: hiddenKeys(db) };
    }
    return rankCache;
  };
  const cachedTop = (): TopRow[] => cachedRanking().top;
  const cachedTeams = (): Record<Team, number> => {
    const t = now();
    if (!teamsCache || t - teamsCache.at >= TEAMS_CACHE_MS) teamsCache = { at: t, teams: teamTotals(db) };
    return teamsCache.teams;
  };

  // With ?player=<id>, also where that player stands (`me`, db.ts rankOf). Their best is read
  // fresh and ranked against the 1 s snapshot, so a run that just finished ranks at once; `row`
  // points into the snapshot's rows and catches up on the next poll. No player id is ever sent back.
  app.get("/api/top", (c) => {
    const { entries, top, hidden } = cachedRanking();
    const id = c.req.query("player");
    if (id === undefined || !PLAYER_ID.test(id)) return c.json({ top });
    const p = findPlayer(db, id);
    // As the ranking's filters compare: lower(name) against the stored keys, and the word lists.
    const isHidden = p !== null && (hidden.has(p.name.toLowerCase()) || !isShownName(p.name));
    return c.json({ top, me: rankOf(entries, id, p?.name ?? null, playerBest(db, id), isHidden) });
  });
  app.get("/api/teams", (c) => c.json({ teams: cachedTeams() }));
  // The stream board: the top 10 and the team totals in one read, from the same two caches,
  // so the board moves from one snapshot to the next and costs no extra query. Plus the people
  // playing now and the open arenas, read live from the rooms on every request (no database,
  // no cache: a walk over the open arenas; bots never count).
  app.get("/api/board", (c) => c.json({ top: cachedTop(), teams: cachedTeams(), ...live() }));

  app.get("/api/players/:id/best", (c) => c.json({ best: playerBest(db, c.req.param("id")) }));

  return app;
}
