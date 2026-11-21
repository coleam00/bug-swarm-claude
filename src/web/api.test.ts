import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { endRun, fetchBest, fetchTop, finishRun, startRun } from "./api";
import type { RunResult } from "./game/loop";
import { REVIEW_LASER } from "../server/rules";

const realFetch = globalThis.fetch;
let respond: () => Response | Promise<Response>;
let sent: unknown;
let calls: number;
beforeEach(() => {
  sent = undefined;
  calls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls++;
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

test("startRun: a run id, a name refusal, or a failure", async () => {
  respond = () => json(200, { runId: "run-1" });
  expect(await startRun("player-0001", "Robo")).toEqual({ kind: "ok", runId: "run-1" });
  respond = () => json(400, { error: "name", reason: "blocked" });
  expect(await startRun("player-0001", "sh1t")).toEqual({ kind: "name-refused" });
  respond = () => json(400, { error: "body" });
  expect(await startRun("player-0001", "Robo")).toEqual({ kind: "failed" });
  respond = () => json(429, { error: "rate" });
  expect(await startRun("player-0001", "Robo")).toEqual({ kind: "failed" });
  respond = down;
  expect(await startRun("player-0001", "Robo")).toEqual({ kind: "failed" });
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

test("fetchTop and fetchBest report a failure instead of throwing", async () => {
  respond = () => json(200, { top: [{ name: "Robo", score: 40 }] });
  expect(await fetchTop()).toEqual([{ name: "Robo", score: 40 }]);
  respond = () => json(200, { best: null });
  expect(await fetchBest("player-0001")).toBeNull();
  respond = down;
  expect(await fetchTop()).toBe("failed");
  expect(await fetchBest("player-0001")).toBe("failed");
  respond = () => json(500, {});
  expect(await fetchTop()).toBe("failed");
});
