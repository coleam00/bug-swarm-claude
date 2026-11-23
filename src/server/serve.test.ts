// The shutdown a SIGTERM or SIGINT runs (main.ts), with fakes for the server, database, timer and exit.
import { expect, test } from "bun:test";
import { DT, WAVE_S } from "../shared/arena/constants";
import { SHUTDOWN_MESSAGE, START_LEAD_S, buildIdFrom, gracefulShutdown, onShutdownMessage, startTickFrom, startupFrom, type ShutdownDeps } from "./serve";

function fakes(stop: () => Promise<number>) {
  const calls: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const deps: ShutdownDeps = {
    stop: () => {
      calls.push("stop");
      return stop();
    },
    closeDb: () => void calls.push("closeDb"),
    exit: (code) => void calls.push(`exit ${code}`),
    log: (line) => void calls.push(line),
    budgetMs: 4500,
    setTimer: (fn, ms) => void timers.push({ fn, ms }),
  };
  return { calls, timers, deps };
}

test("a signal stops the server (saving its lives), closes the database, then exits 0", async () => {
  const { calls, timers, deps } = fakes(async () => 3);
  await gracefulShutdown(deps)("SIGTERM");
  expect(calls).toEqual(["stop", "closeDb", "shutdown (SIGTERM): 3 lives ended", "exit 0"]);
  expect(timers.map((t) => t.ms)).toEqual([4500]);
});

test("a stop that never finishes still exits by the budget", async () => {
  const { calls, timers, deps } = fakes(() => new Promise<number>(() => {}));
  void gracefulShutdown(deps)("SIGINT");
  await Bun.sleep(0);
  expect(calls).toEqual(["stop"]);
  timers[0]!.fn();
  expect(calls.at(-1)).toBe("exit 1");
});

test("a second signal while stopping does nothing", async () => {
  const { calls, timers, deps } = fakes(async () => 1);
  const shutdown = gracefulShutdown(deps);
  await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
  expect(calls).toEqual(["stop", "closeDb", "shutdown (SIGTERM): 1 life ended", "exit 0"]);
  expect(timers.length).toBe(1);
});

test("a failed stop is logged and exits 1", async () => {
  const { calls, deps } = fakes(async () => {
    throw new Error("boom");
  });
  await gracefulShutdown(deps)("SIGTERM");
  expect(calls).toEqual(["stop", "shutdown (SIGTERM): failed: Error: boom", "exit 1"]);
});

test("the IPC shutdown message runs the shutdown once per message; any other message does nothing (#95)", () => {
  let listener: ((m: unknown) => void) | null = null;
  const why: string[] = [];
  onShutdownMessage({ on: (_e, l) => (listener = l) }, (w) => why.push(w));
  for (const m of ["hello", { t: SHUTDOWN_MESSAGE }, 1, null]) listener!(m);
  expect(why).toEqual([]);
  listener!(SHUTDOWN_MESSAGE);
  expect(why).toEqual(["ipc"]);
});

test("the build id is Railway's commit, else BUILD_ID, else the start time", () => {
  expect(buildIdFrom({ RAILWAY_GIT_COMMIT_SHA: "abc", BUILD_ID: "two" }, 7)).toBe("abc");
  expect(buildIdFrom({ BUILD_ID: "two" }, 7)).toBe("two");
  expect(buildIdFrom({}, 7)).toBe("7");
});

test("BUG_SWARM_START_WAVE is off unless it is a whole wave of at least 2; then arenas open 10 s before it (#85)", () => {
  for (const v of [undefined, "", " ", "1", "0", "-5", "4.5", "five", "NaN", "Infinity"]) expect(startTickFrom({ BUG_SWARM_START_WAVE: v })).toBe(0);
  expect(startTickFrom({})).toBe(0);
  expect(startTickFrom({ BUG_SWARM_START_WAVE: "5" })).toBe(Math.round((4 * WAVE_S - START_LEAD_S) / DT));
  expect(startTickFrom({ BUG_SWARM_START_WAVE: "2" }) * DT).toBeCloseTo(WAVE_S - START_LEAD_S, 9);
});

test("startupFrom: production without DATA_DIR starts nothing", () => {
  for (const DATA_DIR of [undefined, "", "  "]) {
    const s = startupFrom({ NODE_ENV: "production", DATA_DIR, ADMIN_TOKEN: "a-token-of-at-least-16" }, 1);
    expect(s).toEqual({ error: expect.stringContaining("DATA_DIR is not set") });
  }
});

test("startupFrom: ADMIN_TOKEN reaches the server's options, never the log lines", () => {
  const token = "a-token-of-at-least-16";
  const s = startupFrom({ NODE_ENV: "production", DATA_DIR: "/data", PORT: "8080", ADMIN_TOKEN: token, BUILD_ID: "b1" }, 1);
  if ("error" in s) throw new Error(s.error);
  expect(s.dataDir).toBe("/data");
  expect(s.options).toMatchObject({ port: 8080, hostname: "0.0.0.0", distDir: "dist", buildId: "b1", arenaStartTick: 0, adminToken: token, proxyHops: 0, allowLoad: false });
  for (const line of s.lines) expect(line).not.toContain(token);
  const off = startupFrom({}, 1);
  if ("error" in off) throw new Error(off.error);
  expect(off.dataDir).toBe("data");
  expect(off.options.adminToken).toBeNull();
});

test("startupFrom: TRUST_PROXY_HOPS and BUG_SWARM_ALLOW_LOAD reach the options; a bad value stops the start (#104)", () => {
  const s = startupFrom({ TRUST_PROXY_HOPS: "1", BUG_SWARM_ALLOW_LOAD: "1" }, 1);
  if ("error" in s) throw new Error(s.error);
  expect(s.options).toMatchObject({ proxyHops: 1, allowLoad: true });
  expect(s.lines.some((l) => l.includes("proxy hop"))).toBe(true);
  expect(s.lines.some((l) => l.includes("BUG_SWARM_ALLOW_LOAD=1"))).toBe(true);
  expect(startupFrom({ TRUST_PROXY_HOPS: "x" }, 1)).toHaveProperty("error");
  expect(startupFrom({ BUG_SWARM_ALLOW_LOAD: "yes" }, 1)).toHaveProperty("error");
});
