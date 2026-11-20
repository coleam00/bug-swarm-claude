import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { endRun, fetchBest, fetchTop, startRun } from "./api";

const realFetch = globalThis.fetch;
let respond: () => Response | Promise<Response>;
beforeEach(() => {
  globalThis.fetch = (async () => respond()) as unknown as typeof fetch;
  spyOn(console, "error").mockImplementation(() => {}); // failures are logged; keep the output clean
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore(); // give console.error back to the test files that run after this one
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const down = () => Promise.reject(new TypeError("Failed to fetch"));
const RESULT = { score: 10, squashes: 1, seconds: 3, touch: false };

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
  respond = () => json(500, {});
  expect(await endRun("run-1", RESULT)).toBe("failed");
  respond = () => json(422, { error: "implausible" });
  expect(await endRun("run-1", RESULT)).toBe("failed");
  respond = down;
  expect(await endRun("run-1", RESULT)).toBe("failed");
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
