import { join } from "node:path";
import { openDb } from "./db";
import { adminTokenFrom } from "./admin";
import { dataDirFrom, listenConfig } from "./listen";
import { buildIdFrom, gracefulShutdown, onShutdownMessage, startServer, startTickFrom } from "./serve";

// Production mode: one process serves the API, the built game from dist/ (the start screen and the
// arena at /), the stream board at /board and the arena's WebSocket at /ws (serve.ts).
const { port, hostname } = listenConfig(process.env);
const dir = dataDirFrom(process.env);
if ("error" in dir) {
  console.error(dir.error);
  process.exit(1);
}
const dataDir = dir.dataDir;
const db = openDb(join(dataDir, "app.db"));
const buildId = buildIdFrom(process.env, Date.now());
// BUG_SWARM_START_WAVE=<n> (a debug aid for evidence, off by default): new arenas open 10 s before wave n.
const arenaStartTick = startTickFrom(process.env);
// ADMIN_TOKEN (optional) turns on the owner's /api/admin/* routes (admin.ts). The line never holds the token.
const admin = adminTokenFrom(process.env);
const srv = startServer({ port, hostname, db, distDir: "dist", buildId, arenaStartTick, adminToken: admin.token });
console.log(`App on http://${hostname}:${port} (build ${buildId}, data in ${dataDir}, ${admin.line})`);
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
// The same from a parent process over IPC (the playtest's `--serve`, #95): on Windows a signal to a
// child is a hard kill. Inert unless the process was spawned with an IPC channel.
onShutdownMessage(process, (why) => void shutdown(why));
