import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serveBoard } from "./ui";

let dist: string;
let empty: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "ui-test-"));
  empty = mkdtempSync(join(tmpdir(), "ui-test-empty-"));
  writeFileSync(join(dist, "index.html"), "game");
  writeFileSync(join(dist, "board.html"), "board");
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

/** The board route, then a catch-all standing in for main.ts's static files and SPA fallback. */
function appFor(dir: string): Hono {
  const app = new Hono();
  serveBoard(app, dir);
  app.get("*", (c) => c.text("game"));
  return app;
}

test("/board and /board/ serve board.html as html, ahead of the game's fallback", async () => {
  const app = appFor(dist);
  for (const path of ["/board", "/board/"]) {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("board"); // read the body fully, so no file handle stays open
  }
  expect(await (await app.request("/")).text()).toBe("game");
});

test("a build with no board.html answers 404 at /board", async () => {
  const res = await appFor(empty).request("/board");
  expect(res.status).toBe(404);
  await res.text();
});
