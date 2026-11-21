import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { requestOrigin, withAbsoluteImages } from "./share";

/**
 * The built UI, in the order production needs it (serve.ts calls this after the API routes):
 * 1. /board and /board/: the stream board, `board.html`. The static files add index.html only for
 *    directories, so without this route it would fall through to the game. /arena and /arena/
 *    (the arena's own page before #64) redirect to /, where the game now is.
 * 2. / and /index.html: the game's page, with its link-preview image URLs made absolute from the
 *    request (share.ts). Before the static files, which would otherwise answer / with the file as it is.
 * 3. The static files in `distDir`.
 * 4. Any other path: the game's page.
 */
export function servePages(app: Hono, distDir: string): void {
  const htmlFile = (name: string) => async () => {
    const file = Bun.file(join(distDir, `${name}.html`));
    if (!(await file.exists())) return new Response(`${name} not built`, { status: 404 });
    return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  const board = htmlFile("board");
  app.get("/board", board);
  app.get("/board/", board);
  // 307: a temporary redirect, so nothing caches it as the arena's address for good.
  for (const path of ["/arena", "/arena/"]) app.get(path, (c) => c.redirect("/", 307));

  let page: string | null = null;
  try {
    page = readFileSync(join(distDir, "index.html"), "utf8");
  } catch {
    // No build yet (bun run dev): fall back to serving the file, as before.
  }
  const servePage = page
    ? (c: Context) => c.html(withAbsoluteImages(page, requestOrigin((name) => c.req.header(name))))
    : serveStatic({ path: join(distDir, "index.html") });
  app.get("/", servePage);
  app.get("/index.html", servePage);
  app.use("/*", serveStatic({ root: distDir }));
  app.get("*", servePage);
}
