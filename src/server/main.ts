import { join } from "node:path";
import { getConnInfo } from "hono/bun";
import { RUN_STARTS_PER_WINDOW, createApp, forwardedClientIp } from "./app";
import { openDb } from "./db";
import { startLimit } from "./limits";
import { listenConfig } from "./listen";
import { servePages } from "./ui";

// Production mode: one process serves the API, the built UI from dist/, and the stream board at /board.
const { port, hostname } = listenConfig(process.env);
const dataDir = process.env.DATA_DIR ?? "data";
const runStartsPerWindow = startLimit(process.env);
if (runStartsPerWindow !== RUN_STARTS_PER_WINDOW) {
  console.log(`run start limit set to ${runStartsPerWindow} per 10 min (load testing only)`);
}
const db = openDb(join(dataDir, "app.db"));
const app = createApp(db, {
  runStartsPerWindow,
  // Behind Railway: X-Real-IP (or the rightmost X-Forwarded-For hop). Locally neither: the socket address.
  clientIp: (c) => {
    const forwarded = forwardedClientIp(c);
    if (forwarded !== "unknown") return forwarded;
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  },
});
// The stream board, the game's page and the built files, in that order (ui.ts).
servePages(app, "dist");

Bun.serve({ port, hostname, fetch: app.fetch });
console.log(`App on http://${hostname}:${port}`);
