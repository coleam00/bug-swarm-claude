// Starts the production server: the API, /api/arena/stats, the built pages, and the arena's /ws
// WebSocket, on one Bun server. main.ts calls it with the environment; the arena's integration
// test calls it on port 0 and stops it before it ends.
import type { Database } from "bun:sqlite";
import { DT, JOINS_PER_ADDRESS_PER_MINUTE, MAX_SOCKETS_PER_ADDRESS, MAX_WATCHERS_PER_ADDRESS, WAVE_S } from "../shared/arena/constants";
import { adminTokenFrom, clientKey } from "./admin";
import { TOP_CACHE_MS, createApp, type AppOptions } from "./app";
import { hiddenKeys } from "./db";
import { dataDirFrom, listenConfig } from "./listen";
import { mountArenaRoutes } from "./arena/http";
import { createAddressGate, createOpenGate } from "./arena/gate";
import { createLifeSaver } from "./arena/lives";
import { Rooms } from "./arena/rooms";
import { createArenaSockets, newSocketData, type Liveness, type SocketData } from "./arena/sockets";
import { allowLoad, pickClientIp, proxyHops } from "./limits";
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
  /** Sockets that may watch arenas at once; defaults to MAX_WATCHERS (tests shrink it). */
  arenaWatchers?: number;
  /** Bots a watched arena with no people runs; defaults to DEMO_BOTS. */
  arenaDemo?: number;
  /** How often live arenas are checked for hidden names, ms; defaults to the real one (tests shorten it). */
  hideSweepMs?: number;
  /** Each new arena's first tick; 0 by default (startTickFrom: BUG_SWARM_START_WAVE, a debug aid, #85). */
  arenaStartTick?: number;
  /** Trusted proxies that append to X-Forwarded-For (TRUST_PROXY_HOPS, limits.ts); 0 by default. */
  proxyHops?: number;
  /**
   * True turns the per-address /ws limits off (BUG_SWARM_ALLOW_LOAD=1: `bun run bots` and the
   * playtest only, #104). False by default, so every caller that does not opt out has the limits.
   */
  allowLoad?: boolean;
  /** People who may play at once, server-wide; defaults to MAX_PEOPLE (tests shrink it). */
  maxPeople?: number;
  /** Where the /ws addresses and refusals are logged; defaults to nowhere (main.ts passes console.log). */
  log?: (line: string) => void;
  /** The owner's admin token (admin.ts adminTokenFrom); null or absent keeps /api/admin/* off. */
  adminToken?: string | null;
};

export type RunningServer = {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  rooms: Rooms;
  /** Sockets open on /ws now, welcomed, watching, or refused and not yet closed. */
  readonly openSockets: number;
  /**
   * Stops the server for a redeploy (or a test's end): ends every life in progress and saves each
   * that counts (lives.ts countsAsLife: not a 0-point life under 5 s) with its score so far, sends
   * every socket `error restarting` and closes it, stops the listener (waiting at most
   * LISTENER_STOP_WAIT_MS for it), and writes every queued life. Resolves to the number of lives it
   * ended; rejects if the listener stop does. Calling it again returns the same promise.
   */
  stop(): Promise<number>;
};

/** How long stop waits for the sockets to finish closing before it cuts them, ms. */
export const SOCKET_CLOSE_WAIT_MS = 500;
/** How long stop waits for Bun's listener stop to settle before it moves on, ms (#99: on Windows it once never settled). */
export const LISTENER_STOP_WAIT_MS = 1000;
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
 * The SIGTERM / SIGINT handler's work (main.ts wires the signals, and the IPC shutdown message): stops the server (lives ended, see lives.ts countsAsLife;
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
      const ended = await deps.stop();
      deps.closeDb();
      // Ended, not saved: a 0-point life under 5 s ends but is never saved (#114).
      deps.log(`shutdown (${signal}): ${ended} ${ended === 1 ? "life" : "lives"} ended`);
      deps.exit(0);
    } catch (err) {
      deps.log(`shutdown (${signal}): failed: ${String(err)}`);
      deps.exit(1);
    }
  };
}

/** The IPC message that stops the server gracefully, as SIGTERM does (#95). */
export const SHUTDOWN_MESSAGE = "shutdown";

/**
 * Routes SHUTDOWN_MESSAGE from a parent process into the graceful shutdown (main.ts wires it). A
 * parent that spawned the server with an IPC channel (the playtest's `--serve`, #95) restarts it
 * this way, because on Windows a signal to a child is a hard kill: its SIGTERM handler never runs
 * (measured with Bun 1.4.5: exit 143). Without an IPC channel nothing ever arrives. Any other
 * message is ignored.
 */
export function onShutdownMessage(proc: { on(event: "message", listener: (m: unknown) => void): unknown }, shutdown: (why: string) => unknown): void {
  proc.on("message", (m) => {
    if (m === SHUTDOWN_MESSAGE) shutdown("ipc");
  });
}

/**
 * Each new arena's first tick (#85, a debug aid for evidence, off by default): with
 * BUG_SWARM_START_WAVE a whole number of at least 2, the tick 10 s before that wave starts, so a
 * fresh arena reaches it 10 s after it opens (wave 5: a hive queen's marker). Anything else: 0.
 */
export function startTickFrom(env: Record<string, string | undefined>): number {
  const raw = env.BUG_SWARM_START_WAVE;
  const wave = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(wave) || wave < 2) return 0;
  return Math.round(((wave - 1) * WAVE_S - START_LEAD_S) / DT);
}

/** BUG_SWARM_START_WAVE's arenas open this long before the wave turns, seconds. */
export const START_LEAD_S = 10;

/** The build id the arena sends: Railway's commit, else BUILD_ID, else the start time. */
export function buildIdFrom(env: Record<string, string | undefined>, startedAt: number): string {
  return env.RAILWAY_GIT_COMMIT_SHA || env.BUILD_ID || String(startedAt);
}

/**
 * Everything main.ts takes from the environment, as one tested decision: the server's options
 * (all but the database), where the database lives, and the lines to log. In production a missing
 * DATA_DIR is an error and nothing starts (#110). ADMIN_TOKEN reaches the server here; the lines
 * never hold it. main.ts only applies this.
 */
export function startupFrom(
  env: Record<string, string | undefined>,
  startedAt: number,
): { error: string } | { dataDir: string; options: Omit<ServerOptions, "db">; lines: string[] } {
  const dir = dataDirFrom(env);
  if ("error" in dir) return dir;
  const { port, hostname } = listenConfig(env);
  const buildId = buildIdFrom(env, startedAt);
  // BUG_SWARM_START_WAVE=<n> (a debug aid for evidence, off by default): new arenas open 10 s before wave n.
  const arenaStartTick = startTickFrom(env);
  // ADMIN_TOKEN (optional) turns on the owner's /api/admin/* routes (admin.ts).
  const admin = adminTokenFrom(env);
  // TRUST_PROXY_HOPS: how the /ws limits find the client behind Railway's proxy (architecture.md,
  // "Client address behind a proxy"). BUG_SWARM_ALLOW_LOAD=1 turns the per-address limits off, for
  // `bun run bots` and the playtest only; never set on Railway (#104). A bad value of either stops the start.
  let hops: number;
  let loadAllowed: boolean;
  try {
    hops = proxyHops(env);
    loadAllowed = allowLoad(env);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const lines = [`App on http://${hostname}:${port} (build ${buildId}, data in ${dir.dataDir}, ${admin.line})`];
  if (hops > 0) lines.push(`trusting ${hops} proxy hop(s) in X-Forwarded-For`);
  if (loadAllowed) lines.push("per-address /ws limits off (BUG_SWARM_ALLOW_LOAD=1): load testing only");
  if (arenaStartTick > 0) lines.push(`Arenas open at tick ${arenaStartTick} (BUG_SWARM_START_WAVE=${env.BUG_SWARM_START_WAVE}): debug only`);
  return {
    dataDir: dir.dataDir,
    options: {
      port, hostname, distDir: "dist", buildId, arenaStartTick, adminToken: admin.token,
      proxyHops: hops, allowLoad: loadAllowed, log: (line) => console.log(line),
    },
    lines,
  };
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
  // Finished lives are saved as runs, off the tick (lives.ts).
  const lives = createLifeSaver(opts.db);
  const rooms = new Rooms({ buildId: opts.buildId, saveLife: lives.save, fillTo: opts.arenaFill, maxWatchers: opts.arenaWatchers, demoTo: opts.arenaDemo, startTick: opts.arenaStartTick, maxPeople: opts.maxPeople });
  // The board reads the open arenas live from the rooms.
  // The admin limit keys on the proxy headers, else the peer (read lazily: `server` is made below).
  const app = createApp(opts.db, {
    adminToken: opts.adminToken,
    clientKey: (c) => clientKey((name) => c.req.header(name), () => server.requestIP(c.req.raw)?.address),
    ...opts.appOptions,
    live: () => rooms.live(),
  });
  // Before servePages: its catch-all answers every path it reaches.
  mountArenaRoutes(app, rooms);
  // The stream board, the arena page, the game's page and the built files, in that order (ui.ts).
  servePages(app, opts.distDir);

  // The per-address limits (#104), off only with the load-test allowance.
  const gate = opts.allowLoad ? createOpenGate() : createAddressGate({ maxSockets: MAX_SOCKETS_PER_ADDRESS, maxWatchers: MAX_WATCHERS_PER_ADDRESS, joinsPerMinute: JOINS_PER_ADDRESS_PER_MINUTE });
  const sockets = createArenaSockets(rooms, { liveness: opts.liveness, isHidden: hiddenNames(opts.db), sweepMs: opts.hideSweepMs, gate, log: opts.log });
  const hops = opts.proxyHops ?? 0;
  const server = Bun.serve<SocketData>({
    port: opts.port,
    hostname: opts.hostname,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") {
        // The client's address, as the per-address limits count it (limits.ts, TRUST_PROXY_HOPS).
        const address = pickClientIp(
          (name) => req.headers.get(name) ?? undefined,
          () => srv.requestIP(req)?.address ?? "unknown",
          hops,
        );
        return srv.upgrade(req, { data: newSocketData(address) }) ? undefined : new Response("websocket expected", { status: 426 });
      }
      return app.fetch(req, srv);
    },
    websocket: sockets,
  });

  let stopping: Promise<number> | null = null;
  const stop = async (): Promise<number> => {
    // While the arenas still exist: every life in progress ends, and those that count (#114: not a
    // 0-point life under 5 s) are queued, then written at once, so they are on disk even if a later step hangs.
    const ended = rooms.endAll();
    lives.flush();
    sockets.restart();
    // Let the error frames and close handshakes finish before the listener cuts what is left.
    const deadline = performance.now() + SOCKET_CLOSE_WAIT_MS;
    while (sockets.openCount > 0 && performance.now() < deadline) await Bun.sleep(10);
    // Bounded: on Windows Bun's listener stop once never settled with browser players connected
    // (#99). The lives are already written, and exiting closes whatever the listener still holds.
    // A listener stop that rejects is a failure: stop() rejects with it, so gracefulShutdown logs it
    // and exits 1.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled: boolean;
    try {
      settled = await Promise.race([
        server.stop(true).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), LISTENER_STOP_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!settled) {
      console.warn(
        `stop: the listener had not stopped after ${LISTENER_STOP_WAIT_MS} ms (websockets ${server.pendingWebSockets}, requests ${server.pendingRequests}); moving on`,
      );
    }
    // Anything queued since (nothing should be) is written before the caller closes the database.
    lives.flush();
    return ended;
  };

  return {
    url: `http://${opts.hostname}:${server.port}`,
    server,
    rooms,
    get openSockets() {
      return sockets.openCount;
    },
    stop() {
      stopping ??= stop();
      return stopping;
    },
  };
}
