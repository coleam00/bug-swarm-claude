import { join } from "node:path";
import { getConnInfo, serveStatic } from "hono/bun";
import { clientIpResolver, createApp } from "./app";
import { openDb } from "./db";
import { proxyHops, startLimits } from "./limits";
import { listenConfig } from "./listen";

// Production mode: one process serves the API and the built UI from dist/.
const { port, hostname } = listenConfig(process.env);
const dataDir = process.env.DATA_DIR ?? "data";
const limits = startLimits(process.env);
if (limits.raised) {
  console.log(`run start limits set to ${limits.perIp} per IP and per player per 10 min (load testing only)`);
}
const hops = proxyHops(process.env);
if (hops > 0) console.log(`trusting ${hops} proxy hop(s) in X-Forwarded-For`);
const db = openDb(join(dataDir, "app.db"));
const app = createApp(db, {
  runStartsPerWindow: limits.perIp,
  runStartsPerPlayer: limits.perPlayer,
  // Behind Railway: see architecture.md, "Client IP behind a proxy". Locally no header: the socket address.
  clientIp: clientIpResolver(hops, (c) => {
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  }),
});
app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

Bun.serve({ port, hostname, fetch: app.fetch });
console.log(`App on http://${hostname}:${port}`);
