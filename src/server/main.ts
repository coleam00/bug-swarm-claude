import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { getConnInfo, serveStatic } from "hono/bun";
import { createApp } from "./app";
import { openDb } from "./db";
import { serverOptions } from "./limits";
import { listenConfig } from "./listen";
import { requestOrigin, withAbsoluteImages } from "./share";

// Production mode: one process serves the API and the built UI from dist/.
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
