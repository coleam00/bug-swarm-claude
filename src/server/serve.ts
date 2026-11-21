// Starts the production server: the API, /api/arena/stats, the built pages, and the arena's /ws
// WebSocket, on one Bun server. main.ts calls it with the environment; the arena's integration
// test calls it on port 0 and stops it before it ends.
import type { Database } from "bun:sqlite";
import { TOP_CACHE_MS, createApp, type AppOptions } from "./app";
import { hiddenKeys } from "./db";
import { mountArenaRoutes } from "./arena/http";
import { createLifeSaver } from "./arena/lives";
import { Rooms } from "./arena/rooms";
import { createArenaSockets, newSocketData, type Liveness, type SocketData } from "./arena/sockets";
import { isShownName, nameKey } from "./rules";
import { servePages } from "./ui";

export type ServerOptions = {
  port: number;
  hostname: string;
  db: Database;
  /** The built UI (dist/). */
  distDir: string;
  appOptions?: AppOptions;
  /** Sent in every arena welcome. */
  buildId: string;
  /** How the arena pings sockets and drops silent ones; defaults to the real timings (tests shorten them). */
  liveness?: Liveness;
  /** People plus fill bots per arena; defaults to FILL_TARGET (tests that count players pass 0). */
  arenaFill?: number;
  /** How often live arenas are checked for hidden names, ms; defaults to the real one (tests shorten it). */
  hideSweepMs?: number;
};

export type RunningServer = {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  rooms: Rooms;
  /** Stops every arena timer, closes every socket and the listener, and writes any queued life. */
  stop(): Promise<void>;
};

/** The build id the arena sends: Railway's commit, else BUILD_ID, else the start time. */
export function buildIdFrom(env: Record<string, string | undefined>, startedAt: number): string {
  return env.RAILWAY_GIT_COMMIT_SHA || env.BUILD_ID || String(startedAt);
}

/**
 * Is `name` hidden from the boards, as the ranking decides it: its key in the hidden names
 * (`bun run hide`), or refused by the word lists now. The hidden names are read at most once per
 * TOP_CACHE_MS, so a hide reaches a live arena within that plus one sweep (3 s at most). A failed
 * read is logged and keeps the last list read (none at first): play goes on.
 */
export function hiddenNames(db: Database, now: () => number = Date.now): (name: string) => boolean {
  let cache: { at: number; keys: Set<string> } | null = null;
  return (name) => {
    if (!isShownName(name)) return true;
    const t = now();
    if (!cache || t - cache.at >= TOP_CACHE_MS) {
      try {
        cache = { at: t, keys: hiddenKeys(db) };
      } catch (err) {
        console.error("arena: reading hidden names failed", err);
        cache = { at: t, keys: cache?.keys ?? new Set() };
      }
    }
    return cache.keys.has(nameKey(name));
  };
}

export function startServer(opts: ServerOptions): RunningServer {
  const app = createApp(opts.db, opts.appOptions);
  // Finished lives are saved as runs, off the tick (lives.ts).
  const lives = createLifeSaver(opts.db);
  const rooms = new Rooms({ buildId: opts.buildId, saveLife: lives.save, fillTo: opts.arenaFill });
  // Before servePages: its catch-all answers every path it reaches.
  mountArenaRoutes(app, rooms);
  // The stream board, the arena page, the game's page and the built files, in that order (ui.ts).
  servePages(app, opts.distDir);

  const sockets = createArenaSockets(rooms, { liveness: opts.liveness, isHidden: hiddenNames(opts.db), sweepMs: opts.hideSweepMs });
  const server = Bun.serve<SocketData>({
    port: opts.port,
    hostname: opts.hostname,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") {
        return srv.upgrade(req, { data: newSocketData() }) ? undefined : new Response("websocket expected", { status: 426 });
      }
      return app.fetch(req, srv);
    },
    websocket: sockets,
  });

  return {
    url: `http://${opts.hostname}:${server.port}`,
    server,
    rooms,
    async stop() {
      sockets.stop();
      rooms.close();
      await server.stop(true);
      // Lives queued before the stop are written before the caller closes the database.
      lives.flush();
    },
  };
}
