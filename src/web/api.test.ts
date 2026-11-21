import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { endRun, fetchBest, fetchTeams, fetchTop, finishRun, startRun } from "./api";
import type { RunResult } from "./game/loop";
import { REVIEW_LASER, TEAMS } from "../server/rules";

const realFetch = globalThis.fetch;
let respond: () => Response | Promise<Response>;
let sent: unknown;
let url: string | undefined;
let calls: number;
beforeEach(() => {
  sent = undefined;
  url = undefined;
  calls = 0;
  globalThis.fetch = (async (to: string, init?: RequestInit) => {
    calls++;
    url = to;
    sent = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return respond();
  }) as unknown as typeof fetch;
  spyOn(console, "error").mockImplementation(() => {}); // failures are logged; keep the output clean
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore(); // give console.error back to the test files that run after this one
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const down = () => Promise.reject(new TypeError("Failed to fetch"));
const RESULT: RunResult = { score: 10, squashes: 1, seconds: 3, touch: false, upgrades: [REVIEW_LASER, REVIEW_LASER] };

test("startRun: a run id, a name refusal, a refusal for too many runs, or a failure", async () => {
  respond = () => json(200, { runId: "run-1" });
  expect(await startRun("player-0001", "Robo", TEAMS[0])).toEqual({ kind: "ok", runId: "run-1" });
  respond = () => json(400, { error: "name", reason: "blocked" });
  expect(await startRun("player-0001", "sh1t", TEAMS[0])).toEqual({ kind: "name-refused" });
  respond = () => json(400, { error: "body" });
  expect(await startRun("player-0001", "Robo", TEAMS[0])).toEqual({ kind: "failed" });
  respond = () => json(400, { error: "team" });
  expect(await startRun("player-0001", "Robo", null)).toEqual({ kind: "failed" });
  respond = () => json(429, { error: "rate" });
  expect(await startRun("player-0001", "Robo", TEAMS[0])).toEqual({ kind: "rate" });
  respond = down;
  expect(await startRun("player-0001", "Robo", TEAMS[0])).toEqual({ kind: "failed" });
});

test("startRun sends the team when the player has one, and none when they don't", async () => {
  respond = () => json(200, { runId: "run-1" });
  await startRun("player-0001", "Robo", TEAMS[1]);
  expect(sent).toEqual({ playerId: "player-0001", name: "Robo", team: TEAMS[1] });
  await startRun("player-0001", "Robo", null);
  expect(sent).toEqual({ playerId: "player-0001", name: "Robo" });
});

test("fetchTeams: both totals, else a failure instead of throwing", async () => {
  respond = () => json(200, { teams: { tabs: 120, spaces: 80 } });
  expect(await fetchTeams()).toEqual({ tabs: 120, spaces: 80 });
  expect(url).toBe("/api/teams");
  respond = () => json(200, { teams: { tabs: 120 } });
  expect(await fetchTeams()).toBe("failed");
  respond = () => json(500, {});
  expect(await fetchTeams()).toBe("failed");
  respond = down;
  expect(await fetchTeams()).toBe("failed");
});

test("endRun: saved only when the server accepted the score", async () => {
  respond = () => json(200, { ok: true });
  expect(await endRun("run-1", RESULT)).toBe("saved");
  expect(sent).toEqual(RESULT); // the upgrades taken go with the finish
  respond = () => json(500, {});
  expect(await endRun("run-1", RESULT)).toBe("failed");
  respond = () => json(422, { error: "implausible" });
  expect(await endRun("run-1", RESULT)).toBe("failed");
  respond = down;
  expect(await endRun("run-1", RESULT)).toBe("failed");
});

test("finishRun saves under the run's id, fails without one, and sends nothing for a stress run", async () => {
  respond = () => json(200, { ok: true });
  expect(await finishRun(Promise.resolve({ kind: "ok", runId: "run-1" }), RESULT)).toBe("saved");
  expect(url).toBe("/api/runs/run-1/end");
  expect(sent).toEqual(RESULT);
  expect(await finishRun(Promise.resolve({ kind: "failed" }), RESULT)).toBe("failed");
  expect(await finishRun(Promise.resolve({ kind: "name-refused" }), RESULT)).toBe("failed");
  respond = down;
  expect(await finishRun(Promise.resolve({ kind: "ok", runId: "run-1" }), RESULT)).toBe("failed");
  calls = 0;
  sent = undefined;
  expect(await finishRun(null, RESULT)).toBe("not-saved");
  expect(calls).toBe(0);
  expect(sent).toBeUndefined();
});

test("finishRun: a start refused for too many runs is 'rate-limited' and sends nothing", async () => {
  respond = () => json(200, { ok: true });
  expect(await finishRun(Promise.resolve({ kind: "rate" }), RESULT)).toBe("rate-limited");
  expect(calls).toBe(0);
});

test("fetchTop and fetchBest report a failure instead of throwing", async () => {
  respond = () => json(200, { top: [{ name: "Robo", score: 40 }] });
  expect(await fetchTop()).toEqual({ top: [{ name: "Robo", score: 40 }], me: null });
  expect(url).toBe("/api/top");
  respond = () => json(200, { best: null });
  expect(await fetchBest("player-0001")).toBeNull();
  respond = down;
  expect(await fetchTop()).toBe("failed");
  expect(await fetchBest("player-0001")).toBe("failed");
  respond = () => json(500, {});
  expect(await fetchTop()).toBe("failed");
});

test("fetchTop with a player id asks for their rank; a malformed rank is dropped and the top 10 kept", async () => {
  const top = [{ name: "Robo", score: 40 }];
  const me = { rank: 2, ranked: 9, next: { rank: 1, points: 11 }, row: 1 };
  respond = () => json(200, { top, me });
  expect(await fetchTop("player-0001")).toEqual({ top, me });
  expect(url).toBe("/api/top?player=player-0001");
  const none = { rank: null, ranked: 9, next: null, row: null };
  respond = () => json(200, { top, me: none });
  expect(await fetchTop("player-0001")).toEqual({ top, me: none });
  for (const bad of [undefined, null, "2", { ...me, rank: "2" }, { ...me, next: { rank: 1 } }, { ...me, row: -1 }, { ...me, ranked: undefined }]) {
    respond = () => json(200, { top, me: bad });
    expect(await fetchTop("player-0001")).toEqual({ top, me: null });
  }
  respond = down;
  expect(await fetchTop("player-0001")).toBe("failed");
});
