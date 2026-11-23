import { join } from "node:path";
import { openDb } from "./db";
import { gracefulShutdown, onShutdownMessage, startServer, startupFrom } from "./serve";

// Production mode: one process serves the API, the built game from dist/ (the start screen and the
// arena at /), the stream board at /board and the arena's WebSocket at /ws (serve.ts).
// What it reads from the environment (PORT, DATA_DIR, ADMIN_TOKEN, the build id, the debug start
// wave) is decided in startupFrom, which is tested; in production a missing DATA_DIR stops it here.
const startup = startupFrom(process.env, Date.now());
if ("error" in startup) {
  console.error(startup.error);
  process.exit(1);
}
const db = openDb(join(startup.dataDir, "app.db"));
const srv = startServer({ ...startup.options, db });
for (const line of startup.lines) console.log(line);

// A redeploy (Railway sends SIGTERM) or Ctrl+C: every life in progress is ended (and saved when it
// counts, lives.ts countsAsLife) and every client
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
