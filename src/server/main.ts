import { join } from "node:path";
import { getConnInfo } from "hono/bun";
import { openDb } from "./db";
import { serverOptions } from "./limits";
import { listenConfig } from "./listen";
import { buildIdFrom, startServer } from "./serve";

// Production mode: one process serves the API, the built UI from dist/, the stream board at
// /board, the arena page at /arena and the arena's WebSocket at /ws (serve.ts).
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
startServer({ port, hostname, db, distDir: "dist", appOptions: options, buildId: buildIdFrom(process.env, Date.now()) });
console.log(`App on http://${hostname}:${port}`);
