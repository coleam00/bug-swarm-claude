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
  /** How often live arenas are checked for hidden names, ms; defaults to the real one (tests shorten it). */
  hideSweepMs?: number;
};

export type RunningServer = {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  rooms: Rooms;
  /**
   * Stops the server for a redeploy (or a test's end): ends and saves every life in progress with
   * its score so far, sends every socket `error restarting` and closes it, stops the listener, and
   * writes every queued life. Resolves to the number of lives it ended. Calling it again returns
   * the same promise.
   */
  stop(): Promise<number>;
};

/** How long stop waits for the sockets to finish closing before it cuts them, ms. */
export const SOCKET_CLOSE_WAIT_MS = 500;
/** The shutdown's backstop: the process exits by then whatever is still running, ms (the item asks for 5 s, #69; Railway must allow at least that: architecture.md, "Hosting"). */
export const SHUTDOWN_BUDGET_MS = 4500;

export type ShutdownDeps = {
  /** RunningServer.stop. */
  stop: () => Promise<number>;
  closeDb: () => void;
  exit: (code: number) => void;
  log: (line: string) => void;
  budgetMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
};

/**
 * The SIGTERM / SIGINT handler's work (main.ts wires the signals): stops the server (lives saved,
 * sockets told to reconnect), closes the database and exits 0. If that has not finished within
 * `budgetMs` it exits 1 anyway. A second signal while it runs does nothing.
 */
export function gracefulShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    setTimer(() => {
      deps.log(`shutdown (${signal}): still stopping after ${deps.budgetMs ?? SHUTDOWN_BUDGET_MS} ms, exiting`);
      deps.exit(1);
    }, deps.budgetMs ?? SHUTDOWN_BUDGET_MS);
    try {
      const saved = await deps.stop();
      deps.closeDb();
      deps.log(`shutdown (${signal}): ${saved} ${saved === 1 ? "life" : "lives"} saved`);
      deps.exit(0);
    } catch (err) {
      deps.log(`shutdown (${signal}): failed: ${String(err)}`);
      deps.exit(1);
    }
  };
}

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
  const rooms = new Rooms({ buildId: opts.buildId, saveLife: lives.save });
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

  let stopping: Promise<number> | null = null;
  const stop = async (): Promise<number> => {
    // While the arenas still exist: every life in progress ends and is queued, then written at
    // once, so the lives are on disk even if a later step hangs.
    const ended = rooms.endAll();
    lives.flush();
    sockets.restart();
    // Let the error frames and close handshakes finish before the listener cuts what is left.
    const deadline = performance.now() + SOCKET_CLOSE_WAIT_MS;
    while (sockets.openCount > 0 && performance.now() < deadline) await Bun.sleep(10);
    await server.stop(true);
    // Anything queued since (nothing should be) is written before the caller closes the database.
    lives.flush();
    return ended;
  };

  return {
    url: `http://${opts.hostname}:${server.port}`,
    server,
    rooms,
    stop() {
      stopping ??= stop();
      return stopping;
    },
  };
}
