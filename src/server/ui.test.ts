import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import viteConfig from "../../vite.config";
import { servePages } from "./ui";

let dist: string;
let noBoard: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "ui-test-"));
  noBoard = mkdtempSync(join(tmpdir(), "ui-test-noboard-"));
  for (const dir of [dist, noBoard]) {
    writeFileSync(join(dir, "index.html"), "game");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "js");
  }
  writeFileSync(join(dist, "board.html"), "board");
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  rmSync(noBoard, { recursive: true, force: true });
});

/** GETs a path and reads the body fully, so no file handle stays open (Windows can't delete an open file). */
async function get(app: Hono, path: string) {
  const res = await app.request(path);
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
}

test("production pages: /board is the board, / and unknown paths are the game, built files are served", async () => {
  const app = new Hono();
  servePages(app, dist);
  for (const path of ["/board", "/board/"]) {
    expect(await get(app, path)).toEqual({ status: 200, type: "text/html; charset=utf-8", body: "board" });
  }
  for (const path of ["/", "/index.html", "/nope"]) expect((await get(app, path)).body).toBe("game");
  expect((await get(app, "/assets/app.js")).body).toBe("js");
});

test("a build with no board.html answers 404 at /board, not the game", async () => {
  const app = new Hono();
  servePages(app, noBoard);
  expect((await get(app, "/board")).status).toBe(404);
});

test("the build emits board.html: it is a Vite entry, at the repo root where the dev server finds /board", () => {
  const input = viteConfig.build?.rollupOptions?.input as Record<string, string>;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  expect(input.board).toBe(join(root, "board.html"));
  expect(existsSync(input.board!)).toBe(true);
});
