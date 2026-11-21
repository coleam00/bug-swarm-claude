import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { LOGGED_STARTS, RATE_WINDOW_MS, RUN_STARTS_PER_PLAYER, RUN_STARTS_PER_WINDOW, clientIpResolver, createApp } from "./app";
import { RUN_ENDED, computeStats, hideName, openDb, upsertPlayer } from "./db";
import { ROBOT_RIM } from "../web/game/look";
import { CI_DRONE, MAX_UPGRADES, REVIEW_LASER, TEAMS, TEST_SHIELD, UPGRADE_IDS, type Team } from "./rules";

const [TABS, SPACES] = TEAMS;

let dir: string;
let db: Database;
let clock: number;
let ip: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-test-"));
  db = openDb(join(dir, "app.db"));
  clock = Date.parse("2026-11-28T15:00:00.000Z");
  ip = "1.1.1.1";
});

afterEach(() => {
  db.close(); // close before deleting: Windows refuses to delete an open file
  rmSync(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;
const app = (): App => createApp(db, { now: () => clock, clientIp: () => ip });

function post(a: App, path: string, body: unknown) {
  return a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Starts a run, with a team unless `team` is null (a player from before teams). */
async function startRun(a: App, playerId = "player-0001", name = "Robo", team: Team | null = TABS): Promise<string> {
  const res = await post(a, "/api/runs", team ? { playerId, name, team } : { playerId, name });
  expect(res.status).toBe(200);
  return ((await res.json()) as { runId: string }).runId;
}

function endBody(score: number, squashes = 0, seconds = 0, touch = false) {
  return { score, squashes, seconds, touch, upgrades: [] };
}

test("health answers ok", async () => {
  const res = await app().request("/health");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

describe("run start", () => {
  test("returns a run id", async () => {
    expect(await startRun(app())).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a malformed body is 400", async () => {
    const a = app();
    expect((await a.request("/api/runs", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await post(a, "/api/runs", { name: "Robo" })).status).toBe(400);
    expect((await post(a, "/api/runs", { playerId: "short", name: "Robo" })).status).toBe(400);
    expect((await post(a, "/api/runs", [1, 2])).status).toBe(400);
  });

  test("a new player must send a team; a team that isn't one is 400; neither writes or counts toward the rate limit", async () => {
    const a = app();
    const res = await post(a, "/api/runs", { playerId: "player-0001", name: "Robo" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "team" });
    for (const team of ["Tabs", "", null, 1]) {
      const bad = await post(a, "/api/runs", { playerId: "player-0001", name: "Robo", team });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "body" });
    }
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM players").get()).toEqual({ n: 0 });
    for (let i = 0; i < RUN_STARTS_PER_PLAYER; i++) await startRun(a); // the refused starts used none of the budget
  });

  test("a team is set once: a different team sent later is ignored, not switched", async () => {
    const a = app();
    await startRun(a, "player-0001", "Robo", TABS);
    await startRun(a, "player-0001", "Robo", SPACES);
    await startRun(a, "player-0001", "Robo", null);
    expect(db.query("SELECT team FROM players WHERE id = ?").get("player-0001")).toEqual({ team: TABS });
    const runs = db.query("SELECT team FROM events WHERE player_id = ? ORDER BY id").all("player-0001");
    expect(runs).toEqual([{ team: TABS }, { team: TABS }, { team: TABS }]);
  });

  test("a blocked name is 400 with the reason", async () => {
    const res = await post(app(), "/api/runs", { playerId: "player-0001", name: "sh1t" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name", reason: "blocked" });
  });

  test("300 starts from one IP in 10 minutes are fine; the 301st is 429 with Retry-After; other IPs are fine; it resets", async () => {
    const a = app();
    // Many players behind one public IP (carrier NAT): a player id each, so the per-player cap never trips.
    const natPlayer = (i: number) => `nat-${String(i).padStart(6, "0")}`;
    for (let i = 0; i < RUN_STARTS_PER_WINDOW; i++) await startRun(a, natPlayer(i));
    clock += 60_000;
    const refused = await post(a, "/api/runs", { playerId: natPlayer(9999), name: "Robo", team: TABS });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate" });
    expect(refused.headers.get("retry-after")).toBe(String(9 * 60)); // the oldest start leaves the window in 9 minutes
    ip = "2.2.2.2";
    await startRun(a, natPlayer(9999));
    ip = "1.1.1.1";
    clock += 9 * 60 * 1000;
    await startRun(a, natPlayer(9999));
  }, 30_000);

  test("one player id gets 40 starts in 10 minutes, from any IPs; the 41st is 429 with Retry-After; other players are fine", async () => {
    const a = app();
    for (let i = 0; i < RUN_STARTS_PER_PLAYER; i++) {
      ip = `198.51.100.${i}`;
      await startRun(a);
    }
    ip = "203.0.113.9";
    const refused = await post(a, "/api/runs", { playerId: "player-0001", name: "Robo", team: TABS });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate" });
    expect(refused.headers.get("retry-after")).toBe(String(RATE_WINDOW_MS / 1000));
    await startRun(a, "player-0002");
    clock += RATE_WINDOW_MS;
    await startRun(a);
  });

  test("a start one cap refuses spends neither budget", async () => {
    const a = createApp(db, { now: () => clock, clientIp: () => ip, runStartsPerWindow: RUN_STARTS_PER_PLAYER + 1 });
    for (let i = 0; i < RUN_STARTS_PER_PLAYER; i++) await startRun(a);
    expect((await post(a, "/api/runs", { playerId: "player-0001", name: "Robo" })).status).toBe(429); // player cap
    await startRun(a, "player-0002"); // the IP's 41st: the refused start didn't take it
  });

  test("runStartsPerWindow sets the IP limit: with 2, the 3rd start is 429", async () => {
    const a = createApp(db, { now: () => clock, clientIp: () => ip, runStartsPerWindow: 2 });
    await startRun(a, "player-0001");
    await startRun(a, "player-0002");
    expect((await post(a, "/api/runs", { playerId: "player-0003", name: "Robo", team: TABS })).status).toBe(429);
  });

  test("runStartsPerPlayer sets the player limit: with 2, the 3rd start is 429", async () => {
    const a = createApp(db, { now: () => clock, clientIp: () => ip, runStartsPerPlayer: 2 });
    await startRun(a);
    await startRun(a);
    expect((await post(a, "/api/runs", { playerId: "player-0001", name: "Robo" })).status).toBe(429);
  });

  test("logs the client address of the first starts after boot and of every refused start, so the proxy setting can be checked", async () => {
    const lines: string[] = [];
    const a = createApp(db, { now: () => clock, clientIp: () => ip, runStartsPerWindow: LOGGED_STARTS + 1, log: (l) => lines.push(l) });
    for (let i = 0; i <= LOGGED_STARTS; i++) await startRun(a, `player-${String(i).padStart(4, "0")}`);
    expect(lines).toHaveLength(LOGGED_STARTS); // only the first ones: no line per start all stream
    expect(lines[0]).toBe(`run start 1/${LOGGED_STARTS} after boot: client 1.1.1.1`);
    lines.length = 0;
    await post(a, "/api/runs", { playerId: "player-9999", name: "Robo", team: TABS });
    expect(lines).toEqual(["run start refused (per-IP cap): client 1.1.1.1"]);
    ip = "2.2.2.2";
    const b = createApp(db, { now: () => clock, clientIp: () => ip, runStartsPerPlayer: 1, log: (l) => lines.push(l) });
    await startRun(b, "player-8888");
    lines.length = 0;
    await post(b, "/api/runs", { playerId: "player-8888", name: "Robo", team: TABS });
    expect(lines).toEqual(["run start refused (per-player cap): client 2.2.2.2"]);
  });

  /** A start through a proxy that sends `headers`, as player `n`. */
  const startVia = (a: App, n: number, headers: Record<string, string>) =>
    a.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ playerId: `player-${String(n).padStart(4, "0")}`, name: "Robo", team: TABS }),
    });

  test("by default the client is X-Real-IP, else the rightmost X-Forwarded-For entry", async () => {
    const a = createApp(db, { now: () => clock, runStartsPerWindow: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await startVia(a, i, { "x-real-ip": "9.9.9.9", "x-forwarded-for": `10.0.0.${i}` })).status).toBe(200);
    }
    expect((await startVia(a, 3, { "x-real-ip": "9.9.9.9" })).status).toBe(429);
    expect((await startVia(a, 4, { "x-forwarded-for": "9.9.9.9" })).status).toBe(429);
    expect((await startVia(a, 5, { "x-forwarded-for": "9.9.9.9, 8.8.8.8" })).status).toBe(200);
  });

  test("300 viewers through one proxy each get their own budget, by default and with TRUST_PROXY_HOPS=1", async () => {
    // Hono's test requests have no socket: every start comes from the same peer, as behind Railway.
    const byDefault = createApp(db, { now: () => clock, runStartsPerWindow: 1 });
    const hops1 = createApp(db, { now: () => clock, runStartsPerWindow: 1, clientIp: clientIpResolver(1, () => "100.64.0.1") });
    for (let i = 0; i < RUN_STARTS_PER_WINDOW; i++) {
      const client = `198.51.${Math.floor(i / 256)}.${i % 256}`;
      expect((await startVia(byDefault, i, { "x-forwarded-for": client })).status).toBe(200);
      // A client prepending its own entries changes nothing, and hops 1 ignores X-Real-IP: the proxy's entry is the rightmost.
      expect((await startVia(hops1, i, { "x-forwarded-for": `6.6.6.6, ${client}`, "x-real-ip": "9.9.9.9" })).status).toBe(200);
    }
    expect((await startVia(hops1, 0, { "x-forwarded-for": "7.7.7.7, 198.51.0.0" })).status).toBe(429);
  }, 30_000);

  test("an oversize body is 413, with or without a content-length", async () => {
    const body = JSON.stringify({ playerId: "player-0001", name: "x".repeat(3000) });
    const sized = await app().request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    expect(sized.status).toBe(413);
    const streamed = await app().request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Blob([body]).stream(),
    });
    expect(streamed.status).toBe(413);
  });
});

describe("run end", () => {
  test("is accepted once, then 409", async () => {
    const a = app();
    const runId = await startRun(a);
    clock += 30_000;
    expect((await post(a, `/api/runs/${runId}/end`, endBody(130, 10, 30))).status).toBe(200);
    expect((await post(a, `/api/runs/${runId}/end`, endBody(130, 10, 30))).status).toBe(409);
  });

  test("records whether the run was played by touch", async () => {
    const a = app();
    const touchRun = await startRun(a);
    const mouseRun = await startRun(a);
    clock += 30_000;
    expect((await post(a, `/api/runs/${touchRun}/end`, endBody(30, 0, 30, true))).status).toBe(200);
    expect((await post(a, `/api/runs/${mouseRun}/end`, endBody(30, 0, 30, false))).status).toBe(200);
    expect(computeStats(db).touchShare).toBe(50);
  });

  test("an unknown run is 404", async () => {
    expect((await post(app(), "/api/runs/nope/end", endBody(10))).status).toBe(404);
  });

  test("a malformed body is 400", async () => {
    const a = app();
    const runId = await startRun(a);
    expect((await post(a, `/api/runs/${runId}/end`, { score: 1 })).status).toBe(400);
    const tooMany = { ...endBody(1), upgrades: Array.from({ length: MAX_UPGRADES + 1 }, () => UPGRADE_IDS[0]) };
    expect((await post(a, `/api/runs/${runId}/end`, tooMany)).status).toBe(400);
    for (const upgrades of [["laser-of-doom"], [UPGRADE_IDS[0], 7], "review-laser"]) {
      expect((await post(a, `/api/runs/${runId}/end`, { ...endBody(1), upgrades })).status).toBe(400);
    }
  });

  test("stores the upgrades the run took, in pick order", async () => {
    const a = app();
    const runId = await startRun(a);
    clock += 45_000;
    const upgrades = [...UPGRADE_IDS, UPGRADE_IDS[UPGRADE_IDS.length - 1]]; // every id, and a repeat
    expect((await post(a, `/api/runs/${runId}/end`, { ...endBody(45, 0, 45), upgrades })).status).toBe(200);
    const row = db.query("SELECT upgrades FROM events WHERE type = ? AND run_id = ?").get(RUN_ENDED, runId) as { upgrades: string };
    expect(JSON.parse(row.upgrades)).toEqual(upgrades);
  });

  test("a score impossible for the server's elapsed time is 422", async () => {
    const a = app();
    const runId = await startRun(a);
    clock += 10_000; // 10 s by the server's clock: at most 12 seconds may be claimed (the bounds are in rules.test.ts)
    expect((await post(a, `/api/runs/${runId}/end`, endBody(0, 0, 13))).status).toBe(422);
    expect((await post(a, `/api/runs/${runId}/end`, endBody(52, 4, 10))).status).toBe(200);
  });
});

describe("top 10 and best", () => {
  async function play(a: App, playerId: string, name: string, score: number) {
    const runId = await startRun(a, playerId, name);
    clock += 10_000;
    const res = await post(a, `/api/runs/${runId}/end`, endBody(score, Math.floor(score / 10), 10)); // 10 s on the clock: up to 50 squashes
    expect(res.status).toBe(200);
  }

  async function top(a: App) {
    return ((await (await a.request("/api/top")).json()) as { top: { name: string; score: number }[] }).top;
  }

  test("best score per player, one row each, highest first, at most 10", async () => {
    const a = app();
    for (let i = 0; i < 12; i++) await play(a, `player-${1000 + i}`, `P${i}`, 10 * i);
    await play(a, "player-1000", "P0", 500);
    await play(a, "player-1000", "P0", 105); // a second row for P0 would push P3 off
    expect(await top(a)).toEqual([
      { name: "P0", score: 500 },
      { name: "P11", score: 110 },
      { name: "P10", score: 100 },
      { name: "P9", score: 90 },
      { name: "P8", score: 80 },
      { name: "P7", score: 70 },
      { name: "P6", score: 60 },
      { name: "P5", score: 50 },
      { name: "P4", score: 40 },
      { name: "P3", score: 30 },
    ]);
  });

  test("a hidden name is left out, whatever its case", async () => {
    const a = app();
    await play(a, "player-0001", "Bad Name", 50);
    await play(a, "player-0002", "Good", 40);
    hideName(db, "  bad  NAME ", new Date(clock));
    expect(await top(a)).toEqual([{ name: "Good", score: 40 }]);
  });

  test("is cached for 1 second", async () => {
    const a = app();
    await play(a, "player-0001", "First", 30);
    expect(await top(a)).toEqual([{ name: "First", score: 30 }]);
    const runId = await startRun(a, "player-0002", "Second");
    clock += 500;
    expect((await post(a, `/api/runs/${runId}/end`, endBody(0, 0, 0))).status).toBe(200);
    expect(await top(a)).toEqual([{ name: "First", score: 30 }]);
    clock += 500;
    expect(await top(a)).toEqual([
      { name: "First", score: 30 },
      { name: "Second", score: 0 },
    ]);
  });

  test("a player's best", async () => {
    const a = app();
    const best = async (id: string) => (await (await a.request(`/api/players/${id}/best`)).json()) as { best: number | null };
    expect(await best("player-0001")).toEqual({ best: null });
    await play(a, "player-0001", "Robo", 40);
    await play(a, "player-0001", "Robo", 20);
    expect(await best("player-0001")).toEqual({ best: 40 });
  });
});

describe("team totals", () => {
  async function play(a: App, playerId: string, name: string, score: number, team: Team | null = TABS) {
    const runId = await startRun(a, playerId, name, team);
    clock += 10_000;
    const res = await post(a, `/api/runs/${runId}/end`, endBody(score, Math.floor(score / 10), 10)); // 10 s on the clock: up to 50 squashes
    expect(res.status).toBe(200);
  }

  async function teams(a: App) {
    const res = await a.request("/api/teams");
    expect(res.status).toBe(200);
    return ((await res.json()) as { teams: Record<Team, number> }).teams;
  }

  test("sum every finished run's score into its team; an abandoned run adds nothing", async () => {
    const a = app();
    await play(a, "player-0001", "Ann", 50, TABS);
    await play(a, "player-0001", "Ann", 20, TABS); // every run counts, not just the best
    await play(a, "player-0002", "Bob", 30, SPACES);
    await startRun(a, "player-0003", "Cat", SPACES); // abandoned
    expect(await teams(a)).toEqual({ tabs: 70, spaces: 30 });
  });

  test("a run from before the player had a team counts for nobody, even after they pick one", async () => {
    const a = app();
    upsertPlayer(db, "player-0001", "Old Timer", null, new Date(clock));
    await play(a, "player-0001", "Old Timer", 40, null);
    expect(await teams(a)).toEqual({ tabs: 0, spaces: 0 });
    await play(a, "player-0001", "Old Timer", 25, SPACES);
    expect(await teams(a)).toEqual({ tabs: 0, spaces: 25 });
    expect(db.query("SELECT team FROM players WHERE id = ?").get("player-0001")).toEqual({ team: SPACES });
  });

  test("a hidden name's runs leave the totals once the 1 s cache turns over", async () => {
    const a = app();
    await play(a, "player-0001", "Bad Name", 50, TABS);
    await play(a, "player-0002", "Good", 40, TABS);
    expect(await teams(a)).toEqual({ tabs: 90, spaces: 0 }); // primes the cache
    hideName(db, "  bad  NAME ", new Date(clock));
    clock += 999;
    expect(await teams(a)).toEqual({ tabs: 90, spaces: 0 });
    clock += 1; // 1 s cache + the game-over screen's 4 s poll: gone from every screen within 5 s
    expect(await teams(a)).toEqual({ tabs: 40, spaces: 0 });
  });
});

test("reopening the same database file keeps its data", async () => {
  const runId = await startRun(app());
  db.close();
  db = openDb(join(dir, "app.db"));
  clock += 5000;
  expect((await post(app(), `/api/runs/${runId}/end`, endBody(5, 0, 5))).status).toBe(200);
});

describe("icons and link preview", () => {
  /** Width and height from a PNG's IHDR. */
  const pngSize = (b: Uint8Array) => {
    const v = new DataView(b.buffer, b.byteOffset);
    return [v.getUint32(16), v.getUint32(20)];
  };
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test.each([
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon.ico", "image/x-icon"],
    ["/apple-touch-icon.png", "image/png"],
    ["/og.png", "image/png"],
  ])("%s answers 200 %s, cached for a day", async (path, type) => {
    const res = await app().request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  test("the favicon is an SVG of the robot, in its rim colour", async () => {
    const svg = await (await app().request("/favicon.svg")).text();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(ROBOT_RIM);
  });

  test("favicon.ico wraps a 48 px PNG", async () => {
    const ico = new Uint8Array(await (await app().request("/favicon.ico")).arrayBuffer());
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect([...ico.subarray(22, 30)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(ico.subarray(22))).toEqual([48, 48]);
  });

  test("the apple-touch icon is a 180 px PNG and the preview a 1200x630 PNG", async () => {
    const icon = new Uint8Array(await (await app().request("/apple-touch-icon.png")).arrayBuffer());
    expect([...icon.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(icon)).toEqual([180, 180]);
    const og = new Uint8Array(await (await app().request("/og.png")).arrayBuffer());
    expect([...og.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(og)).toEqual([1200, 630]);
  });
});
