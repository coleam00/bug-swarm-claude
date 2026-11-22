import { join } from "node:path";
import { openDb } from "./db";
import { listenConfig } from "./listen";
import { buildIdFrom, gracefulShutdown, startServer, startTickFrom } from "./serve";

// Production mode: one process serves the API, the built game from dist/ (the start screen and the
// arena at /), the stream board at /board and the arena's WebSocket at /ws (serve.ts).
const { port, hostname } = listenConfig(process.env);
const dataDir = process.env.DATA_DIR ?? "data";
const db = openDb(join(dataDir, "app.db"));
const buildId = buildIdFrom(process.env, Date.now());
// BUG_SWARM_START_WAVE=<n> (a debug aid for evidence, off by default): new arenas open 10 s before wave n.
const arenaStartTick = startTickFrom(process.env);
const srv = startServer({ port, hostname, db, distDir: "dist", buildId, arenaStartTick });
console.log(`App on http://${hostname}:${port} (build ${buildId})`);
if (arenaStartTick > 0) console.log(`Arenas open at tick ${arenaStartTick} (BUG_SWARM_START_WAVE=${process.env.BUG_SWARM_START_WAVE}): debug only`);

// A redeploy (Railway sends SIGTERM) or Ctrl+C: every life in progress is saved and every client
// told to reconnect before the process exits (architecture.md, "Redeploys"). A hard kill loses them.
const shutdown = gracefulShutdown({
  stop: () => srv.stop(),
  closeDb: () => db.close(),
  exit: (code) => process.exit(code),
  log: (line) => console.log(line),
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown(signal));
