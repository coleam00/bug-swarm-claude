import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { requestOrigin, withAbsoluteImages } from "./share";

/**
 * The built UI, in the order production needs it (main.ts calls this after the API routes):
 * 1. /board and /board/: the stream board, `board.html`. The static files add index.html only for
 *    directories, so without this route /board would fall through to the game.
 * 2. / and /index.html: the game's page, with its link-preview image URLs made absolute from the
 *    request (share.ts). Before the static files, which would otherwise answer / with the file as it is.
 * 3. The static files in `distDir`.
 * 4. Any other path: the game's page.
 */
export function servePages(app: Hono, distDir: string): void {
  const board = async () => {
    const file = Bun.file(join(distDir, "board.html"));
    if (!(await file.exists())) return new Response("board not built", { status: 404 });
    return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  app.get("/board", board);
  app.get("/board/", board);

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
