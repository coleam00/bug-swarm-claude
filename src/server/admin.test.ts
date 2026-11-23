import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { ADMIN_PREFIX, ADMIN_REQUESTS_PER_WINDOW, ADMIN_WINDOW_MS, adminTokenFrom, clientKey } from "./admin";
import { createApp } from "./app";
import { TEAMS, hiddenKeys, openDb, recordRunEnded, recordRunStarted, upsertPlayer } from "./db";
import { startServer } from "./serve";
import { servePages } from "./ui";

const TOKEN = "s3cret-token-of-32-characters-xx";
let dir: string;
let dist: string;
let db: Database;
let t: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "admin-test-"));
  dist = join(dir, "dist");
  db = openDb(join(dir, "app.db"));
  // The real page fallback answers every unmatched GET with this; the admin 404 must beat it.
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "game");
  t = Date.parse("2026-11-28T15:00:00.000Z");
});

afterEach(() => {
  db.close(); // close before deleting: Windows refuses to delete an open file
  rmSync(dir, { recursive: true, force: true });
});

/** The app as production builds it: the API (with the admin routes), then the pages and their fallback. */
function app(token: string | null, key: (c: unknown) => string = () => "client"): Hono {
  const a = createApp(db, { adminToken: token, now: () => t, clientKey: key });
  servePages(a, dist);
  return a;
}

async function call(a: Hono, path: string, init: RequestInit & { token?: string | null } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const res = await a.request(path, { ...init, headers });
  return { status: res.status, body: await res.text() };
}
const post = (a: Hono, path: string, body: string | undefined, token: string | null = TOKEN) =>
  call(a, path, { method: "POST", body, token, headers: body === undefined ? {} : { "content-type": "application/json" } });

function seed() {
  for (const [i, id] of ["p1", "p2"].entries()) {
    const start = new Date("2026-11-28T15:00:00.000Z");
    upsertPlayer(db, id, `Player${i}`, TEAMS[0], start);
    recordRunStarted(db, `r-${id}`, id, start, TEAMS[0]);
    recordRunEnded(
      db,
      { runId: `r-${id}`, playerId: id, score: 10, squashes: 0, seconds: 60, touch: false, upgrades: [], team: TEAMS[0] },
      new Date("2026-11-28T15:05:00.000Z"),
    );
  }
}
const counts = () => ({
  players: (db.query("SELECT COUNT(*) AS n FROM players").get() as { n: number }).n,
  events: (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
});

describe("off without ADMIN_TOKEN", () => {
  test("every admin path is 404, not the game page", async () => {
    const a = app(null);
    for (const path of [ADMIN_PREFIX, `${ADMIN_PREFIX}/`, `${ADMIN_PREFIX}/stats`, `${ADMIN_PREFIX}/nope`]) {
      const r = await call(a, path, { token: TOKEN });
      expect(r).toEqual({ status: 404, body: "not found" });
    }
    seed();
    expect((await post(a, `${ADMIN_PREFIX}/hide`, JSON.stringify({ name: "Player0" }))).status).toBe(404);
    expect((await post(a, `${ADMIN_PREFIX}/reset`, JSON.stringify({ confirm: true }))).status).toBe(404);
    expect(counts()).toEqual({ players: 2, events: 4 });
    expect(hiddenKeys(db).size).toBe(0);
  });

  test("an empty, blank or short token keeps them off, and the line never holds the token", () => {
    expect(adminTokenFrom({}).token).toBeNull();
    expect(adminTokenFrom({ ADMIN_TOKEN: "" }).token).toBeNull();
    expect(adminTokenFrom({ ADMIN_TOKEN: "   " }).token).toBeNull();
    const short = adminTokenFrom({ ADMIN_TOKEN: "x".repeat(15) });
    expect(short).toEqual({ token: null, line: "admin routes off: ADMIN_TOKEN is shorter than 16 characters" });
    const on = adminTokenFrom({ ADMIN_TOKEN: ` ${TOKEN} ` });
    expect(on.token).toBe(TOKEN);
    expect(on.line).not.toContain(TOKEN);
  });
});

test("401 for a missing, wrong, same-length wrong or non-Bearer token", async () => {
  const a = app(TOKEN);
  const path = `${ADMIN_PREFIX}/stats`;
  expect(await call(a, path)).toEqual({ status: 401, body: "unauthorized" });
  expect((await call(a, path, { token: "wrong" })).status).toBe(401);
  expect((await call(a, path, { token: TOKEN.replace(/.$/, "y") })).status).toBe(401);
  expect((await call(a, path, { headers: { authorization: `Basic ${TOKEN}` } })).status).toBe(401);
  // A wrong token never reaches a route.
  seed();
  expect((await post(a, `${ADMIN_PREFIX}/reset`, JSON.stringify({ confirm: true }), "wrong-but-long-enough-token")).status).toBe(401);
  expect(counts()).toEqual({ players: 2, events: 4 });
});

describe("with the right token", () => {
  test("stats: the four lines, filtered by since and until; a bad time is 400", async () => {
    seed();
    const a = app(TOKEN);
    const all = await call(a, `${ADMIN_PREFIX}/stats`, { token: TOKEN });
    expect(all.status).toBe(200);
    expect(JSON.parse(all.body)).toEqual({
      lines: ["players: 2", "finished_runs: 2", "median_runs_per_player: 1.0", "touch_share: 0%"],
    });
    const q = new URLSearchParams({ since: "2026-11-28T09:10:00-06:00" }).toString();
    const later = await call(a, `${ADMIN_PREFIX}/stats?${q}`, { token: TOKEN });
    expect(JSON.parse(later.body).lines[1]).toBe("finished_runs: 0");
    const bad = await call(a, `${ADMIN_PREFIX}/stats?until=yesterday`, { token: TOKEN });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ error: "until: not an ISO time: yesterday" });
  });

  test("hide: hides the name and says how many players have it", async () => {
    seed();
    const a = app(TOKEN);
    const r = await post(a, `${ADMIN_PREFIX}/hide`, JSON.stringify({ name: "  PLAYER0 " }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ lines: ["hidden: player0 (1 player)"] });
    expect(hiddenKeys(db).has("player0")).toBe(true);
    for (const body of [undefined, "{}", JSON.stringify({ name: "  " }), JSON.stringify({ name: 3 }), "not json"]) {
      expect((await post(a, `${ADMIN_PREFIX}/hide`, body)).status).toBe(400);
    }
  });

  test("reset: deletes every run and player", async () => {
    seed();
    const r = await post(app(TOKEN), `${ADMIN_PREFIX}/reset`, JSON.stringify({ confirm: true }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ lines: ["reset: deleted 2 runs and 2 players (hidden names kept)"] });
    expect(counts()).toEqual({ players: 0, events: 0 });
  });

  test("reset requires the confirm: anything else is 400 and touches nothing", async () => {
    seed();
    const a = app(TOKEN);
    for (const body of [undefined, "{}", JSON.stringify({ confirm: "yes" }), JSON.stringify([true]), "{confirm: true"]) {
      const r = await post(a, `${ADMIN_PREFIX}/reset`, body);
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error: 'reset needs {"confirm": true}' });
    }
    expect(counts()).toEqual({ players: 2, events: 4 });
  });

  test("other paths and methods under the prefix are 404", async () => {
    const a = app(TOKEN);
    expect((await call(a, `${ADMIN_PREFIX}/reset`, { token: TOKEN })).status).toBe(404);
    expect((await post(a, `${ADMIN_PREFIX}/stats`, "{}")).status).toBe(404);
    expect((await call(a, `${ADMIN_PREFIX}/users`, { token: TOKEN })).status).toBe(404);
    expect((await call(a, ADMIN_PREFIX, { token: TOKEN })).status).toBe(404);
  });
});

test("rate limit: per client per minute, wrong tokens count", async () => {
  let who = "a";
  const a = app(TOKEN, () => who);
  const stats = `${ADMIN_PREFIX}/stats`;
  for (let i = 0; i < ADMIN_REQUESTS_PER_WINDOW - 1; i++) expect((await call(a, stats, { token: TOKEN })).status).toBe(200);
  expect((await call(a, stats, { token: "wrong" })).status).toBe(401);
  expect(await call(a, stats, { token: TOKEN })).toEqual({ status: 429, body: "too many requests" });
  who = "b";
  expect((await call(a, stats, { token: TOKEN })).status).toBe(200);
  who = "a";
  t += ADMIN_WINDOW_MS;
  expect((await call(a, stats, { token: TOKEN })).status).toBe(200);
});

test("clientKey: X-Real-IP, else the rightmost X-Forwarded-For entry, else the peer", () => {
  const h = (m: Record<string, string>) => (name: string) => m[name];
  expect(clientKey(h({ "x-real-ip": " 9.9.9.9 ", "x-forwarded-for": "1.1.1.1" }), () => "peer")).toBe("9.9.9.9");
  expect(clientKey(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), () => "peer")).toBe("2.2.2.2");
  expect(clientKey(h({}), () => "peer")).toBe("peer");
  expect(clientKey(h({}), () => undefined)).toBe("unknown");
  expect(
    clientKey(
      () => {
        throw new Error("boom");
      },
      () => "peer",
    ),
  ).toBe("unknown");
});

test("the real server: startServer's adminToken turns the routes on", async () => {
  const srv = startServer({ port: 0, hostname: "127.0.0.1", db, distDir: dist, buildId: "admin", adminToken: TOKEN, arenaFill: 0 });
  try {
    const url = `${srv.url}${ADMIN_PREFIX}/stats`;
    const ok = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).lines).toHaveLength(4);
    const no = await fetch(url);
    expect(no.status).toBe(401);
    await no.text();
  } finally {
    await srv.stop();
  }
});

test("never linked from the game: no page or web source names the admin routes", () => {
  const root = join(import.meta.dir, "..", "..");
  const files = [join(root, "index.html"), join(root, "board.html")];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(join(root, "src", "web"));
  expect(files.length).toBeGreaterThan(10);
  for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/\/(api\/)?admin\b/);
});
