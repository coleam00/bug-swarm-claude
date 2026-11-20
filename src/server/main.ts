import { join } from "node:path";
import { getConnInfo, serveStatic } from "hono/bun";
import { createApp, forwardedClientIp } from "./app";
import { openDb } from "./db";
import { listenConfig } from "./listen";

// Production mode: one process serves the API and the built UI from dist/.
const { port, hostname } = listenConfig(process.env);
const dataDir = process.env.DATA_DIR ?? "data";
const db = openDb(join(dataDir, "app.db"));
const app = createApp(db, {
  // Behind Railway: the rightmost X-Forwarded-For hop. Locally there is none: the socket address.
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
app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

Bun.serve({ port, hostname, fetch: app.fetch });
console.log(`App on http://${hostname}:${port}`);
