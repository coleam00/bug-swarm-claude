import { join } from "node:path";
import { getConnInfo } from "hono/bun";
import { createApp } from "./app";
import { openDb } from "./db";
import { serverOptions } from "./limits";
import { listenConfig } from "./listen";
import { servePages } from "./ui";

// Production mode: one process serves the API, the built UI from dist/, and the stream board at /board.
const { port, hostname } = listenConfig(process.env);
const dataDir = process.env.DATA_DIR ?? "data";
// Behind Railway: see architecture.md, "Client IP behind a proxy". Locally no header: the socket address.
const { options, startup } = serverOptions(process.env, (c) => {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
});
for (const line of startup) console.log(line);
const db = openDb(join(dataDir, "app.db"));
const app = createApp(db, options);
// The stream board, the game's page and the built files, in that order (ui.ts).
servePages(app, "dist");

Bun.serve({ port, hostname, fetch: app.fetch });
console.log(`App on http://${hostname}:${port}`);
