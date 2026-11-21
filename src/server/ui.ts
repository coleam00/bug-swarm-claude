import { join } from "node:path";
import type { Hono } from "hono";

/**
 * Serves the stream board at /board from the built `board.html`. The static middleware adds
 * index.html only for directories, so without this route /board would fall through to the game.
 * Register it before the static files and the SPA fallback.
 */
export function serveBoard(app: Hono, distDir: string): void {
  const handler = async () => {
    const file = Bun.file(join(distDir, "board.html"));
    if (!(await file.exists())) return new Response("board not built", { status: 404 });
    return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  app.get("/board", handler);
  app.get("/board/", handler);
}
