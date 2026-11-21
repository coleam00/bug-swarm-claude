// Starts the production server: the API, /api/arena/stats, the built pages, and the arena's /ws
// WebSocket, on one Bun server. main.ts calls it with the environment; the arena's integration
// test calls it on port 0 and stops it before it ends.
import type { Database } from "bun:sqlite";
import { createApp, type AppOptions } from "./app";
import { mountArenaRoutes } from "./arena/http";
import { Rooms } from "./arena/rooms";
import { createArenaSockets, newSocketData, type SocketData } from "./arena/sockets";
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
};

export type RunningServer = {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  rooms: Rooms;
  /** Stops every arena timer and closes every socket and the listener. */
  stop(): Promise<void>;
};

/** The build id the arena sends: Railway's commit, else BUILD_ID, else the start time. */
export function buildIdFrom(env: Record<string, string | undefined>, startedAt: number): string {
  return env.RAILWAY_GIT_COMMIT_SHA || env.BUILD_ID || String(startedAt);
}

export function startServer(opts: ServerOptions): RunningServer {
  const app = createApp(opts.db, opts.appOptions);
  const rooms = new Rooms({ buildId: opts.buildId });
  // Before servePages: its catch-all answers every path it reaches.
  mountArenaRoutes(app, rooms);
  // The stream board, the arena page, the game's page and the built files, in that order (ui.ts).
  servePages(app, opts.distDir);

  const server = Bun.serve<SocketData>({
    port: opts.port,
    hostname: opts.hostname,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") {
        return srv.upgrade(req, { data: newSocketData() }) ? undefined : new Response("websocket expected", { status: 426 });
      }
      // The server is passed on: getConnInfo (the client address for the run start limit) reads it.
      return app.fetch(req, srv);
    },
    websocket: createArenaSockets(rooms),
  });

  return {
    url: `http://${opts.hostname}:${server.port}`,
    server,
    rooms,
    async stop() {
      rooms.close();
      await server.stop(true);
    },
  };
}
