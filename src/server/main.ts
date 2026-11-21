import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { getConnInfo, serveStatic } from "hono/bun";
import { RUN_STARTS_PER_WINDOW, createApp, forwardedClientIp } from "./app";
import { openDb } from "./db";
import { startLimit } from "./limits";
import { listenConfig } from "./listen";
import { requestOrigin, withAbsoluteImages } from "./share";
import { serveBoard } from "./ui";

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
serveBoard(app, "dist");
// The page, with its link-preview image URLs made absolute from the request (share.ts). Served
// for / before the static files, which would otherwise answer / with the file as it is.
let page: string | null = null;
try {
  page = readFileSync("./dist/index.html", "utf8");
} catch {
  // No build yet (bun run dev): fall back to serving the file, as before.
}
const servePage = page
  ? (c: Context) => c.html(withAbsoluteImages(page, requestOrigin((name) => c.req.header(name))))
  : serveStatic({ path: "./dist/index.html" });
app.get("/", servePage);
app.get("/index.html", servePage);
app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", servePage);

Bun.serve({ port, hostname, fetch: app.fetch });
console.log(`App on http://${hostname}:${port}`);
