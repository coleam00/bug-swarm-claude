import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createApp } from "./app";
import { RUN_ENDED, computeStats, hideName, openDb, upsertPlayer } from "./db";
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
    for (let i = 0; i < 30; i++) await startRun(a); // the refused starts used none of the 30
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

  test("the 31st start from one IP in 10 minutes is 429; other IPs are fine; it resets", async () => {
    const a = app();
    for (let i = 0; i < 30; i++) await startRun(a);
    expect((await post(a, "/api/runs", { playerId: "player-0001", name: "Robo", team: TABS })).status).toBe(429);
    ip = "2.2.2.2";
    await startRun(a);
    ip = "1.1.1.1";
    clock += 10 * 60 * 1000;
    await startRun(a);
  });

  test("runStartsPerWindow sets the limit: with 2, the 3rd start is 429", async () => {
    const a = createApp(db, { now: () => clock, clientIp: () => ip, runStartsPerWindow: 2 });
    await startRun(a);
    await startRun(a);
    expect((await post(a, "/api/runs", { playerId: "player-0001", name: "Robo" })).status).toBe(429);
  });

  test("by default the client is X-Real-IP, else the rightmost X-Forwarded-For entry", async () => {
    const a = createApp(db, { now: () => clock });
    const start = (headers: Record<string, string>) =>
      a.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ playerId: "player-0001", name: "Robo", team: TABS }),
      });
    for (let i = 0; i < 30; i++) {
      expect((await start({ "x-real-ip": "9.9.9.9", "x-forwarded-for": `10.0.0.${i}` })).status).toBe(200);
    }
    expect((await start({ "x-real-ip": "9.9.9.9" })).status).toBe(429);
    expect((await start({ "x-forwarded-for": "9.9.9.9" })).status).toBe(429);
    expect((await start({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" })).status).toBe(200);
  });

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
    const res = await post(a, `/api/runs/${runId}/end`, endBody(score, Math.floor(score / 10), 1));
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
    const res = await post(a, `/api/runs/${runId}/end`, endBody(score, Math.floor(score / 10), 1));
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

describe("the stream board's read", () => {
  async function play(a: App, playerId: string, name: string, score: number, team: Team) {
    const runId = await startRun(a, playerId, name, team);
    clock += 10_000;
    const res = await post(a, `/api/runs/${runId}/end`, endBody(score, Math.floor(score / 10), 1));
    expect(res.status).toBe(200);
  }

  type Board = { top: { name: string; score: number }[]; teams: Record<Team, number> };
  async function board(a: App): Promise<Board> {
    const res = await a.request("/api/board");
    expect(res.status).toBe(200);
    return (await res.json()) as Board;
  }

  test("returns the top 10 and both team totals together", async () => {
    const a = app();
    await play(a, "player-0001", "Ann", 50, TABS);
    await play(a, "player-0002", "Bob", 30, SPACES);
    await play(a, "player-0001", "Ann", 20, TABS);
    expect(await board(a)).toEqual({
      top: [
        { name: "Ann", score: 50 },
        { name: "Bob", score: 30 },
      ],
      teams: { tabs: 70, spaces: 30 },
    });
  });

  test("a hidden name is in neither the top 10 nor the team totals", async () => {
    const a = app();
    await play(a, "player-0001", "Bad Name", 50, TABS);
    await play(a, "player-0002", "Good", 40, SPACES);
    hideName(db, "bad name", new Date(clock));
    expect(await board(a)).toEqual({ top: [{ name: "Good", score: 40 }], teams: { tabs: 0, spaces: 40 } });
  });

  test("is cached for 1 second, like the routes it combines", async () => {
    const a = app();
    await play(a, "player-0001", "First", 30, TABS);
    const before = await board(a);
    const runId = await startRun(a, "player-0002", "Second", SPACES);
    clock += 500;
    expect((await post(a, `/api/runs/${runId}/end`, endBody(0, 0, 0))).status).toBe(200);
    expect(await board(a)).toEqual(before);
    clock += 500;
    expect((await board(a)).top).toEqual([
      { name: "First", score: 30 },
      { name: "Second", score: 0 },
    ]);
  });

  test("agrees with /api/top and /api/teams at the same moment", async () => {
    const a = app();
    for (let i = 0; i < 12; i++) await play(a, `player-${1000 + i}`, `P${i}`, 10 * i, TEAMS[i % 2]!);
    const b = await board(a);
    const top = ((await (await a.request("/api/top")).json()) as { top: unknown }).top;
    const teams = ((await (await a.request("/api/teams")).json()) as { teams: unknown }).teams;
    expect(b).toEqual({ top, teams } as Board);
    expect(b.top.length).toBe(10);
  });
});

test("reopening the same database file keeps its data", async () => {
  const runId = await startRun(app());
  db.close();
  db = openDb(join(dir, "app.db"));
  clock += 5000;
  expect((await post(app(), `/api/runs/${runId}/end`, endBody(5, 0, 5))).status).toBe(200);
});
