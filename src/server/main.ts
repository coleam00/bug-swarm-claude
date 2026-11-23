import { join } from "node:path";
import { openDb } from "./db";
import { allowLoad, proxyHops } from "./limits";
import { listenConfig } from "./listen";
import { buildIdFrom, gracefulShutdown, onShutdownMessage, startServer, startTickFrom } from "./serve";

// Production mode: one process serves the API, the built game from dist/ (the start screen and the
// arena at /), the stream board at /board and the arena's WebSocket at /ws (serve.ts).
const { port, hostname } = listenConfig(process.env);
const dataDir = process.env.DATA_DIR ?? "data";
const db = openDb(join(dataDir, "app.db"));
const buildId = buildIdFrom(process.env, Date.now());
// BUG_SWARM_START_WAVE=<n> (a debug aid for evidence, off by default): new arenas open 10 s before wave n.
const arenaStartTick = startTickFrom(process.env);
// TRUST_PROXY_HOPS: how the /ws limits find the client behind Railway's proxy (architecture.md,
// "Client address behind a proxy"). BUG_SWARM_ALLOW_LOAD=1 turns the per-address limits off, for
// `bun run bots` and the playtest only; never set on Railway. A bad value of either stops the start.
const hops = proxyHops(process.env);
const loadAllowed = allowLoad(process.env);
const srv = startServer({ port, hostname, db, distDir: "dist", buildId, arenaStartTick, proxyHops: hops, allowLoad: loadAllowed, log: (line) => console.log(line) });
console.log(`App on http://${hostname}:${port} (build ${buildId})`);
if (hops > 0) console.log(`trusting ${hops} proxy hop(s) in X-Forwarded-For`);
if (loadAllowed) console.log("per-address /ws limits off (BUG_SWARM_ALLOW_LOAD=1): load testing only");
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
